// Whisper transcription (port of WhisperTranscription.swift + SpeechSupport.swift).
// Apple Speech has no Windows equivalent, so on-device whisper.cpp is the only engine.
// Each retained source range is recognised in one pass: whisper keeps its own 30 s context windows
// (cutting fixed chunks lost words at every boundary), Silero VAD skips music/silence, and the
// CUDA backend is used automatically when an NVIDIA driver is present (otherwise optimized CPU code).
import { StudioError, CancellationError, uuid, analysisRanges, timecode, Subtitles, mediaList, mediaOf, mediaView, mediaName } from './model.js'
import { env, streamAudio, nodeFs as fs, nodePath as path } from './media.js'
import { separateVocals } from './separate.js'
import { fastestAdapter } from './onnx.js'

const os = (globalThis.require ?? window.require)('node:os')
const { spawn } = (globalThis.require ?? window.require)('node:child_process')

export const SpeechModels = {
  turbo: { label: '정확도 우선 · large-v3-turbo', file: 'ggml-large-v3-turbo-q5_0.bin' },
  base: { label: '속도 우선 · base', file: 'ggml-base.bin' }
}
export function defaultSpeechOptions() {
  return { model: 'turbo', whisperModelPath: '', device: 'auto', vad: true, separate: 'auto', gain: 1, hints: '', audioTrack: 0 }
}
export const amplification = o => Number.isFinite(o.gain) ? Math.min(4, Math.max(0.25, o.gain)) : 1
export function modelPath(o) {
  if (o.whisperModelPath) return o.whisperModelPath
  return path.join(env.whisperModels, (SpeechModels[o.model] ?? SpeechModels.turbo).file)
}

export function summary(report) {
  const count = report.captions.length, where = report.backend ? ` · ${report.backend}` : ''
  return report.warnings.length ? `자막 ${count}개 생성 · 검토할 구간 ${report.warnings.length}개${where}` : `자막 ${count}개 생성 완료 · 내용을 검토하세요${where}`
}

// 16 kHz mono PCM for Whisper, written incrementally; gain applies to analysis only.
export async function prepareSpeechAudio(file, destination, offset, length, options, cancellation) {
  const gain = amplification(options)
  const fd = fs.openSync(destination, 'w')
  let peak = 0, squares = 0, count = 0, clipped = 0
  try {
    fs.writeSync(fd, Buffer.alloc(44))
    await streamAudio(file, offset, length, options.audioTrack, 16000, cancellation, block => {
      const out = new Int16Array(block.length)
      for (let i = 0; i < block.length; i++) {
        const value = Number.isFinite(block[i]) ? block[i] * gain : 0
        if (Math.abs(value) > 0.98) clipped++
        const v = Math.min(0.98, Math.max(-0.98, value))
        peak = Math.max(peak, Math.abs(v)); squares += v * v
        out[i] = Math.round(v * 32767)
      }
      count += block.length
      fs.writeSync(fd, Buffer.from(out.buffer, out.byteOffset, out.byteLength))
    })
    if (!count) throw new StudioError('선택한 구간에 오디오 샘플이 없습니다.')
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + count * 2, 4); header.write('WAVE', 8); header.write('fmt ', 12)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24)
    header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(count * 2, 40)
    fs.writeSync(fd, header, 0, 44, 0)
  } finally { fs.closeSync(fd) }
  const rms = Math.sqrt(squares / count), db = v => (20 * Math.log10(Math.max(0.000001, v))).toFixed(1)
  return { seconds: count / 16000, signal: `평균 ${db(rms)} dBFS · 최대 ${db(peak)} dBFS · 과증폭 ${(100 * clipped / count).toFixed(1)}%`, silent: peak < 0.003 }
}

function accumulate(captions, offset, length, duration, report, locale) {
  const valid = captions.map(c => ({ id: uuid(), start: Math.max(offset, c.start + offset), end: Math.min(duration, offset + length, c.end + offset), text: c.text.trim() }))
    .filter(c => c.end > c.start && c.text && !/^[\s[(（]*(음악|박수|웃음|music|applause|laughter)[\])）\s]*$/i.test(c.text))
  report.captions.push(...valid)
  if (!valid.length) report.warnings.push(`${timecode(offset)}–${timecode(Math.min(duration, offset + length))}: 인식된 말소리 없음`)
  // With Korean selected, lines without any Hangul are likely misrecognitions (music, other speakers).
  if (locale.startsWith('ko')) for (const c of valid) if (!/[가-힣]/.test(c.text) && /[A-Za-z]{3,}/.test(c.text)) report.warnings.push(`${timecode(c.start)}: 한국어가 아닌 결과 — "${c.text.slice(0, 40)}" 확인 필요`)
}

export async function transcribe(project, locale, options, audioCount, cancellation, progress) {
  cancellation.check()
  const model = modelPath(options)
  if (!fs.existsSync(env.whisper)) throw new StudioError('Whisper 실행 파일을 찾지 못했습니다. 앱을 다시 설치하거나 SRT를 가져오세요.')
  if (!fs.existsSync(model)) throw new StudioError(`Whisper 모델을 찾지 못했습니다: ${path.basename(model)}\n다른 모델을 선택하거나 기본 모델로 되돌려 주세요.`)
  if (!audioCount) throw new StudioError('영상에 오디오 트랙이 없습니다. 자막을 직접 추가할 수 있습니다.')
  if (options.audioTrack >= audioCount) throw new StudioError(`선택한 오디오 트랙이 없습니다. 오디오 트랙 1부터 시험해 주세요. 이 파일의 오디오 트랙: ${audioCount}개`)
  const folder = path.join(os.tmpdir(), `veil-whisper-${uuid()}`)
  fs.mkdirSync(folder, { recursive: true })
  try {
    const ranges = analysisRanges(project)
    const total = ranges.reduce((s, r) => s + r.end - r.start, 0)
    if (!(total > 0)) throw new StudioError('자막을 생성할 영상 컷이 없습니다.')
    const report = { captions: [], warnings: [], backend: '' }
    // Music removal costs about 0.2x real time on a GPU but about 1x on a CPU, so "auto" enables it only with a GPU.
    const separate = options.separate === true || options.separate === 'on' || (options.separate === 'auto' && options.device !== 'cpu' && await fastestAdapter() >= 0)
    linkInto(folder, model, 'model.bin')
    if (options.vad && fs.existsSync(env.whisperVad)) linkInto(folder, env.whisperVad, 'vad.bin')
    let done = 0
    for (const range of ranges) {
      cancellation.check()
      const length = range.end - range.start
      progress(done / total, `음성 추출 중 · 원본 ${timecode(range.start)}–${timecode(range.end)}`)
      const audio = path.join(folder, 'audio.wav')
      let source = project.sourcePath, offset = range.start, track = options.audioTrack
      if (separate) {
        // Vocals are separated first; recognition then runs on the voice-only track.
        const vocals = path.join(folder, 'vocals.wav')
        await separateVocals(source, range.start, length, track, vocals, options.device === 'cpu' ? 'cpu' : 'gpu', cancellation,
          (v, device) => progress((done + v * length * 0.5) / total, `배경음악 분리 중 · ${device} · ${timecode(range.start + v * length)} / ${timecode(range.end)}`))
        source = vocals; offset = 0; track = 0
      }
      const prepared = await prepareSpeechAudio(source, audio, offset, length, { ...options, audioTrack: track }, cancellation)
      if (prepared.silent) { report.warnings.push(`${timecode(range.start)}–${timecode(range.end)}: 소리가 거의 없음 · ${prepared.signal}`); done += length; continue }
      const run = await recognize(folder, locale.slice(0, 2), options, prepared.seconds, cancellation,
        (v, backend) => progress((done + (separate ? 0.5 + v / 2 : v) * length) / total, `Whisper 인식 · ${backend} · ${timecode(done + v * length)} / ${timecode(total)} · ${prepared.signal}`))
      report.backend = run.backend + (separate ? ' · 배경음악 제거' : '')
      const before = report.warnings.length
      accumulate(run.captions, range.start, length, project.duration, report, locale)
      if (report.warnings.length > before && !run.captions.length) report.warnings[report.warnings.length - 1] += ` · ${prepared.signal}`
      done += length
    }
    if (!report.captions.length) throw new StudioError('Whisper에서 인식된 대사가 없습니다. 언어·오디오 트랙을 확인하고 다른 구간을 시험해 주세요.' + (separate ? '' : ' 배경음악이 크다면 배경음악 제거를 "항상 제거"로 바꿔 보세요.') + ' 기존 자막은 유지했습니다.\n' + report.warnings.slice(-6).join('\n'))
    progress(1, 'Whisper 자막 완료')
    return report
  } finally { await removeFolder(folder) }
}
// whisper may still be releasing its files right after a kill; retry instead of masking the real error.
async function removeFolder(folder) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(folder, { recursive: true, force: true }); return } catch { await new Promise(r => setTimeout(r, 150)) }
  }
}

// whisper-cli reads file names in the wrong code page, so non-ASCII paths (e.g. a Korean Windows user
// folder) fail. Everything it opens therefore lives in the work folder under ASCII names: the model is
// hard-linked there (instant, same volume) or copied as a fallback.
function linkInto(folder, source, name) {
  const target = path.join(folder, name)
  try { fs.linkSync(source, target) } catch { fs.copyFileSync(source, target) }
}

// A separate process isolates native inference failures from the editor. A failed GPU run is retried on the CPU.
async function recognize(folder, language, options, seconds, cancellation, onProgress) {
  const useGPU = options.device !== 'cpu'
  try { return await runWhisper(folder, language, options, seconds, !useGPU, cancellation, onProgress) }
  catch (e) {
    if (!useGPU || e instanceof CancellationError || cancellation.cancelled || e.timeout) throw e
    return runWhisper(folder, language, options, seconds, true, cancellation, onProgress)
  }
}
function runWhisper(folder, language, options, seconds, cpuOnly, cancellation, onProgress) {
  return new Promise((resolve, reject) => {
    fs.rmSync(path.join(folder, 'result.srt'), { force: true })
    const threads = String(Math.max(1, Math.min(8, os.cpus().length - 2)))
    const args = ['-m', 'model.bin', '-f', 'audio.wav', '-l', language, '-osrt', '-of', 'result', '-t', threads, '-pp', '-bs', '5']
    if (cpuOnly) args.push('-ng')
    if (fs.existsSync(path.join(folder, 'vad.bin'))) args.push('--vad', '-vm', 'vad.bin')
    if (options.hints.trim()) args.push('--prompt', options.hints.trim().slice(0, 500))
    const proc = spawn(env.whisper, args, { windowsHide: true, cwd: folder })
    let log = '', backend = cpuOnly ? 'CPU' : 'CPU (GPU 없음)'
    const read = d => {
      const text = String(d); log = (log + text).slice(-6000)
      if (/using CUDA\d* backend/.test(text)) backend = 'GPU (CUDA)'
      const m = /progress =\s*(\d+)%/.exec(text)
      if (m) onProgress(Math.min(0.99, +m[1] / 100), backend)
    }
    proc.stdout.on('data', read); proc.stderr.on('data', read)
    onProgress(0, cpuOnly ? 'CPU' : 'GPU 확인 중')
    // Generous limit that scales with the audio length (CPU large model ≈ 0.5× real time).
    const limit = (600 + seconds * 3) * 1000
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill() }, limit)
    const off = cancellation.onCancel(() => proc.kill())
    proc.on('error', e => { clearTimeout(timer); off(); reject(new StudioError(`Whisper를 시작하지 못했습니다: ${e.message}`)) })
    proc.on('close', code => {
      clearTimeout(timer); off()
      if (cancellation.cancelled) return reject(new CancellationError())
      if (timedOut) { const e = new StudioError(`Whisper 처리 제한 시간(${Math.round(limit / 60000)}분)을 초과했습니다. 속도 우선 모델로 시험해 주세요.`); e.timeout = true; return reject(e) }
      if (code !== 0) return reject(new StudioError('Whisper 인식기가 종료되었습니다. 선택한 모델이 whisper.cpp용 다국어 모델인지 확인하세요. 기존 편집은 유지됩니다.\n' + log.trim().split('\n').slice(-2).join('\n')))
      let captions = []
      try { captions = Subtitles.parse(fs.readFileSync(path.join(folder, 'result.srt'), 'utf8')) } catch {}
      resolve({ captions, backend })
    })
  })
}

// Every file with audio that is used on the timeline is recognised; captions stay in source time with a media tag.
export async function transcribeProject(project, locale, options, cancellation, progress) {
  const used = mediaList(project).filter(m => !m.isImage && project.clips.some(c => mediaOf(project, c) === m.id))
  const withAudio = used.filter(m => (m.audioCount ?? 1) > 0)
  if (!withAudio.length) throw new StudioError('타임라인의 영상에 오디오 트랙이 없습니다. 자막을 직접 추가할 수 있습니다.')
  const multi = !!project.media, weights = withAudio.map(m => Math.max(0.1, analysisRanges(project, m.id).reduce((s, r) => s + r.end - r.start, 0)))
  const total = weights.reduce((a, b) => a + b, 0)
  const report = { captions: [], warnings: [], backend: '' }
  let done = 0, failure = null
  for (const [i, m] of withAudio.entries()) {
    cancellation.check()
    const prefix = multi ? `[${i + 1}/${withAudio.length}] ${mediaName(m)} · ` : ''
    try {
      const r = await transcribe(mediaView(project, m), locale, options, m.audioCount ?? 1, cancellation, (v, s) => progress((done + v * weights[i]) / total, prefix + s))
      report.captions.push(...r.captions.map(c => ({ ...c, media: m.id })))
      report.warnings.push(...r.warnings.map(w => prefix + w)); report.backend = r.backend
    } catch (e) {
      if (e instanceof CancellationError || !multi) throw e
      failure = e; report.warnings.push(prefix + e.message.split('\n')[0])
    }
    done += weights[i]
  }
  if (!report.captions.length) throw failure ?? new StudioError('인식된 대사가 없습니다.')
  return report
}
