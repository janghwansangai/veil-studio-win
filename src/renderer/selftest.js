// End-to-end verification inside the real renderer (counterpart of scripts/VerifyMain.swift).
// Run with: npm run selftest  → writes a JSON report and exits with the failure count.
import * as M from './lib/model.js'
import { env, run as ffmpeg, exportMedia, load, probe, proxyPath, nodeFs as fs, nodePath as path } from './lib/media.js'
import { analyze, defaultFaceOptions } from './lib/faces.js'
import { transcribe, defaultSpeechOptions } from './lib/speech.js'
import { MaskRenderer, makeCanvas } from './lib/render.js'
import { store } from './state.js'
import { dialogs } from './lib/store.js'
import { separateVocals } from './lib/separate.js'

const { ipcRenderer } = window.require('electron')
const os = window.require('node:os')
const { execFileSync } = window.require('node:child_process')

const results = []
let assertions = 0
const logFile = () => path.join(os.tmpdir(), 'veil-selftest.log')
function log(line) { try { fs.appendFileSync(logFile(), `${new Date().toISOString().slice(11, 23)} ${line}
`) } catch {} }
function check(name, ok, detail = '') { assertions++; log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`); if (!ok) results.push({ name, detail: String(detail) }); return ok }
const near = (a, b, eps) => Math.abs(a - b) <= eps
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50) } return false }

async function pixel(file, time, x, y) {
  const out = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  return [...out.stdout.subarray(0, 3)]
}
async function imagePixel(file, x, y) {
  const bitmap = await createImageBitmap(new Blob([fs.readFileSync(file)]))
  const c = makeCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0)
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]
}
async function makeVideo(file, extra = []) {
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', ...extra,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file])
}

async function testTimelineExport(dir) {
  const source = path.join(dir, 'source.mp4'); await makeVideo(source)
  const { project: p, audioCount } = await load(source)
  check('load: size', p.width === 640 && p.height === 360, `${p.width}x${p.height}`)
  check('load: duration', near(p.duration, 2, 0.08), p.duration)
  check('load: fps', near(p.fps, 30, 0.01), p.fps)
  check('load: audio', audioCount === 1, audioCount)
  // Blue first, red second; export 0.5–1.5 like testReorderedSelectedExportPixels.
  p.clips = [{ id: M.uuid(), start: 1, end: 2 }, { id: M.uuid(), start: 0, end: 1 }]
  p.exportRange = { start: 0.5, end: 1.5 }; p.export.resolution = '원본 크기'
  p.captions = [{ id: M.uuid(), start: 0, end: 1, text: 'RED' }, { id: M.uuid(), start: 1, end: 2, text: 'BLUE' }]
  const target = path.join(dir, 'selected.mp4')
  await exportMedia(p, target, new M.Cancellation(), () => {}, { audioCount })
  const info = await probe(target)
  check('export: duration', near(info.duration, 1, 0.08), info.duration)
  check('export: audio kept', info.audioCount === 1, info.audioCount)
  const first = await pixel(target, 0.2, 200, 100), last = await pixel(target, 0.7, 200, 100)
  check('export: reordered blue first', first[2] > 190 && first[0] < 60, first)
  check('export: red second', last[0] > 190 && last[2] < 60, last)
  check('export: captions follow cuts', JSON.stringify(M.outputCaptions(p).map(c => c.text)) === '["BLUE","RED"]', M.outputCaptions(p).map(c => c.text))
  // Solid region + crop + muted + HEVC/MOV.
  const q = M.cloneProject((await load(source)).project)
  q.overlaysOnTimeline = true
  q.regions = [{ id: M.uuid(), name: 'green', enabled: true, start: 0, end: 2, rect: M.rect(0, 0, 0.5, 1), keyframes: [] }]
  q.regionDesign = { ...M.defaultDesign(), effect: '단색', shape: '사각형', red: 0, green: 1, blue: 0 }
  q.export = { ...q.export, ratio: '1:1', resolution: 'HD · 720p', muted: true, hevc: true, videoFormat: 'mov', burnCaptions: false }
  const mov = path.join(dir, 'crop.mov')
  await exportMedia(q, mov, new M.Cancellation(), () => {}, { audioCount })
  const minfo = await probe(mov)
  check('export: square crop', minfo.video?.width === 360 && minfo.video?.height === 360, `${minfo.video?.width}x${minfo.video?.height}`)
  check('export: hevc', minfo.video?.codec === 'hevc', minfo.video?.codec)
  check('export: muted', minfo.audioCount === 0, minfo.audioCount)
  const left = await pixel(mov, 0.5, 20, 180), right = await pixel(mov, 0.5, 340, 180)
  check('export: solid region left half', left[1] > 200 && left[0] < 60, left)
  check('export: unmasked right half', right[0] > 190 && right[1] < 60, right)
  // Two lanes with a gap: gap renders black, upper lane wins.
  const r = M.cloneProject((await load(source)).project)
  r.videoLaneCount = 2
  r.clips = [{ id: M.uuid(), start: 0, end: 0.5, lane: 0, position: 0 }, { id: M.uuid(), start: 1, end: 1.5, lane: 1, position: 1 }]
  const layered = path.join(dir, 'layers.mp4')
  await exportMedia(r, layered, new M.Cancellation(), () => {}, { audioCount })
  const gap = await pixel(layered, 0.75, 200, 100), upper = await pixel(layered, 1.25, 200, 100)
  check('layers: gap is black', gap.every(v => v < 40), gap)
  check('layers: second lane blue', upper[2] > 190, upper)
  // Cancellation leaves no partial output.
  const token = new M.Cancellation(), cancelled = path.join(dir, 'cancelled.mp4')
  const job = exportMedia(p, cancelled, token, v => { if (v > 0.1) token.cancel() }, { audioCount })
  let threw = false; try { await job } catch (e) { threw = M.isCancel(e) }
  check('export: cancellation', threw && !fs.existsSync(cancelled), threw)
  check('export: no temp files', !fs.readdirSync(dir).some(f => f.startsWith('.veil-')), fs.readdirSync(dir))
  // Portrait rotation metadata is honoured.
  const rotated = path.join(dir, 'rotated.mp4')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', source, '-c', 'copy', rotated])
  const rp = (await load(rotated)).project
  check('load: portrait rotation', rp.width === 360 && rp.height === 640, `${rp.width}x${rp.height}`)
  return { source, audioCount }
}

async function testRendererPixels() {
  const p = M.newProject(); p.width = 100; p.height = 100; p.duration = 1; p.clips = [{ id: M.uuid(), start: 0, end: 1 }]; p.overlaysOnTimeline = true
  p.regions = [{ id: M.uuid(), name: 'r', enabled: true, start: 0, end: 1, rect: M.rect(0.1, 0.1, 0.3, 0.3), keyframes: [] }]
  p.regionDesign = { ...M.defaultDesign(), effect: '단색', shape: '사각형', red: 1, green: 0, blue: 0 }
  p.export.burnCaptions = false
  const renderer = new MaskRenderer()
  const draw = (time, overlay) => { const c = makeCanvas(100, 100), ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 100, 100); renderer.renderFrame(c, c, p, time, overlay, false); return ctx }
  // Bottom-left origin: rect y=0.1..0.4 covers canvas rows 60..90.
  check('render: region visible', draw(8, 0.5).getImageData(20, 80, 1, 1).data[0] > 240)
  check('render: region y-flip', draw(8, 0.5).getImageData(20, 20, 1, 1).data[0] < 10)
  check('render: region hidden after end', draw(0.5, 2).getImageData(20, 80, 1, 1).data[0] < 10)
  // Mosaic and blur change the pixels inside the shape only.
  const img = makeCanvas(200, 200), ictx = img.getContext('2d', { willReadFrequently: true })
  for (let y = 0; y < 200; y += 2) { ictx.fillStyle = y % 4 ? '#fff' : '#000'; ictx.fillRect(0, y, 200, 2) }
  const stripes = ictx.getImageData(100, 100, 1, 1).data[0]
  p.regionDesign = { ...M.defaultDesign(), effect: '블러', shape: '타원', strength: 0.8 }
  p.regions[0].rect = M.rect(0.25, 0.25, 0.5, 0.5)
  renderer.renderFrame(img, img, p, 0, 0.5, false)
  const blurred = ictx.getImageData(100, 100, 1, 1).data[0], corner = ictx.getImageData(5, 5, 1, 1).data[0]
  check('render: blur averages stripes', blurred > 60 && blurred < 200, `${stripes}→${blurred}`)
  check('render: outside untouched', corner === 0 || corner === 255, corner)
  // Caption burn-in draws light text on a dark box near the bottom.
  const cap = M.newProject(); cap.width = 400; cap.height = 200; cap.duration = 1; cap.overlaysOnTimeline = true
  cap.captions = [{ id: M.uuid(), start: 0, end: 1, text: '안녕하세요 자막 테스트' }]
  const cc = makeCanvas(400, 200), cctx = cc.getContext('2d', { willReadFrequently: true }); cctx.fillStyle = '#808080'; cctx.fillRect(0, 0, 400, 200)
  renderer.renderFrame(cc, cc, cap, 0.5, 0.5, false)
  const row = cctx.getImageData(0, 175, 400, 1).data
  let dark = 0, bright = 0; for (let i = 0; i < row.length; i += 4) { if (row[i] < 60) dark++; if (row[i] > 230) bright++ }
  check('render: caption box', dark > 100, dark)
  const band = cctx.getImageData(40, 160, 320, 30).data
  let white = 0; for (let i = 0; i < band.length; i += 4) if (band[i] > 230) white++
  check('render: caption text', white > 30, white)
}

async function testFaces(dir) {
  // Face thumbnails saved by the macOS app double as real-face fixtures.
  const folder = [process.env.VEIL_FIXTURES, path.join(env.root, '..', 'mask_child_mac', 'output')].find(f => f && fs.existsSync(f))
  const file = folder && fs.readdirSync(folder).find(f => f.endsWith('.veilproject'))
  if (!file) { check('faces: fixture available', false, 'no macOS project with thumbnails'); return }
  const mac = M.decodeProject(fs.readFileSync(path.join(folder, file), 'utf8'))
  const thumbs = mac.faces.filter(f => f.thumbnail).slice(0, 3)
  const canvas = makeCanvas(1200, 700), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#6d7480'; ctx.fillRect(0, 0, 1200, 700)
  const boxes = []
  for (const [i, f] of thumbs.entries()) {
    const bmp = await createImageBitmap(new Blob([Buffer.from(f.thumbnail, 'base64')]))
    const x = 80 + i * 380, y = 180, w = 300, h = Math.round(300 * bmp.height / bmp.width)
    ctx.drawImage(bmp, x, y, w, h); boxes.push({ x, y, w, h })
  }
  const png = path.join(dir, 'faces.png')
  fs.writeFileSync(png, Buffer.from(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer()))
  const { project } = await load(png)
  check('faces: image load', project.isImage && project.width === 1200 && project.height === 700, `${project.width}x${project.height}`)
  const t0 = performance.now()
  const faces = await analyze(project, new M.Cancellation(), () => {})
  check('faces: detected', faces.length >= Math.min(2, thumbs.length), `${faces.length} of ${thumbs.length} (${Math.round(performance.now() - t0)} ms)`)
  check('faces: thumbnails', faces.every(f => typeof f.thumbnail === 'string' && f.thumbnail.length > 100))
  if (!faces.length) return
  project.faces = faces; project.maskApplied = true
  project.faceDesign = { ...M.defaultDesign(), effect: '단색', shape: '사각형', red: 1, green: 0, blue: 1, margin: 0 }
  const out = path.join(dir, 'faces_masked.png')
  project.export.resolution = '원본 크기'
  await exportMedia(project, out, new M.Cancellation(), () => {})
  const f = faces[0].samples[0].rect
  const cx = Math.round((f.x + f.width / 2) * 1200), cy = Math.round((1 - f.y - f.height / 2) * 700)
  const px = await imagePixel(out, cx, cy)
  check('faces: masked pixel', px[0] > 240 && px[1] < 20 && px[2] > 240, px)
  check('faces: face lies on a fixture', boxes.some(b => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h), `${cx},${cy}`)
  const jpg = path.join(dir, 'faces_masked.tiff'); project.export.imageFormat = 'tiff'
  await exportMedia(project, jpg, new M.Cancellation(), () => {})
  check('image: tiff export', (await probe(jpg)).video?.codec === 'tiff', (await probe(jpg)).video?.codec)
  // Moving face through a short video (testMovingFaceIsMaskedThroughoutVideo).
  const video = path.join(dir, 'moving.mp4')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', png, '-t', '1.5', '-vf', "crop=900:700:'t*150':0,scale=900:700,format=yuv420p", '-c:v', 'libx264', video])
  const vp = (await load(video)).project
  const vf = await analyze(vp, new M.Cancellation(), () => {})
  const frames = vf.reduce((n, f) => n + f.samples.length, 0)
  check('faces: tracked through video', vf.length >= 1 && frames >= 30, `${vf.length} tracks / ${frames} samples`)
  check('faces: track continuity', vf.length <= thumbs.length + 2, vf.map(f => f.samples.length))
}

async function testWhisper(dir, source, audioCount) {
  const wav = path.join(dir, 'speech.wav')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('Hello world. This is a privacy video editor test.'); $s.Dispose()`], { windowsHide: true, timeout: 60000 })
  } catch { check('whisper: TTS fixture', false, 'System.Speech unavailable'); return }
  const video = path.join(dir, 'speech.mp4')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30', '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
  const { project, audioCount: count } = await load(video)
  const report = await transcribe(project, 'en-US', defaultSpeechOptions(), count, new M.Cancellation(), () => {})
  const text = report.captions.map(c => c.text).join(' ').toLowerCase()
  check('whisper: recognised speech', /hello/.test(text) && /(privacy|video|editor|test)/.test(text), text)
  check('whisper: caption timing', report.captions.every(c => c.start >= 0 && c.end <= project.duration + 0.01 && c.end > c.start), JSON.stringify(report.captions))
  log(`whisper backend: ${report.backend}`)
  // Korean speech under background music, starting after 6 s of music only (the reported "English output" case).
  const ref = '안녕하세요. 오늘은 아이들과 함께 공원에 다녀왔습니다. 날씨가 정말 좋아서 모두 즐겁게 뛰어놀았어요. 다음 주에는 박물관에 가 볼 계획입니다.'
  const kwav = path.join(dir, 'ko.wav'), kvideo = path.join(dir, 'ko.mp4')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } | Select-Object -First 1; if (-not $v) { exit 3 }; $s.SelectVoice($v.VoiceInfo.Name); $s.SetOutputToWaveFile('${kwav}'); $s.Speak('${ref}'); $s.Dispose()`], { windowsHide: true, timeout: 60000 })
  } catch { log('whisper: Korean voice not installed, Korean check skipped'); return }
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=26', '-f', 'lavfi', '-i', 'sine=f=196:d=26,volume=0.25', '-f', 'lavfi', '-i', 'sine=f=247:d=26,volume=0.2', '-i', kwav,
    '-filter_complex', '[3]adelay=6000|6000,apad[s];[1][2][s]amix=inputs=3:normalize=0:duration=first,tremolo=f=2:d=0.5[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', kvideo])
  const ko = await load(kvideo)
  const t = performance.now()
  const kr = await transcribe(ko.project, 'ko-KR', defaultSpeechOptions(), ko.audioCount, new M.Cancellation(), () => {})
  const heard = kr.captions.map(c => c.text).join(' ')
  const norm = s => s.replace(/[^가-힣a-zA-Z0-9]/g, '')
  const a = norm(ref), b = norm(heard), dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) { let prev = dp[0]; dp[0] = i; for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp } }
  const cer = dp[b.length] / a.length
  log(`whisper ko: ${((performance.now() - t) / 1000).toFixed(1)}s, CER ${(cer * 100).toFixed(1)}%, ${kr.backend}: ${heard}`)
  check('whisper: Korean stays Korean under music', /[가-힣]/.test(heard) && !/[A-Za-z]{4,}/.test(heard), heard)
  check('whisper: Korean accuracy', cer < 0.1, `${(cer * 100).toFixed(1)}% ${heard}`)
  check('whisper: no captions during music intro', kr.captions.every(c => c.start >= 5), JSON.stringify(kr.captions.slice(0, 2)))
}

async function testStore(dir, source) {
  const s = store
  s.automaticRecoveryEnabled = false
  await s.load(source)
  check('store: loaded', s.loaded && s.project.clips.length === 1, s.status)
  check('store: preview ready', await until(() => s.previewReady), s.status)
  s.seek(1.5); await sleep(300)
  check('store: source playhead', near(s.sourcePlayhead, 1.5, 0.001), s.sourcePlayhead)
  s.split(); check('store: split', s.project.clips.length === 2)
  s.selectClip(s.project.clips[1].id); s.copyClips(); s.deleteClip()
  check('store: ripple delete', near(s.editedDuration, 1.5, 0.001), s.editedDuration)
  s.seek(0); s.pasteClips(); check('store: paste', near(s.editedDuration, 2, 0.001), s.editedDuration)
  s.undo(); check('store: undo', near(s.editedDuration, 1.5, 0.001), s.editedDuration)
  s.redo(); check('store: redo', near(s.editedDuration, 2, 0.001), s.editedDuration)
  s.addCaption(); s.addRegion(M.rect(0.1, 0.1, 0.2, 0.2))
  const cid = s.project.captions[0].id, rid = s.project.regions[0].id
  s.beginTimelineGesture()
  s.editOverlayTime(rid, true, { start: 0, end: 2 }, 0.3, -1); s.editOverlayTime(rid, true, { start: 0, end: 2 }, 0.5, -1)
  const undoBefore = s.undoStack.length; s.endTimelineGesture()
  check('store: gesture is one undo step', s.undoStack.length === undoBefore + 1 && near(s.project.regions[0].start, 0.5, 0.001), `${undoBefore}→${s.undoStack.length}`)
  const clipsBefore = s.project.clips.length
  s.selectOverlay(cid, false); s.seek(1); s.split()
  check('store: overlay split keeps clips', s.project.captions.length === 2 && s.project.clips.length === clipsBefore, `${s.project.captions.length} captions, ${clipsBefore}→${s.project.clips.length} clips`)
  s.addLane('video'); check('store: add video lane', s.laneCount('video') === 2 && s.timelineRows.length === 6 + s.laneCount('regions') + s.laneCount('captions'))
  s.moveItem(s.project.clips[0].id, 'video', 1, 3)
  check('store: move to lane', s.project.clips.some(c => c.lane === 1 && near(c.position, 3, 0.001)) && s.project.videoLaneCount >= 2)
  const gaps = M.gaps(s.project, 1)
  if (gaps.length) { s.closeGap(gaps[0], 1); check('store: close gap', M.gaps(s.project, 1).length === 0, JSON.stringify(M.gaps(s.project, 1))) }
  const file = path.join(dir, 'roundtrip.veilproject')
  check('store: save', s.save(file) && !s.hasUnsavedChanges)
  const reopened = M.decodeProject(fs.readFileSync(file, 'utf8')); M.validate(reopened)
  check('store: roundtrip', M.projectsEqual(reopened, s.project), 'differs')
  check('store: refuse source overwrite', !s.save(source) && /원본/.test(s.error ?? ''), s.error); s.error = null
  await until(() => s.waveform?.hasAudio, 15000)
  check('store: waveform', s.waveform?.hasAudio && s.waveform.peak(0.2, 0.8) > 0.1, s.waveformStatus)
  s.tab = 'captions'; s.changed(); await sleep(400)
  const shot = path.join(os.tmpdir(), 'veil-selftest-ui.png')
  await ipcRenderer.invoke('app:capture', shot)
  s.savedProject = s.project
}

const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)))
function pointer(el, type, x, y, extra = {}) { (type === 'pointerdown' ? el : window).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1, ...extra })) }
async function drag(el, from, to, steps = 4) {
  pointer(el, 'pointerdown', from.x, from.y)
  for (let i = 1; i <= steps; i++) { pointer(el, 'pointermove', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await frame() }
  pointer(el, 'pointerup', to.x, to.y); await frame()
}
const center = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, b } }

async function testUI(source) {
  const s = store
  s.savedProject = s.project; await s.load(source)
  check('ui: reload', await until(() => s.previewReady && s.project.clips.length === 1), s.status)
  s.tab = 'faces'; s.changed(); await frame(); await frame()
  const ruler = document.querySelector('.ruler'), rb = ruler.getBoundingClientRect()
  pointer(ruler, 'pointerdown', rb.left + rb.width * 0.5, rb.top + 30); pointer(ruler, 'pointerup', rb.left + rb.width * 0.5, rb.top + 30)
  check('ui: ruler click seeks', near(s.playhead, 1, 0.03), s.playhead)
  ruler.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
  check('ui: ruler wheel', near(s.playhead, 1.25, 0.01), s.playhead)
  await sleep(300)
  const preview = document.querySelector('.preview-box canvas')
  try {
    const d = preview.getContext('2d').getImageData(Math.floor(preview.width / 2), Math.floor(preview.height / 2), 1, 1).data
    check('ui: preview shows source frame', d[2] > 180 && d[0] < 60, [...d])
  } catch (e) { check('ui: preview readable', false, e.message) }
  s.seek(1)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })); await frame()
  check('ui: Ctrl+B splits', s.project.clips.length === 2, s.project.clips.length)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); await frame()
  check('ui: Ctrl+Z undoes', s.project.clips.length === 1, s.project.clips.length)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
  s.seek(1.5); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true })); await frame()
  check('ui: I/O marks range', near(s.project.exportRange?.start ?? -1, 1, 0.001) && near(s.project.exportRange?.end ?? -1, 1.5, 0.001), JSON.stringify(s.project.exportRange))
  s.clearExportRange()
  // Playback across the whole edited timeline.
  s.seek(0); s.togglePlay(); await sleep(700)
  check('ui: playback advances', s.playing && s.playhead > 0.35, `${s.playing} ${s.playhead}`)
  check('ui: playback stops at end', await until(() => !s.playing, 4000) && near(s.playhead, 2, 0.02), s.playhead)
  // Playback crosses a reordered cut boundary (source jumps backwards).
  s.edit(p => { p.clips = [{ id: M.uuid(), start: 1, end: 2 }, { id: M.uuid(), start: 0, end: 1 }] }); s.seek(0.8); s.togglePlay(); await sleep(600)
  check('ui: playback crosses cuts', s.playing && s.playhead > 1.1 && near(s.sourcePlayhead, s.playhead - 1, 0.01), `${s.playhead} → src ${s.sourcePlayhead} / video ${s.video.currentTime}`)
  s.pause(); await frame()
  // Trim the first clip with its left handle.
  await frame()
  const cell = document.querySelector('.clip-cell'), handle = cell.querySelector('.trim'), hc = center(handle), pps = rb.width / s.editedDuration
  const firstStart = s.project.clips[0].start
  await drag(handle, hc, { x: hc.x + pps * 0.25, y: hc.y })
  check('ui: trim handle', near(s.project.clips[0].start, firstStart + 0.25, 0.04), s.project.clips[0].start)
  check('ui: trim is one undo step', s.undoStack.length > 0)
  // Drag a clip onto a new empty lane.
  s.addLane('video'); await frame(); await frame()
  const lane = document.querySelector('.lane[data-lane-kind="video"][data-lane="1"]'), clipEl = document.querySelector('.clip-cell[data-clip-id]')
  const lb = lane.getBoundingClientRect(), cc = center(clipEl), moved = clipEl.dataset.clipId
  await drag(clipEl, cc, { x: lb.left + lb.width * 0.6, y: lb.top + 12 })
  check('ui: drag clip to lane', s.project.clips.find(c => c.id === moved)?.lane === 1, JSON.stringify(s.project.clips))
  // Caption block: move by dragging the middle.
  s.tab = 'captions'; s.seek(0.2); s.addCaption(); await frame(); await frame()
  const block = document.querySelector('.overlay-block.caption .mid'), bc = center(block), before = s.project.captions[0].start, undo = s.undoStack.length
  // The caption ends at the timeline end, so (as on macOS) it can only move earlier.
  await drag(block, bc, { x: bc.x - pps * 0.1, y: bc.y })
  check('ui: caption drag moves', near(s.project.captions[0].start, before - 0.1, 0.03), `${before} → ${s.project.captions[0].start}`)
  check('ui: caption drag one undo', s.undoStack.length === undo + 1, `${undo}→${s.undoStack.length}`)
  // Region drawing and move on the preview.
  s.tab = 'regions'; s.drawMode = true; s.changed(); await frame(); await frame()
  const surface = document.querySelector('.draw-surface'), sb = surface.getBoundingClientRect()
  await drag(surface, { x: sb.left + sb.width * 0.1, y: sb.top + sb.height * 0.1 }, { x: sb.left + sb.width * 0.4, y: sb.top + sb.height * 0.5 })
  const region = s.project.regions[0]
  check('ui: draw region', region && near(region.rect.x, 0.1, 0.02) && near(region.rect.y, 0.5, 0.02) && near(region.rect.width, 0.3, 0.02), JSON.stringify(region?.rect))
  s.seek(0.5); await frame(); await frame()
  const box = document.querySelector('.region-box')
  if (check('ui: region handles shown', !!box)) {
    const rc = center(box)
    await drag(box, rc, { x: rc.x + sb.width * 0.2, y: rc.y })
    check('ui: region drag moves', near(s.project.regions[0].rect.x, 0.3, 0.02), s.project.regions[0].rect.x)
  }
  // Every view renders without throwing.
  for (const tab of ['faces', 'regions', 'captions']) { s.tab = tab; s.changed(); await frame() }
  s.exportSheet = true; s.changed(); await frame()
  check('ui: export sheet', !!document.querySelector('.sheet'))
  s.exportSheet = false; s.helpSheet = true; s.changed(); await frame()
  check('ui: help sheet', document.querySelectorAll('.help-item').length === 8)
  s.helpSheet = false; s.changed(); await frame()
  s.savedProject = s.project
  for (const tab of ['faces', 'captions']) {
    s.tab = tab; s.changed(); await frame(); await frame()
    document.querySelectorAll('.library details').forEach(d => { d.open = true })
    await sleep(200); await ipcRenderer.invoke('app:capture', path.join(os.tmpdir(), `veil-selftest-${tab}.png`))
  }
  // ProRes is not playable by Chromium: the preview must fall back to a local H.264 proxy.
  const prores = path.join(path.dirname(source), 'prores.mov')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', prores])
  await s.load(prores)
  check('ui: prores preview via proxy', await until(() => s.previewReady, 30000) && fs.existsSync(proxyPath(M.mediaList(s.project)[0])), s.status)
  s.seek(1.5); await sleep(400)
  try {
    const d = document.querySelector('.preview-box canvas').getContext('2d').getImageData(20, 20, 1, 1).data
    check('ui: proxy frame shown', d[2] > 150 && d[0] < 80, [...d])
  } catch (e) { check('ui: proxy frame shown', false, e.message) }
  fs.rmSync(proxyPath(M.mediaList(s.project)[0]), { force: true })
  s.savedProject = s.project
}

// ---------- multiple files, background jobs, Final Cut style editing, music removal ----------
const keydown = (key, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
function previewPixel(fx, fy) {
  const c = document.querySelector('.preview-box canvas')
  return [...c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data.slice(0, 3)]
}

async function testMultiMedia(dir, source) {
  const s = store
  s.savedProject = s.project; await s.load(source)
  check('multi: base loaded', await until(() => s.previewReady && s.project.clips.length === 1), s.status)
  const green = path.join(dir, 'green.mp4'), photo = path.join(dir, 'photo.png')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x240:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green])
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=200x400', '-frames:v', '1', photo])
  await s.addMedia([green, photo], 'append')
  const media = M.mediaList(s.project), [, gm, pm] = media
  check('multi: media added', media.length === 3 && gm && pm && pm.isImage, media.map(m => M.mediaName(m)))
  check('multi: clips appended', s.project.clips.length === 3 && near(s.editedDuration, 2 + 1 + 5, 0.05), `${s.project.clips.length} / ${s.editedDuration}`)
  check('multi: previews ready', await until(() => s.players.get(gm.id)?.ready && s.stills.has(pm.id), 20000))
  s.seek(2.5); await sleep(500)
  try {
    const mid = previewPixel(0.5, 0.5), side = previewPixel(0.03, 0.5)
    check('multi: preview shows second file', mid[1] > 180 && mid[0] < 80, mid)
    check('multi: preview letterboxed', side.every(v => v < 40), side)
  } catch (e) { check('multi: preview readable', false, e.message) }
  s.seek(5); await sleep(300)
  try { const y = previewPixel(0.5, 0.5); check('multi: preview shows photo', y[0] > 180 && y[1] > 180 && y[2] < 80, y) } catch (e) { check('multi: photo preview', false, e.message) }
  // Worker export of the joined timeline (the dialog is answered by the test).
  const out = path.join(dir, 'joined.mp4'), save = dialogs.save
  dialogs.save = async () => out
  try { s.edit(p => { p.export.resolution = '원본 크기' }); await s.exportMedia() } finally { dialogs.save = save }
  check('multi: worker export finished', s.lastExport === out && !s.error, s.error)
  if (fs.existsSync(out)) {
    const info = await probe(out)
    check('multi: joined duration', near(info.duration, 8, 0.1), info.duration)
    check('multi: joined keeps audio', info.audioCount === 1, info.audioCount)
    const g = await pixel(out, 2.5, 320, 180), gSide = await pixel(out, 2.5, 20, 180), y = await pixel(out, 5, 320, 180), ySide = await pixel(out, 5, 60, 180)
    check('multi: export second file', g[1] > 180 && g[0] < 80, g)
    check('multi: export pillarbox', gSide.every(v => v < 40), gSide)
    check('multi: export photo', y[0] > 180 && y[1] > 180 && y[2] < 80, y)
    check('multi: export photo pillarbox', ySide.every(v => v < 40), ySide)
  }
  // Insert at the playhead ripples; connect puts the clip on a new upper track.
  s.seek(1); s.placeMedia(gm.id, 'insert')
  check('multi: insert ripples', near(s.editedDuration, 9, 0.05) && M.timeline(s.project).some(e => near(e.start, 1, 0.01) && e.clip.media === gm.id), s.editedDuration)
  s.undo(); check('multi: insert undo', near(s.editedDuration, 8, 0.05), s.editedDuration)
  s.seek(0.5); s.placeMedia(pm.id, 'connect')
  check('multi: connect on upper track', s.project.clips.some(c => c.lane === 1 && near(c.position, 0.5, 0.01) && c.media === pm.id), JSON.stringify(s.project.clips.map(c => [c.lane, c.position, c.media])))
  s.undo()
  // Copy / paste a clip from another file between two cuts.
  s.selectClip(s.project.clips.find(c => c.media === gm.id).id); s.copyClips(); s.seek(2); s.pasteClips()
  check('multi: paste between clips', s.project.clips.filter(c => c.media === gm.id).length === 2 && near(s.editedDuration, 9, 0.05), s.editedDuration)
  s.undo()
  const file = path.join(dir, 'multi.veilproject')
  check('multi: save', s.save(file))
  const back = M.decodeProject(fs.readFileSync(file, 'utf8')); M.validate(back)
  check('multi: roundtrip', M.projectsEqual(back, s.project) && back.media.length === 3)
  await ipcRenderer.invoke('app:capture', path.join(os.tmpdir(), 'veil-selftest-media.png'))
}

async function testEditing(dir) {
  const s = store
  s.tab = 'media'; s.changed(); await frame()
  const clips = () => s.project.clips, dur = () => s.editedDuration
  // Markers, frame step, edit points.
  s.seek(0.5); keydown('m'); await frame()
  check('fcp: M adds marker', s.project.markers?.length === 1 && near(s.project.markers[0].time, 0.5, 0.001), JSON.stringify(s.project.markers))
  s.seek(1); keydown('ArrowRight'); check('fcp: → steps one frame', near(s.playhead, 1 + 1 / 30, 0.002), s.playhead)
  keydown('ArrowRight', { shiftKey: true }); check('fcp: Shift+→ steps ten frames', near(s.playhead, 1 + 11 / 30, 0.002), s.playhead)
  s.seek(0.4); keydown('ArrowDown'); check('fcp: ↓ jumps to next edit', near(s.playhead, 2, 0.002), s.playhead)
  keydown('ArrowUp'); check('fcp: ↑ jumps to previous edit', near(s.playhead, 0, 0.002), s.playhead)
  keydown('End'); check('fcp: End', near(s.playhead, dur(), 0.002), s.playhead)
  keydown('Home'); check('fcp: Home', s.playhead === 0, s.playhead)
  // J/K/L shuttle.
  keydown('l'); await sleep(400); check('fcp: L plays', s.playing && s.playhead > 0.15, s.playhead)
  keydown('k'); await frame(); check('fcp: K stops', !s.playing)
  const at = s.playhead; keydown('j'); await sleep(300); keydown('k'); await frame()
  check('fcp: J plays backwards', s.playhead < at - 0.05 && !s.playing && !s.reverseTimer, `${at} → ${s.playhead}`)
  // Trim to playhead (Alt+[ / Alt+]).
  s.selectedLane = 0; s.seek(0.5); keydown('[', { altKey: true }); await frame()
  check('fcp: Alt+[ trims start', near(clips()[0].start, 0.5, 0.002) && near(dur(), 7.5, 0.01), `${clips()[0].start} ${dur()}`)
  s.undo(); s.seek(1.5); keydown(']', { altKey: true }); await frame()
  check('fcp: Alt+] trims end', near(clips()[0].end, 1.5, 0.002) && near(dur(), 7.5, 0.01), `${clips()[0].end} ${dur()}`)
  s.undo()
  // V disables, Shift+Delete lifts leaving a gap.
  s.selectClip(clips()[1].id); keydown('v'); await frame()
  check('fcp: V disables clip', clips()[1].disabled === true)
  keydown('v'); check('fcp: V enables again', !clips()[1].disabled)
  const n = clips().length; keydown('Delete', { shiftKey: true }); await frame()
  check('fcp: Shift+Delete keeps gap', clips().length === n - 1 && near(dur(), 8, 0.01) && M.gaps(s.project, 0).length === 1, `${clips().length} ${dur()} ${JSON.stringify(M.gaps(s.project, 0))}`)
  s.undo()
  // Clip inspector attributes are exported: disabled → black, fade-in darkens the start, volume accepted.
  const p = M.cloneProject(s.project)
  p.clips[0].disabled = true; p.clips[1].fadeIn = 1; p.clips[1].volume = -6; p.export.resolution = '원본 크기'
  const out = path.join(dir, 'attrs.mp4')
  await exportMedia(p, out, new M.Cancellation(), () => {}, {})
  const off = await pixel(out, 0.5, 320, 180), early = await pixel(out, 2.08, 320, 180), late = await pixel(out, 2.9, 320, 180)
  check('fcp: disabled clip is black', off.every(v => v < 40), off)
  check('fcp: fade-in', early[1] < late[1] - 60, `${early} → ${late}`)
  // Timeline zoom widens the scroll area; snapping toggles.
  s.setZoom(4); await frame(); await frame()
  const body = document.querySelector('.tl-body'), inner = document.querySelector('.tl-scroll-inner')
  check('fcp: zoom widens timeline', body && inner && inner.scrollWidth > body.clientWidth * 3, `${inner?.scrollWidth} / ${body?.clientWidth}`)
  await ipcRenderer.invoke('app:capture', path.join(os.tmpdir(), 'veil-selftest-zoom.png'))
  s.setZoom(1); keydown('n'); check('fcp: N toggles snapping', s.snapping === false); keydown('n')
  // Clip inspector renders for the selection.
  s.selectClip(clips()[0].id); s.inspectorView = 'clip'; s.changed(); await frame()
  check('fcp: clip inspector', document.querySelectorAll('.inspector input[type=range]').length >= 5)
  s.savedProject = s.project
}

async function testJobs(dir) {
  const s = store
  // A face video long enough to observe the editor while analysis runs in a worker.
  const png = path.join(dir, 'faces.png'), video = path.join(dir, 'faces_long.mp4')
  if (!fs.existsSync(png)) { check('jobs: face fixture', false, 'faces.png missing'); return }
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', png, '-t', '6', '-vf', 'scale=1920:-2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', video])
  s.savedProject = s.project; await s.load(video)
  check('jobs: loaded', await until(() => s.previewReady), s.status)
  const auto = s.autoCaptions; s.autoCaptions = false
  const done = s.analyze()
  check('jobs: analysis is a background job', await until(() => s.jobs.running('faces').length === 1, 3000))
  await frame(); check('jobs: status bar shows job', !!document.querySelector('.job'))
  // The window keeps handling timers and edits while the worker is busy.
  let worst = 0
  for (let i = 0; i < 60; i++) { const t = performance.now(); await sleep(16); worst = Math.max(worst, performance.now() - t - 16) }
  log(`jobs: worst timer delay during analysis ${Math.round(worst)} ms`)
  check('jobs: UI stays responsive', worst < 150, `${Math.round(worst)} ms worst timer delay`)
  s.seek(2); s.split(); check('jobs: can edit during analysis', s.project.clips.length === 2)
  s.tab = 'faces'; s.changed(); await frame()
  await done
  check('jobs: faces found in worker', s.project.faces.length >= 2 && s.project.analysisComplete, `${s.project.faces.length} faces · ${s.error ?? ''}`)
  check('jobs: edit kept after analysis', s.project.clips.length === 2)
  await frame(); await frame()
  // "마스킹 적용" stays inside the face library (it once covered the top of the window).
  const apply = [...document.querySelectorAll('.library button')].find(b => /마스킹 적용/.test(b.textContent)), lib = document.querySelector('.library')
  if (check('jobs: apply button present', !!apply)) {
    const a = apply.getBoundingClientRect(), l = lib.getBoundingClientRect()
    check('jobs: apply button inside library', a.top >= l.top - 1 && a.bottom <= l.bottom + 1 && a.left >= l.left - 1, `${JSON.stringify(a)} in ${JSON.stringify(l)}`)
    apply.click(); await frame(); await frame()
    const b = apply.isConnected ? apply.getBoundingClientRect() : a
    check('jobs: apply button still in place after click', b.top >= l.top - 1 && s.project.maskApplied, JSON.stringify(b))
  }
  await ipcRenderer.invoke('app:capture', path.join(os.tmpdir(), 'veil-selftest-faces-job.png'))
  // Cancelling a job from the status bar.
  s.analyze(); await until(() => s.jobs.running('faces').length === 1, 3000); await sleep(400)
  const x = document.querySelector('.job button')
  if (x) x.click(); else s.jobs.running('faces')[0]?.cancel()
  check('jobs: cancel', await until(() => !s.jobs.running('faces').length, 10000) && s.project.faces.length >= 2, `${s.status} ${s.jobs.running('faces').length}`)
  s.error = null; s.autoCaptions = auto; s.savedProject = s.project
}

async function testSeparation(dir) {
  // Music only: the vocal model must remove most of the energy.
  const src = path.join(dir, 'music.mp4')
  const music = '0.15*(sin(2*PI*220*t)+sin(2*PI*277*t)+sin(2*PI*330*t))*(0.6+0.4*sin(2*PI*0.5*t))+0.5*sin(2*PI*(50+100*exp(-20*mod(t,0.5)))*mod(t,0.5))*exp(-8*mod(t,0.5))'
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=8', '-f', 'lavfi', '-i', `aevalsrc='${music}':s=44100:d=8`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', src])
  const dest = path.join(dir, 'vocals.wav'), t = performance.now()
  const r = await separateVocals(src, 0, 8, 0, dest, 'gpu', new M.Cancellation(), () => {})
  const rms = buf => { let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i]; return Math.sqrt(e / Math.max(1, buf.length)) }
  const wav = fs.readFileSync(dest), vocals = new Float32Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length))
  const mix = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'])
  const input = new Float32Array(mix.stdout.buffer.slice(mix.stdout.byteOffset, mix.stdout.byteOffset + mix.stdout.length))
  log(`separation: ${r.device} ${((performance.now() - t) / 1000).toFixed(1)}s, rms ${rms(input).toFixed(3)} → ${rms(vocals).toFixed(3)}`)
  check('separation: length', near(r.samples / 44100, 8, 0.1), r.samples)
  check('separation: music removed', rms(vocals) < rms(input) * 0.3, `${rms(input)} → ${rms(vocals)}`)
}


async function benchSeparation(dir) {
  const ref = '안녕하세요. 오늘은 아이들과 함께 공원에 다녀왔습니다. 날씨가 정말 좋아서 모두 즐겁게 뛰어놀았어요. 점심으로는 김밥과 과일을 먹었고, 오후에는 자전거를 탔습니다. 다음 주에는 국립중앙박물관에 가 볼 계획입니다.'
  const wav = path.join(dir, 'sep_speech.wav')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } | Select-Object -First 1; if (-not $v) { exit 3 }; $s.SelectVoice($v.VoiceInfo.Name); $s.SetOutputToWaveFile('${wav}'); $s.Speak('${ref}'); $s.Dispose()`], { windowsHide: true, timeout: 60000 })
  } catch { log('bench: separation skipped (no Korean voice)'); return }
  const music = "0.10*(sin(2*PI*220*t)+0.5*sin(2*PI*440*t)+sin(2*PI*277*t)+0.5*sin(2*PI*554*t)+sin(2*PI*330*t))*(0.6+0.4*sin(2*PI*0.5*t))+0.6*sin(2*PI*(50+100*exp(-20*mod(t,0.5)))*mod(t,0.5))*exp(-8*mod(t,0.5))+0.12*(random(0)*2-1)*exp(-40*mod(t+0.25,0.5))+0.18*sin(2*PI*(392+98*floor(mod(t*2,4)))*t)*(0.5+0.5*sin(2*PI*2*t))"
  const norm = s => s.replace(/[^가-힣a-zA-Z0-9]/g, '')
  const cer = heard => { const a = norm(ref), b = norm(heard), dp = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = dp[0]; dp[0] = i; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t } } return dp[b.length] / a.length }
  for (const gain of (process.env.VEIL_GAINS ?? '1,2.5,4').split(',').map(Number)) {
    const video = path.join(dir, `sep_${gain}.mp4`)
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=26', '-f', 'lavfi', '-i', `aevalsrc='${music}':s=44100:d=26`, '-i', wav,
      '-filter_complex', `[1]volume=${gain}[m];[2]adelay=3000|3000,apad[s];[m][s]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', video])
    const { project, audioCount } = await load(video)
    for (const [label, opts] of JSON.parse(process.env.VEIL_SEP_CASES ?? '[["turbo",{}],["turbo+분리",{"separate":true}],["base",{"model":"base"}],["base+분리",{"model":"base","separate":true}]]')) {
      const t = performance.now()
      const r = await transcribe(project, 'ko-KR', { ...defaultSpeechOptions(), ...opts }, audioCount, new M.Cancellation(), () => {})
        .catch(e => ({ captions: [], backend: 'ERR ' + e.message.split('\n')[0] }))
      const heard = r.captions.map(c => c.text).join(' ')
      log(`bench: music x${gain} ${label.padEnd(9)} ${((performance.now() - t) / 1000).toFixed(1)}s CER ${(cer(heard) * 100).toFixed(1)}% ${r.backend} | ${heard.slice(0, 50)}`)
    }
  }
}

async function bench(dir) {
  if (process.env.VEIL_BENCH === 'separation') return benchSeparation(dir)
  const src = path.join(dir, 'bench.mp4')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=10', '-f', 'lavfi', '-i', 'sine=d=10', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
  const { project: p, audioCount } = await load(src)
  p.overlaysOnTimeline = true
  p.regions = [{ id: M.uuid(), name: 'b', enabled: true, start: 0, end: 10, rect: M.rect(0.3, 0.3, 0.3, 0.3), keyframes: [] }]
  p.regionDesign = { ...M.defaultDesign(), effect: '블러' }
  p.captions = [{ id: M.uuid(), start: 0, end: 10, text: '성능 측정용 자막입니다' }]
  let t = performance.now()
  for (const [label, edit] of [['blur+caption all frames', q => q], ['captions off, region 3s of 10s', q => { q.captions = []; q.regions[0].end = 3; return q }], ['HEVC blur all frames', q => { q.export = { ...q.export, hevc: true }; return q }], ['3 small mosaics + caption (typical faces)', q => { q.regionDesign = { ...M.defaultDesign(), effect: '모자이크' }; q.regions = [0.1, 0.4, 0.7].map(x => ({ id: M.uuid(), name: 'f', enabled: true, start: 0, end: 10, rect: M.rect(x, 0.5, 0.08, 0.14), keyframes: [] })); return q }]]) {
    const stats = {}; t = performance.now()
    await exportMedia(edit(M.cloneProject(p)), path.join(dir, 'bench_out.mp4'), new M.Cancellation(), () => {}, { audioCount, stats })
    const sec = (performance.now() - t) / 1000
    log(`bench: export 1080p30 10s ${label}: ${sec.toFixed(1)}s (${(300 / sec).toFixed(0)} fps, rendered ${stats.rendered}/${stats.frames}, ${stats.encoder})`)
  }
  // Small-face recall: every face thumbnail from the macOS project pasted at 24–96 px on a 1920×1080 frame.
  const folder = [process.env.VEIL_FIXTURES, path.join(env.root, '..', 'mask_child_mac', 'output')].find(f => f && fs.existsSync(f))
  const macFile = folder && fs.readdirSync(folder).find(f => f.endsWith('.veilproject'))
  if (macFile) {
    const thumbs = M.decodeProject(fs.readFileSync(path.join(folder, macFile), 'utf8')).faces.filter(f => f.thumbnail)
    const canvas = makeCanvas(1920, 1080), ctx = canvas.getContext('2d'), truth = []
    ctx.fillStyle = '#5a6270'; ctx.fillRect(0, 0, 1920, 1080)
    for (const [i, f] of thumbs.entries()) {
      const bmp = await createImageBitmap(new Blob([Buffer.from(f.thumbnail, 'base64')])), size = [24, 32, 48, 64, 96][i % 5]
      const x = 60 + (i % 8) * 230, y = 80 + Math.floor(i / 8) * 320
      ctx.drawImage(bmp, x, y, size, size * bmp.height / bmp.width); truth.push({ x, y, w: size, h: size * bmp.height / bmp.width, size })
    }
    const png = path.join(dir, 'recall.png')
    fs.writeFileSync(png, Buffer.from(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer()))
    for (const [mode, threshold] of [['fast', 0.45], ['standard', 0.45]]) {
      const found = await analyze((await load(png)).project, new M.Cancellation(), () => {}, { ...defaultFaceOptions(), mode, threshold })
      const boxes = found.map(f => f.samples[0].rect).map(r => ({ x: r.x * 1920, y: (1 - r.y - r.height) * 1080, w: r.width * 1920, h: r.height * 1080 }))
      const hit = truth.map(t => boxes.some(b => b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h))
      const bySize = [24, 32, 48, 64, 96].map(sz => `${sz}px ${truth.filter((t, i) => t.size === sz && hit[i]).length}/${truth.filter(t => t.size === sz).length}`).join(', ')
      log(`bench: image face recall ${mode} t=${threshold}: ${hit.filter(Boolean).length}/${truth.length} (${bySize}), ${boxes.length} boxes`)
    }
    const clip = path.join(dir, 'recall.mp4')
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', png, '-t', '1', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', clip])
    for (const mode of ['fast', 'standard', 'high']) {
      const tracks = await analyze((await load(clip)).project, new M.Cancellation(), () => {}, { ...defaultFaceOptions(), mode })
      const boxes = tracks.map(f => f.samples[0].rect).map(r => ({ x: r.x * 1920, y: (1 - r.y - r.height) * 1080, w: r.width * 1920, h: r.height * 1080 }))
      const hit = truth.map(t => boxes.some(b => b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h))
      const bySize = [24, 32, 48, 64, 96].map(sz => `${sz}px ${truth.filter((t, i) => t.size === sz && hit[i]).length}/${truth.filter(t => t.size === sz).length}`).join(', ')
      log(`bench: 1080p video face recall ${mode}: ${hit.filter(Boolean).length}/${truth.length} (${bySize}), ${tracks.length} tracks`)
    }
  }
  p.clips = [{ id: M.uuid(), start: 0, end: 4 }]
  for (const [mode, device] of [['fast', 'cpu'], ['standard', 'cpu'], ['high', 'cpu'], ['high', 'gpu']]) {
    t = performance.now()
    await analyze(p, new M.Cancellation(), () => {}, { ...defaultFaceOptions(), mode, device })
    log(`bench: face analysis 1080p 4s ${mode} ${device} ${((performance.now() - t) / 1000).toFixed(1)}s (${(120 / ((performance.now() - t) / 1000)).toFixed(1)} fps)`)
  }
}

export async function run() {
  const dir = path.join(os.tmpdir(), `veil-selftest-${M.uuid()}`)
  fs.mkdirSync(dir, { recursive: true })
  ipcRenderer.send('app:show')
  const started = performance.now(), sections = []
  try { fs.rmSync(logFile(), { force: true }) } catch {}
  const section = async (name, fn) => { log(`== ${name}`); const t = performance.now(); try { await fn() } catch (e) { check(`${name}: threw`, false, e.stack ?? e) } sections.push(`${name} ${Math.round(performance.now() - t)}ms`) }
  let fixture = {}
  await section('renderer', testRendererPixels)
  await section('timeline-export', async () => { fixture = await testTimelineExport(dir) })
  await section('faces', () => testFaces(dir))
  await section('whisper', () => testWhisper(dir, fixture.source, fixture.audioCount))
  await section('store', () => testStore(dir, fixture.source))
  await section('ui', () => testUI(fixture.source))
  await section('multi-media', () => testMultiMedia(dir, fixture.source))
  await section('editing', () => testEditing(dir))
  await section('jobs', () => testJobs(dir))
  await section('separation', () => testSeparation(dir))
  if (process.env.VEIL_BENCH) await section('bench', () => bench(dir))
  const report = { assertions, failures: results, sections, seconds: Math.round((performance.now() - started) / 100) / 10, ffmpeg: env.ffmpeg }
  fs.writeFileSync(path.join(os.tmpdir(), 'veil-selftest.json'), JSON.stringify(report, null, 2))
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  ipcRenderer.send('selftest:done', results.length ? 1 : 0)
}
