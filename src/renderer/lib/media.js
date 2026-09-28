// ffmpeg-based replacement for the AVFoundation/ImageIO parts of MediaEngine.swift and AudioWaveform.swift.
import {
  StudioError, CancellationError, uuid, newProject, validate, repairFaceBounds, cloneProject, projectForExport,
  visibleTimeline, editedDuration, outputSize, cropRect, resolvedImageFormat, dateFromMs, mediaById, mediaList
} from './model.js'
import { MaskRenderer, makeCanvas, canvasBlob } from './render.js'
import { matrixFor, frameBytes, blackFrame, toRGBA, fromRGBA } from './yuv.js'

const nodeRequire = globalThis.require ?? window.require
const { spawn } = nodeRequire('node:child_process')
const fs = nodeRequire('node:fs')
const path = nodeRequire('node:path')
const os = nodeRequire('node:os')
const crypto = nodeRequire('node:crypto')
const { pathToFileURL } = nodeRequire('node:url')

export const env = { ffmpeg: 'ffmpeg' }
export const fileURL = p => pathToFileURL(p).href
export const nodeFs = fs
export const nodePath = path
export const MAX_PIXELS = 120_000_000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.jfif', '.ico'])

// ---------- process helpers ----------
export function run(args, { cancellation, input, binary = env.ffmpeg, onStderr, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true })
    const out = [], err = []
    let errLength = 0
    proc.stdout.on('data', d => out.push(d))
    proc.stderr.on('data', d => { onStderr?.(d.toString()); err.push(d); errLength += d.length; while (errLength > 200000 && err.length > 1) errLength -= err.shift().length })
    const off = cancellation?.onCancel(() => proc.kill())
    proc.on('error', e => { off?.(); reject(new StudioError(`실행 파일을 시작하지 못했습니다: ${e.message}`)) })
    proc.on('close', code => {
      off?.()
      if (cancellation?.cancelled) return reject(new CancellationError())
      const result = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }
      if (code !== 0 && !allowFailure) return reject(new StudioError(lastLines(result.stderr) || `처리가 실패했습니다 (코드 ${code})`))
      resolve(result)
    })
    if (input) proc.stdin.end(input); else proc.stdin.end()
  })
}
const lastLines = s => s.trim().split(/\r?\n/).slice(-3).join('\n')

// Streams fixed-size raw frames with backpressure so long videos never sit in memory.
export async function* readFrames(args, frameBytes, cancellation) {
  const proc = spawn(env.ffmpeg, args, { windowsHide: true })
  let chunks = [], size = 0, closed = false, exit = null, wake = null, stderr = '', spawnError = null
  const signal = () => { const w = wake; wake = null; w?.() }
  proc.stdout.on('data', c => { chunks.push(c); size += c.length; if (size > frameBytes * 8) proc.stdout.pause(); signal() })
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-8000) })
  proc.on('error', e => { spawnError = e; closed = true; signal() })
  proc.on('close', code => { exit = code; closed = true; signal() })
  proc.stdin.end()
  const off = cancellation?.onCancel(() => proc.kill())
  let produced = 0
  const take = n => {
    let out
    if (chunks[0].length >= n) { out = chunks[0].subarray(0, n); chunks[0] = chunks[0].subarray(n); if (!chunks[0].length) chunks.shift() }
    else {
      out = Buffer.allocUnsafe(n); let o = 0
      while (o < n) { const c = chunks[0], k = Math.min(c.length, n - o); c.copy(out, o, 0, k); o += k; if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k) }
    }
    size -= n; return out
  }
  try {
    for (;;) {
      if (size >= frameBytes) { const f = take(frameBytes); produced++; if (size < frameBytes * 6) proc.stdout.resume(); yield f; continue }
      if (closed) break
      await new Promise(r => { wake = r })
    }
  } finally { off?.(); if (!closed) proc.kill() }
  if (cancellation?.cancelled) throw new CancellationError()
  if (spawnError) throw new StudioError(`ffmpeg를 시작하지 못했습니다: ${spawnError.message}`)
  if (exit !== 0 && produced === 0) throw new StudioError(lastLines(stderr) || '영상 프레임을 읽지 못했습니다.')
}

// ---------- probe ----------
const parseTime = s => { const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null }
export async function probe(file) {
  const { stderr } = await run(['-hide_banner', '-nostdin', '-i', file], { allowFailure: true })
  const format = /Input #0, ([^,]+(?:,[^,]+)*?), from/.exec(stderr)?.[1] ?? ''
  const durationText = /Duration: ([^,]+),/.exec(stderr)?.[1] ?? 'N/A'
  const lines = stderr.split(/\r?\n/)
  let video = null, audioCount = 0, videoCount = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/Stream #\d+:\d+.*: Audio:/.test(line)) audioCount++
    const isVideo = /Stream #\d+:\d+.*: Video:/.test(line) && !/attached pic/.test(line)
    if (isVideo) videoCount++
    if (!video && isVideo) {
      const size = /, (\d{2,5})x(\d{2,5})/.exec(line)
      const fps = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line)
      let rotation = 0
      for (let j = i + 1; j < lines.length && !/Stream #/.test(lines[j]); j++) {
        const r = /rotation of (-?[\d.]+) degrees/.exec(lines[j]); if (r) rotation = Math.round(+r[1])
      }
      video = { width: size ? +size[1] : 0, height: size ? +size[2] : 0, fps: fps ? +fps[1] : 30, rotation, codec: /Video: (\w+)/.exec(line)?.[1] ?? '' }
    }
  }
  if (/Invalid data found|No such file|could not find codec/i.test(stderr) && !video) return { ok: false, stderr }
  return { ok: !!video, format, duration: parseTime(durationText), video, videoCount, audioCount, stderr }
}

// ---------- images ----------
async function decodeWithFfmpeg(file) {
  const tmp = path.join(os.tmpdir(), `veil-img-${uuid()}.png`)
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-frames:v', '1', tmp])
    return await createImageBitmap(new Blob([fs.readFileSync(tmp)]))
  } finally { fs.rmSync(tmp, { force: true }) }
}
// Blob-backed bitmaps keep canvases untainted; Chromium applies EXIF orientation here.
export async function loadImageBitmap(file) {
  const data = fs.readFileSync(file)
  try { return await createImageBitmap(new Blob([data]), { imageOrientation: 'from-image' }) }
  catch { return decodeWithFfmpeg(file) }
}
function isAnimatedGif(file) {
  const data = fs.readFileSync(file)
  let count = 0
  for (let i = 0; i + 2 < data.length; i++) if (data[i] === 0x21 && data[i + 1] === 0xF9 && data[i + 2] === 0x04 && ++count > 1) return true
  return false
}
const isImageFormat = f => /(_pipe|image2|^gif|webp)/.test(f)

export function fileStamp(file) {
  const st = fs.statSync(file)
  if (!st.isFile()) throw new StudioError('파일이 아닙니다.')
  return { fileSize: st.size, modified: dateFromMs(st.mtimeMs) }
}

export const STILL_LENGTH = 3600
// Reads a file's properties. Still images get a long nominal duration so they can be trimmed like clips.
export async function probeMedia(file) {
  const m = { id: uuid(), path: path.resolve(file), ...fileStamp(file), isImage: false, duration: 0, width: 0, height: 0, fps: 30, audioCount: 0 }
  const info = await probe(file)
  const ext = path.extname(file).toLowerCase()
  const asImage = async () => {
    let bitmap
    try { bitmap = await loadImageBitmap(file) } catch { throw new StudioError('이미지를 읽을 수 없습니다.') }
    const w = bitmap.width, h = bitmap.height; bitmap.close()
    if (w * h > MAX_PIXELS) throw new StudioError('이미지는 최대 1억 2천만 화소까지 지원합니다. 먼저 크기를 줄여 주세요.')
    return { ...m, isImage: true, width: w, height: h, duration: STILL_LENGTH }
  }
  if (info.ok && (isImageFormat(info.format) || (IMAGE_EXTENSIONS.has(ext) && !(info.duration > 0.2)))) {
    // Tiled HEIF (most phone photos) would decode as a single tile with this ffmpeg build.
    if ((ext === '.heic' || ext === '.heif') && info.videoCount > 1) throw new StudioError('타일로 나뉜 HEIC 사진은 Windows 버전에서 직접 열 수 없습니다. 사진 앱 등에서 JPEG/PNG로 변환한 뒤 열어 주세요.')
    if (ext === '.gif' && isAnimatedGif(file)) throw new StudioError('애니메이션·다중 페이지 이미지는 현재 지원하지 않습니다. 단일 프레임 PNG/JPEG로 변환해 주세요.')
    return asImage()
  }
  if (!info.ok || !info.video) {
    if (IMAGE_EXTENSIONS.has(ext)) return asImage()
    throw new StudioError(`읽을 수 있는 영상이나 이미지가 아닙니다: ${path.basename(file)}\nMP4, MOV, MKV, JPEG, PNG 등을 사용해 주세요.`)
  }
  const v = info.video, swap = Math.abs(v.rotation) % 180 === 90
  const out = { ...m, width: swap ? v.height : v.width, height: swap ? v.width : v.height, duration: info.duration ?? 0, fps: Math.max(1, v.fps || 30), audioCount: info.audioCount }
  if (!(out.duration > 0) || !Number.isFinite(out.duration)) throw new StudioError('영상 길이를 읽을 수 없습니다.')
  // Decode one frame so unsupported codecs fail here instead of during analysis/export.
  const test = await run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { allowFailure: true })
  if (test.code !== 0) throw new StudioError(`이 영상 코덱은 디코딩할 수 없습니다: ${path.basename(file)}\nMP4(H.264) 등으로 변환해 주세요.\n` + lastLines(test.stderr))
  return out
}
// A new project from its first file: a still image opens the single-image editor (as on macOS).
export async function load(file) {
  const m = await probeMedia(file)
  const p = newProject()
  Object.assign(p, { sourcePath: m.path, fileSize: m.fileSize, modified: m.modified, isImage: m.isImage, width: m.width, height: m.height, fps: m.fps, audioCount: m.audioCount })
  if (m.isImage) return { project: p, audioCount: 0 }
  p.duration = m.duration
  p.clips = [{ id: uuid(), start: 0, end: p.duration }]
  validate(p)
  return { project: p, audioCount: m.audioCount }
}
// Still images are decoded once into an EXIF-oriented PNG (ffmpeg ignores EXIF orientation).
export function stillFramePath(m) {
  const key = crypto.createHash('sha1').update(`${m.path}|${m.fileSize}|${m.modified}`).digest('hex').slice(0, 20)
  return path.join(env.userData, 'MediaCache', `${key}.png`)
}
export async function ensureStillFrame(m) {
  const target = stillFramePath(m)
  if (fs.existsSync(target)) return target
  const bitmap = await loadImageBitmap(m.path)
  const canvas = makeCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
  const blob = await canvasBlob(canvas, 'image/png')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${uuid()}.tmp`
  fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer())); fs.renameSync(tmp, target)
  return target
}

// ---------- preview proxy ----------
// m: a media entry ({ path, fileSize, modified, duration }) or a legacy single-file project.
export function proxyPath(m) {
  const key = crypto.createHash('sha1').update(`${m.path ?? m.sourcePath}|${m.fileSize}|${m.modified}`).digest('hex').slice(0, 20)
  return path.join(env.userData, 'PreviewCache', `${key}.mp4`)
}
// Used only when Chromium cannot play the original codec; analysis and export always read the original.
export async function makeProxy(p, cancellation, progress) {
  const target = proxyPath(p)
  if (fs.existsSync(target)) return target
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target.replace(/\.mp4$/, `.${uuid()}.part.mp4`)
  const scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'"
  try {
    await run(['-hide_banner', '-nostdin', '-y', '-i', p.path ?? p.sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], {
      cancellation, onStderr: s => { const t = parseTime(/time=(\S+)/.exec(s)?.[1] ?? ''); if (t != null) progress(Math.min(0.99, t / Math.max(0.01, p.duration))) }
    })
    fs.renameSync(tmp, target)
    return target
  } finally { fs.rmSync(tmp, { force: true }) }
}

// ---------- audio ----------
function audioArgs(file, start, duration, track, rate, channels, format) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-t', String(duration), '-i', file, '-map', `0:a:${track}`, '-vn', '-ac', String(channels), '-ar', String(rate), '-f', format, 'pipe:1']
}
// Streams f32 mono samples; the callback receives Float32Array blocks.
export function streamAudio(file, start, duration, track, rate, cancellation, onSamples) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.ffmpeg, audioArgs(file, start, duration, track, rate, 1, 'f32le'), { windowsHide: true })
    let rest = Buffer.alloc(0), stderr = '', total = 0
    proc.stdout.on('data', chunk => {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const usable = data.length - (data.length % 4)
      if (usable) {
        const copy = new Float32Array(usable / 4)
        new Uint8Array(copy.buffer).set(data.subarray(0, usable))
        total += copy.length; onSamples(copy)
      }
      rest = data.subarray(usable)
    })
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    const off = cancellation?.onCancel(() => proc.kill())
    proc.on('error', e => reject(new StudioError(e.message)))
    proc.on('close', code => {
      off?.()
      if (cancellation?.cancelled) return reject(new CancellationError())
      if (code !== 0 && total === 0) return reject(new StudioError(lastLines(stderr) || '오디오를 읽지 못했습니다.'))
      resolve(total)
    })
    proc.stdin.end()
  })
}

export class AudioWaveform {
  constructor(peaks, duration, ranges, hasAudio) { this.peaks = peaks; this.duration = duration; this.ranges = ranges; this.hasAudio = hasAudio }
  peak(start, end) {
    const n = this.peaks.length
    if (!n || this.duration <= 0 || start < 0 || start >= this.duration) return 0
    const a = Math.max(0, Math.min(n - 1, Math.floor(start / this.duration * n)))
    const b = Math.max(a + 1, Math.min(n, Math.ceil(end / this.duration * n)))
    let m = 0; for (let i = a; i < b; i++) if (this.peaks[i] > m) m = this.peaks[i]
    return m
  }
  covers(requested) { return requested.every(r => this.ranges.some(x => x.start <= r.start && x.end >= r.end)) }
  static async read(file, duration, ranges, audioCount, cancellation) {
    if (!audioCount) return new AudioWaveform(new Float32Array(0), duration, ranges, false)
    const count = Math.max(1, Math.min(120_000, Math.ceil(Math.min(duration, 1200) * 100)))
    const peaks = new Float32Array(count), rate = 8000
    for (const range of ranges) {
      cancellation.check()
      let index = 0
      await streamAudio(file, range.start, range.end - range.start, 0, rate, cancellation, block => {
        for (let i = 0; i < block.length; i++, index++) {
          const time = range.start + index / rate
          if (time >= range.end || time >= duration) continue
          const v = block[i]; if (!Number.isFinite(v)) continue
          const k = Math.max(0, Math.min(count - 1, Math.floor(time / duration * count)))
          const a = Math.min(1, Math.abs(v)); if (a > peaks[k]) peaks[k] = a
        }
      })
    }
    cancellation.check()
    return new AudioWaveform(peaks, duration, ranges, true)
  }
}

// ---------- export ----------
export function rational(rate) {
  for (const [n, d] of [[24000, 1001], [30000, 1001], [60000, 1001], [120000, 1001]]) if (Math.abs(rate - n / d) < 0.005) return `${n}/${d}`
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(6)
}
const even = v => Math.max(2, Math.round(v / 2) * 2)

// Waits for pipe backpressure but never outlives the encoder process or a cancellation.
async function writeChunk(stream, data, state, cancellation) {
  const settle = () => { cancellation.check(); if (state.closed) throw new StudioError(state.message() || '인코더가 예기치 않게 종료되었습니다.') }
  settle()
  if (!stream.write(data)) {
    await new Promise(resolve => {
      const done = () => { stream.off('drain', done); stream.off('close', done); off(); resolve() }
      const off = cancellation.onCancel(done)
      stream.on('drain', done); stream.on('close', done); state.finished.then(done)
    })
    settle()
  }
}
// Windows keeps files locked until ffmpeg exits, so removal retries briefly.
async function removeFile(file) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(file, { force: true }); return } catch { await new Promise(r => setTimeout(r, 100)) }
  }
}

// Streams ffmpeg output straight into an open file, stopping after `limit` bytes.
function pipeSamples(args, fd, limit, cancellation) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.ffmpeg, args, { windowsHide: true })
    let written = 0, rest = Buffer.alloc(0)
    proc.stdout.on('data', chunk => {
      if (written >= limit) return
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const usable = Math.min(limit - written, data.length - (data.length % 4))
      if (usable > 0) { fs.writeSync(fd, data, 0, usable); written += usable }
      rest = data.subarray(usable)
      if (written >= limit) proc.kill()
    })
    proc.stderr.on('data', () => {})
    const off = cancellation.onCancel(() => proc.kill())
    proc.on('error', e => { off(); reject(new StudioError(e.message)) })
    proc.on('close', () => { off(); cancellation.cancelled ? reject(new CancellationError()) : resolve(written) })
    proc.stdin.end()
  })
}

// Builds the edited audio as raw PCM: each clip reads from its own file with its volume/fades; gaps,
// muted/disabled clips and files without audio stay silent, and every cut keeps sample-exact sync.
async function renderAudio(p, target, cancellation) {
  const rate = 48000, fd = fs.openSync(target, 'w')
  try {
    let cursor = 0
    const silence = samples => { let left = samples; const zero = Buffer.alloc(Math.min(left, rate) * 4); while (left > 0) { const n = Math.min(left, rate); fs.writeSync(fd, zero, 0, n * 4); left -= n } }
    for (const entry of visibleTimeline(p)) {
      cancellation.check()
      const a = Math.round(entry.start * rate), b = Math.round(entry.end * rate)
      if (a > cursor) silence(a - cursor)
      const want = b - Math.max(a, cursor)
      if (want <= 0) continue
      const clip = p.clips[entry.index] ?? entry.clip, media = mediaById(p, entry.clip.media)
      const skip = Math.max(0, cursor - a) / rate, s0 = entry.clip.start + skip
      let got = 0
      if (!clip.muted && !clip.disabled && !media.isImage && (media.audioCount ?? 1) > 0) {
        const gain = Math.pow(10, (clip.volume ?? 0) / 20)
        const fi = Math.max(0.001, clip.fadeIn ?? 0), fo = Math.max(0.001, clip.fadeOut ?? 0)
        const expr = `${gain.toFixed(6)}*min(1,max(0,(t+${(s0 - clip.start).toFixed(6)})/${fi.toFixed(4)}))*min(1,max(0,(${(clip.end - s0).toFixed(6)}-t)/${fo.toFixed(4)}))`
        const args = audioArgs(media.path, s0, want / rate + 0.05, 0, rate, 2, 's16le')
        args.splice(args.indexOf('-vn') + 1, 0, '-af', `volume=eval=frame:volume='${expr}'`)
        got = await pipeSamples(args, fd, want * 4, cancellation) / 4
      }
      if (got < want) silence(want - got)
      cursor = b
    }
    const end = Math.round(editedDuration(p) * rate)
    if (end > cursor) silence(end - cursor)
  } finally { fs.closeSync(fd) }
}

export async function exportMedia(project, destination, cancellation, progress, { audioCount = null, stats = null } = {}) {
  const prepared = cloneProject(project)
  repairFaceBounds(prepared); validate(prepared); cancellation.check()
  const p = projectForExport(prepared)
  const ext = path.extname(destination)
  const temporary = path.join(path.dirname(destination), `.veil-${uuid()}${ext}`)
  const scratch = []
  let encoderProcess = null, encoderExit = null
  try {
    if (p.isImage) {
      const bitmap = await loadImageBitmap(p.sourcePath)
      const frame = makeCanvas(bitmap.width, bitmap.height), fctx = frame.getContext('2d')
      fctx.drawImage(bitmap, 0, 0); bitmap.close()
      const size = outputSize(p.export, frame.width, frame.height, false)
      const out = makeCanvas(size.width, size.height)
      new MaskRenderer().renderFrame(frame, out, p, 0, 0, true)
      const format = resolvedImageFormat(p.export)
      progress(0.6, '이미지 저장 중')
      // Fresh pixels only: source EXIF/GPS metadata is deliberately omitted.
      const blob = await canvasBlob(out, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95)
      if (!blob) throw new StudioError('이미지 저장에 실패했습니다.')
      const bytes = Buffer.from(await blob.arrayBuffer())
      if (format === 'tiff') {
        const png = temporary + '.png'; scratch.push(png); fs.writeFileSync(png, bytes)
        await run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', png, '-c:v', 'tiff', '-compression_algo', 'lzw', '-f', 'image2', temporary], { cancellation })
      } else fs.writeFileSync(temporary, bytes)
    } else {
      if (!p.clips.length) throw new StudioError('내보낼 컷이 없습니다.')
      let audioFile = null
      // Any file with audio on the timeline gives the output an audio track (silent where other clips have none).
      const hasAudio = audioCount != null ? audioCount > 0 : mediaList(p).some(m => !m.isImage && (m.audioCount ?? 1) > 0)
      if (!p.export.muted && hasAudio) {
        progress(0, '오디오 구성 중')
        audioFile = temporary + '.pcm'; scratch.push(audioFile)
        await renderAudio(p, audioFile, cancellation)
      }
      const encoders = await videoEncoders(p.export.hevc)
      for (let i = 0; i < encoders.length; i++) {
        const job = encodeVideo(p, temporary, audioFile, encoders[i], cancellation, progress, stats)
        encoderProcess = job.process; encoderExit = job.exit
        try {
          await job.done
          if (stats) stats.encoder = encoders[i].name
          break
        } catch (e) {
          // A hardware encoder can fail on some drivers; retry once with the software encoder.
          if (cancellation.cancelled || e instanceof CancellationError || i === encoders.length - 1 || !encoders[i].hardware) throw e
          job.process.kill(); await job.exit; encoderExit = null
          progress(0, `${encoders[i].label} 인코더 실패 · 소프트웨어 인코더로 다시 시도`)
        }
      }
    }
    cancellation.check()
    try { fs.renameSync(temporary, destination) }
    catch (e) { throw new StudioError(`결과 파일을 저장하지 못했습니다. 같은 이름의 파일이 다른 프로그램(플레이어 등)에서 열려 있지 않은지 확인하세요.
${e.code ?? e.message}`) }
    progress(1, '내보내기 완료')
  } finally {
    if (encoderExit) { encoderProcess?.kill(); await encoderExit }
    for (const f of [temporary, ...scratch]) await removeFile(f)
  }
}

// Fade toward black in limited-range YUV (Y→16, U/V→128).
function fadeFrame(buf, W, H, f) {
  const y = W * H
  for (let i = 0; i < y; i++) buf[i] = 16 + (buf[i] - 16) * f
  for (let i = y; i < buf.length; i++) buf[i] = 128 + (buf[i] - 128) * f
}

// ---------- video encoding ----------
const SOFTWARE = {
  h264: { name: 'libx264', label: 'x264', hardware: false, args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'] },
  hevc: { name: 'libx265', label: 'x265', hardware: false, args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'] }
}
const HARDWARE = {
  h264: [
    { name: 'h264_nvenc', label: 'NVIDIA NVENC', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-spatial-aq', '1'] },
    { name: 'h264_amf', label: 'AMD AMF', args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '21'] },
    { name: 'h264_qsv', label: 'Intel Quick Sync', args: ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '20'] }
  ],
  hevc: [
    { name: 'hevc_nvenc', label: 'NVIDIA NVENC', args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-spatial-aq', '1', '-tag:v', 'hvc1'] },
    { name: 'hevc_amf', label: 'AMD AMF', args: ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '23', '-tag:v', 'hvc1'] },
    { name: 'hevc_qsv', label: 'Intel Quick Sync', args: ['-c:v', 'hevc_qsv', '-preset', 'slow', '-global_quality', '22', '-tag:v', 'hvc1'] }
  ]
}
const encoderProbe = new Map()
function encoderWorks(e) {
  if (!encoderProbe.has(e.name)) encoderProbe.set(e.name, run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2', '-pix_fmt', 'yuv420p', ...e.args, '-f', 'null', '-'], { allowFailure: true }).then(r => r.code === 0).catch(() => false))
  return encoderProbe.get(e.name)
}
// HEVC: GPU encoders are ~5× faster than x265. H.264: x264 is already fast on 8+ core CPUs, so the GPU is used only on smaller CPUs.
export async function videoEncoders(hevc) {
  const kind = hevc ? 'hevc' : 'h264', list = []
  if (env.hardwareEncoding !== false && (hevc || os.cpus().length < 8)) {
    for (const e of HARDWARE[kind]) if (await encoderWorks(e)) { list.push({ ...e, hardware: true }); break }
  }
  list.push(SOFTWARE[kind])
  return list
}

// Frames travel as YUV 4:2:0 (2.7× less data than RGBA). Only the rectangle around masks and captions is
// converted to RGBA, rendered on a small CPU canvas and written back; everything else stays bit-exact.
function encodeVideo(p, temporary, audioFile, encoder, cancellation, progress, stats) {
  const size = outputSize(p.export, p.width, p.height, true), W = size.width, H = size.height
  const crop = cropRect(p.export, p.width, p.height)
  // Crop and scale inside ffmpeg so only output-sized frames ever reach the renderer.
  const cx = Math.max(0, Math.round(crop.x)), cw = Math.max(2, Math.min(p.width - cx, Math.round(crop.width)))
  const cy = Math.max(0, Math.round(p.height - crop.y - crop.height)), ch = Math.max(2, Math.min(p.height - cy, Math.round(crop.height)))
  const s = W / cw, view = { W: p.width * s, H: p.height * s, ox: cx * s, oy: cy * s }
  const standard = matrixFor(H), colorTags = standard === 709 ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] : ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m']
  const rate = Math.min(120, p.fps)
  const total = editedDuration(p), frames = Math.max(1, Math.round(total * rate)), bytes = frameBytes(W, H)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-s', `${W}x${H}`, '-framerate', rational(rate), '-i', 'pipe:0',
    ...(audioFile ? ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k'] : ['-map', '0:v']),
    ...encoder.args, '-pix_fmt', 'yuv420p', ...colorTags, '-map_metadata', '-1', '-movflags', '+faststart', '-f', p.export.videoFormat === 'mov' ? 'mov' : 'mp4', temporary]
  const proc = spawn(env.ffmpeg, args, { windowsHide: true })
  let encoderError = ''
  const state = { closed: false, message: () => lastLines(encoderError) }
  proc.stderr.on('data', d => { encoderError = (encoderError + d).slice(-6000) })
  const exit = state.finished = new Promise(resolve => {
    proc.on('close', code => { state.closed = true; resolve(code) })
    proc.on('error', e => { encoderError += e.message; state.closed = true; resolve(-1) })
  })
  proc.stdin.on('error', () => {})
  const done = (async () => {
    const offCancel = cancellation.onCancel(() => proc.kill())
    try {
      const renderer = new MaskRenderer({ cpu: true })
      const canvas = makeCanvas(2, 2), ctx = canvas.getContext('2d', { willReadFrequently: true })
      const black = blackFrame(W, H)
      let k = 0, lastProgress = 0, rendered = 0
      const started = performance.now()
      const emit = async (buf, sourceTime, mediaId = null, fade = 1) => {
        const t = k / rate
        const regions = renderer.regions(p, sourceTime, t, W, H, view, mediaId)
        let data = buf ?? black
        if (fade < 1 && buf) fadeFrame(buf, W, H, fade)
        if (regions.length) {
          data = buf ?? Buffer.from(black)
          for (const region of regions) {
            if (canvas.width !== region.w || canvas.height !== region.h) { canvas.width = region.w; canvas.height = region.h }
            const image = ctx.createImageData(region.w, region.h)
            toRGBA(data, W, H, region.x, region.y, region.w, region.h, image.data, standard)
            const before = image.data.slice()
            ctx.putImageData(image, 0, 0)
            renderer.renderRegion(ctx, region, W, H, p, sourceTime, t, view, mediaId)
            fromRGBA(data, W, H, region.x, region.y, region.w, region.h, ctx.getImageData(0, 0, region.w, region.h).data, before, standard)
          }
          rendered++
        }
        await writeChunk(proc.stdin, data, state, cancellation)
        k++
        if (k - lastProgress >= 5) {
          lastProgress = k
          const fps = k / Math.max(0.001, (performance.now() - started) / 1000)
          progress(Math.min(0.99, k / frames), `편집 영상 내보내는 중 · ${k} / ${frames} 프레임 · ${fps.toFixed(0)} fps · ${encoder.label}`)
        }
      }
      const pw = Math.round(p.width), ph = Math.round(p.height)
      for (const entry of visibleTimeline(p)) {
        const first = Math.max(k, Math.ceil(entry.start * rate - 1e-6)), last = Math.min(frames, Math.ceil(entry.end * rate - 1e-6))
        while (k < first && k < frames) { cancellation.check(); await emit(null, -1) }
        if (last <= k) continue
        const count = last - k
        const clip = p.clips[entry.index] ?? entry.clip, media = mediaById(p, entry.clip.media)
        // A disabled clip is invisible: black frame, timeline overlays still drawn.
        if (clip.disabled) { while (k < last) { cancellation.check(); await emit(null, -1) } continue }
        const seek = entry.clip.start + (k / rate - entry.start)
        // Each file is colour-adjusted, then fitted (letterboxed) into the project frame before the project crop.
        const filters = [`fps=${rational(rate)}`]
        const b = clip.brightness ?? 0, c = clip.contrast ?? 1, sat = clip.saturation ?? 1
        if (b !== 0 || c !== 1 || sat !== 1) filters.push(`eq=brightness=${b.toFixed(3)}:contrast=${c.toFixed(3)}:saturation=${sat.toFixed(3)}`)
        if (Math.abs(media.width - p.width) >= 0.5 || Math.abs(media.height - p.height) >= 0.5) filters.push(`scale=${pw}:${ph}:force_original_aspect_ratio=decrease:flags=bicubic`, `pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:black`)
        filters.push(`crop=${cw}:${ch}:${cx}:${cy}`, `scale=${W}:${H}:flags=bicubic:out_range=tv`, 'format=yuv420p')
        const input = media.isImage
          ? ['-loop', '1', '-framerate', rational(rate), '-t', ((count + 2) / rate).toFixed(6), '-i', await ensureStillFrame(media)]
          : ['-ss', seek.toFixed(6), '-i', media.path, '-t', ((count + 2) / rate).toFixed(6)]
        const decodeArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-map', '0:v:0', '-an', '-sn', '-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']
        const fadeAt = src => Math.min(1, clip.fadeIn ? (src - clip.start) / clip.fadeIn : 1, clip.fadeOut ? (clip.end - src) / clip.fadeOut : 1)
        let used = 0, held = null
        for await (const buf of readFrames(decodeArgs, bytes, cancellation)) {
          // Keep an untouched copy near the end in case the decoder returns a frame short.
          if (used >= count - 2) held = Buffer.from(buf)
          const src = entry.clip.start + (k / rate - entry.start)
          await emit(buf, src, media.id, Math.max(0, fadeAt(src)))
          if (++used >= count) break
        }
        while (used < count) { cancellation.check(); const src = entry.clip.start + (k / rate - entry.start); await emit(held ? Buffer.from(held) : null, held ? src : -1, media.id, Math.max(0, fadeAt(src))); used++ }
      }
      while (k < frames) { cancellation.check(); await emit(null, -1) }
      proc.stdin.end()
      const code = await exit
      cancellation.check()
      if (code !== 0) throw new StudioError(`${encoder.label} 인코딩에 실패했습니다.\n` + state.message())
      if (stats) Object.assign(stats, { frames, rendered, seconds: (performance.now() - started) / 1000 })
    } catch (e) { proc.kill(); throw cancellation.cancelled ? new CancellationError() : e } finally { offCancel() }
  })()
  return { process: proc, exit, done }
}

// ---------- analysis frames ----------
export function analysisFrameArgs(file, range, fps, w, h) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', range.start.toFixed(6), '-i', file, '-t', (range.end - range.start).toFixed(6),
    '-map', '0:v:0', '-an', '-sn', '-vf', `fps=${rational(fps)},scale=${w}:${h}:flags=bilinear,format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']
}
