// Face analysis (port of MediaEngine.analyze). Vision is replaced by ONNX Runtime running
// YuNet (detector, MIT) and SFace (128-d face feature, Apache-2.0). YuNet is so small that the CPU
// (≈3 ms per 640² pass) beats a GPU round-trip; DirectML is available as an option for weak CPUs.
// The face feature only helps group candidates; it is never used as identity proof.
import { StudioError, uuid, clippedToImage, expanded, scaled, intersect, analysisRanges, timecode, mediaList, mediaOf, mediaView, mediaName } from './model.js'
import { env, readFrames, rational, loadImageBitmap, nodePath } from './media.js'
import { makeCanvas, canvasBlob } from './render.js'

import { ort, createSession, modelFile } from './onnx.js'
const S = 640, PLANE = S * S
export const FaceModes = { high: '정밀 · 작은 얼굴까지 (권장)', standard: '표준 · 더 빠름', fast: '빠름 · 가까운 큰 얼굴만' }
export const defaultFaceOptions = () => ({ mode: 'high', device: 'cpu', threshold: 0.45 })

let sessions = null, sessionKey = ''
async function prepare(device) {
  if (sessions && sessionKey === device) return sessions
  try {
    const detector = await createSession(modelFile(env.faceModels, 'face_detection_yunet_2023mar.onnx'), device)
    const recognizer = await createSession(modelFile(env.faceModels, 'face_recognition_sface_2021dec.onnx'), detector.device === 'CPU' ? 'cpu' : device)
    sessions = { detector: detector.session, recognizer: recognizer.session, device: detector.device }; sessionKey = device
    return sessions
  } catch (e) { throw new StudioError('얼굴 분석 모델을 불러오지 못했습니다: ' + e.message) }
}

// ---------- preprocessing (frame = { w, h, data, bpp: 3 (BGR) | 4 (RGBA) }) ----------
function fillTile(frame, x0, y0, out) {
  out.fill(0)
  const { w, h, data, bpp } = frame, tw = Math.min(S, w - x0), th = Math.min(S, h - y0)
  const b = bpp === 3 ? 0 : 2, r = bpp === 3 ? 2 : 0
  for (let y = 0; y < th; y++) {
    let si = ((y0 + y) * w + x0) * bpp, di = y * S
    for (let x = 0; x < tw; x++, si += bpp, di++) { out[di] = data[si + b]; out[PLANE + di] = data[si + 1]; out[2 * PLANE + di] = data[si + r] }
  }
}
// Bilinear resample of the region (x0, y0, rw, rh) by factor g into the top-left of the 640² input.
function fillScaled(frame, g, out, x0r = 0, y0r = 0, rw = frame.w, rh = frame.h) {
  out.fill(0)
  const { w, h, data, bpp } = frame, nw = Math.min(S, Math.round(rw * g)), nh = Math.min(S, Math.round(rh * g))
  const cb = bpp === 3 ? 0 : 2, cr = bpp === 3 ? 2 : 0
  if (Math.abs(g - 0.5) < 1e-9 && x0r % 1 === 0 && y0r % 1 === 0) {
    // Exact 2× reduction: 2×2 box average.
    const stride = w * bpp
    for (let y = 0; y < nh; y++) {
      let i = ((y0r + 2 * y) * w + x0r) * bpp, di = y * S
      for (let x = 0; x < nw; x++, i += 2 * bpp, di++) {
        const j = i + stride
        out[di] = (data[i + cb] + data[i + bpp + cb] + data[j + cb] + data[j + bpp + cb]) * 0.25
        out[PLANE + di] = (data[i + 1] + data[i + bpp + 1] + data[j + 1] + data[j + bpp + 1]) * 0.25
        out[2 * PLANE + di] = (data[i + cr] + data[i + bpp + cr] + data[j + cr] + data[j + bpp + cr]) * 0.25
      }
    }
    return
  }
  const X0 = new Int32Array(nw), X1 = new Int32Array(nw), WX = new Float32Array(nw)
  for (let x = 0; x < nw; x++) {
    const fx = Math.min(w - 1, Math.max(0, x0r + (x + 0.5) / g - 0.5)), x0 = Math.floor(fx)
    X0[x] = x0 * bpp; X1[x] = Math.min(w - 1, x0 + 1) * bpp; WX[x] = fx - x0
  }
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, y0r + (y + 0.5) / g - 0.5)), y0 = Math.floor(fy), wy = fy - y0, iy = 1 - wy
    const r0 = y0 * w * bpp, r1 = Math.min(h - 1, y0 + 1) * w * bpp
    for (let x = 0, di = y * S; x < nw; x++, di++) {
      const a0 = r0 + X0[x], a1 = r0 + X1[x], b0 = r1 + X0[x], b1 = r1 + X1[x], wx = WX[x], ix = 1 - wx
      const w00 = ix * iy, w01 = wx * iy, w10 = ix * wy, w11 = wx * wy
      out[di] = data[a0 + cb] * w00 + data[a1 + cb] * w01 + data[b0 + cb] * w10 + data[b1 + cb] * w11
      out[PLANE + di] = data[a0 + 1] * w00 + data[a1 + 1] * w01 + data[b0 + 1] * w10 + data[b1 + 1] * w11
      out[2 * PLANE + di] = data[a0 + cr] * w00 + data[a1 + cr] * w01 + data[b0 + cr] * w10 + data[b1 + cr] * w11
    }
  }
}

// YuNet 2023mar decoding (anchor-free, strides 8/16/32), following OpenCV's FaceDetectorYN.
function decode(outputs, threshold, map) {
  const faces = []
  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`].data, obj = outputs[`obj_${stride}`].data, bbox = outputs[`bbox_${stride}`].data, kps = outputs[`kps_${stride}`].data
    const cols = S / stride
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[idx])) * Math.min(1, Math.max(0, obj[idx])))
      if (score < threshold) continue
      const r = Math.floor(idx / cols), c = idx % cols
      const cx = (c + bbox[idx * 4]) * stride, cy = (r + bbox[idx * 4 + 1]) * stride
      const bw = Math.exp(bbox[idx * 4 + 2]) * stride, bh = Math.exp(bbox[idx * 4 + 3]) * stride
      const points = []
      for (let n = 0; n < 5; n++) points.push(map((kps[idx * 10 + 2 * n] + c) * stride, (kps[idx * 10 + 2 * n + 1] + r) * stride))
      const [x1, y1] = map(cx - bw / 2, cy - bh / 2), [x2, y2] = map(cx + bw / 2, cy + bh / 2)
      faces.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score, points })
    }
  }
  return faces
}
const pixelIoU = (a, b) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y / Math.max(1e-6, a.w * a.h + b.w * b.h - x * y)
}
function nms(faces, iou = 0.3) {
  const kept = []
  for (const f of faces.sort((a, b) => b.score - a.score)) if (!kept.some(k => pixelIoU(k, f) > iou || containedIn(f, k))) kept.push(f)
  return kept
}
// A tile can see only part of a large face; drop boxes mostly inside a stronger one.
function containedIn(f, k) {
  const x = Math.max(0, Math.min(f.x + f.w, k.x + k.w) - Math.max(f.x, k.x)), y = Math.max(0, Math.min(f.y + f.h, k.y + k.h) - Math.max(f.y, k.y))
  return x * y > 0.7 * f.w * f.h
}
const spread = (length, T) => {
  if (length <= T) return [0]
  const count = Math.ceil((length - T) / (T * 0.75)) + 1
  return [...Array(count).keys()].map(i => Math.round(i * (length - T) / (count - 1)))
}

export const mergeDetections = faces => nms(faces)

export class FaceDetector {
  constructor(options = defaultFaceOptions()) { this.options = options; this.inputs = [] }
  async init() { this.sessions = await prepare(this.options.device); return this }
  buffer(i) { return (this.inputs[i] ??= new Float32Array(3 * PLANE)) }
  run(input) {
    const d = this.sessions.detector
    return d.run({ [d.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) })
  }
  // Global pass plus overlapping native-resolution tiles for small faces. Each pass is started as soon as
  // its input is ready, so JS preprocessing overlaps with inference running on ONNX Runtime threads.
  // slot selects an independent set of input buffers so two frames can be in flight at once.
  detect(frame, slot = 0) {
    const { w, h } = frame, t = this.options.threshold, base = slot * 32
    const g = Math.min(1, S / Math.max(w, h)), jobs = []
    fillScaled(frame, g, this.buffer(base))
    jobs.push(this.run(this.buffer(base)).then(out => decode(out, t, (x, y) => [x / g, y / g])))
    if (this.options.mode !== 'fast' && (w > S || h > S)) {
      // Square windows; when the short side is only a little over 640 one row of slightly downscaled windows covers it.
      const T = Math.min(w, h) <= S * 1.25 ? Math.min(w, h) : S, k = S / T
      let i = base + 1
      for (const y0 of spread(h, T)) for (const x0 of spread(w, T)) {
        const input = this.buffer(i++)
        if (k === 1) fillTile(frame, x0, y0, input); else fillScaled(frame, k, input, x0, y0, T, T)
        const tileW = Math.min(T, w - x0), tileH = Math.min(T, h - y0)
        jobs.push(this.run(input).then(out => decode(out, t, (x, y) => [x0 + x / k, y0 + y / k]).filter(f =>
          // Faces cut by an inner tile edge are left to the tile or global pass that sees them whole.
          !((f.x - x0 < 3 && x0 > 0) || (f.y - y0 < 3 && y0 > 0) || (x0 + tileW - (f.x + f.w) < 3 && x0 + tileW < w) || (y0 + tileH - (f.y + f.h) < 3 && y0 + tileH < h)))))
      }
    }
    return Promise.all(jobs).then(all => nms(all.flat().filter(f => f.w >= 4 && f.h >= 4)))
  }
  // SFace input: 112×112 RGB aligned with a similarity transform on the 5 landmarks.
  async feature(frame, face) {
    const dst = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]
    const src = face.points
    const ms = src.reduce((a, p) => [a[0] + p[0] / 5, a[1] + p[1] / 5], [0, 0]), md = dst.reduce((a, p) => [a[0] + p[0] / 5, a[1] + p[1] / 5], [0, 0])
    let dot = 0, cross = 0, norm = 0
    for (let i = 0; i < 5; i++) {
      const px = src[i][0] - ms[0], py = src[i][1] - ms[1], qx = dst[i][0] - md[0], qy = dst[i][1] - md[1]
      dot += px * qx + py * qy; cross += px * qy - py * qx; norm += px * px + py * py
    }
    if (!(norm > 1e-6)) return null
    const a = dot / norm, b = cross / norm, det = a * a + b * b
    const tx = md[0] - (a * ms[0] - b * ms[1]), ty = md[1] - (b * ms[0] + a * ms[1])
    const input = new Float32Array(3 * 112 * 112), { w, h } = frame
    for (let v = 0; v < 112; v++) for (let u = 0; u < 112; u++) {
      const qx = u - tx, qy = v - ty
      const x = (a * qx + b * qy) / det, y = (-b * qx + a * qy) / det
      const x0 = Math.floor(x), y0 = Math.floor(y), wx = x - x0, wy = y - y0, di = v * 112 + u
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue
      const bpp = frame.bpp, i00 = (y0 * w + x0) * bpp, i01 = i00 + bpp, i10 = i00 + w * bpp, i11 = i10 + bpp
      for (let c = 0; c < 3; c++) {
        const ch = bpp === 3 ? 2 - c : c // RGB order
        const top = frame.data[i00 + ch] + (frame.data[i01 + ch] - frame.data[i00 + ch]) * wx, bottom = frame.data[i10 + ch] + (frame.data[i11 + ch] - frame.data[i10 + ch]) * wx
        input[c * 12544 + di] = top + (bottom - top) * wy
      }
    }
    const r = this.sessions.recognizer
    const out = (await r.run({ [r.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) }))[r.outputNames[0]].data
    let n = 0; for (const x of out) n += x * x
    n = Math.sqrt(n) || 1
    return Float32Array.from(out, x => x / n)
  }
}

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
async function thumbnail(frame, rect) {
  const e = scaled(expanded(rect, 0.15), frame.w, frame.h)
  const x = Math.max(0, Math.floor(e.x)), y = Math.max(0, Math.floor(frame.h - e.y - e.height))
  const w = Math.min(frame.w - x, Math.ceil(e.width)), h = Math.min(frame.h - y, Math.ceil(e.height))
  if (w < 2 || h < 2) return undefined
  const canvas = makeCanvas(w, h), ctx = canvas.getContext('2d'), image = ctx.createImageData(w, h)
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const si = ((y + yy) * frame.w + x + xx) * frame.bpp, di = (yy * w + xx) * 4
    if (frame.bpp === 3) { image.data[di] = frame.data[si + 2]; image.data[di + 1] = frame.data[si + 1]; image.data[di + 2] = frame.data[si] }
    else { image.data[di] = frame.data[si]; image.data[di + 1] = frame.data[si + 1]; image.data[di + 2] = frame.data[si + 2] }
    image.data[di + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  const blob = await canvasBlob(canvas, 'image/jpeg', 0.8)
  return Buffer.from(await blob.arrayBuffer()).toString('base64')
}

export async function analyze(project, cancellation, progress, options = defaultFaceOptions()) {
  const detector = await new FaceDetector(options).init()
  const tracks = [], prints = new Map(), lastPrintTime = new Map()
  const continuityGap = Math.max(0.15, 2 / project.fps)
  const area = r => r.width * r.height
  const iou = (a, b) => { const i = intersect(a, b); return i ? area(i) / Math.max(0.00001, area(a) + area(b) - area(i)) : 0 }

  async function track(frame, time, detections) {
    cancellation.check()
    const assigned = new Set()
    for (const face of detections.sort((a, b) => a.x - b.x)) {
      // Pixel box (top-left origin) → normalized bottom-left rectangle.
      const rect = clippedToImage({ x: face.x / frame.w, y: 1 - (face.y + face.h) / frame.h, width: face.w / frame.w, height: face.h / frame.h })
      if (!rect) continue
      let best = null, bestScore = Infinity, obvious = null, obviousIoU = 0
      for (const t of tracks) {
        if (assigned.has(t.id)) continue
        const last = t.samples[t.samples.length - 1], overlap = iou(last.rect, rect)
        if (time - last.time <= continuityGap && overlap > 0.45 && overlap > obviousIoU) { obvious = t; obviousIoU = overlap }
      }
      let print = null
      if (obvious) {
        best = obvious
        if (time - (lastPrintTime.get(obvious.id) ?? 0) > 1) print = await detector.feature(frame, face)
      } else {
        print = await detector.feature(frame, face)
        for (const t of tracks) {
          if (assigned.has(t.id)) continue
          const last = t.samples[t.samples.length - 1], gap = time - last.time, overlap = iou(last.rect, rect)
          const old = prints.get(t.id), sim = print && old ? cosine(print, old) : null
          const continuous = gap <= continuityGap && overlap > 0.18 && (sim == null || sim > 0.2)
          const reentry = gap < 8 && sim != null && sim > 0.42
          if (!continuous && !reentry) continue
          const score = (1 - (sim ?? 0.5)) + (continuous ? (1 - overlap) * 0.25 : 0.35)
          if (score < bestScore) { best = t; bestScore = score }
        }
      }
      if (best) {
        best.samples.push({ time, rect }); assigned.add(best.id)
        if (print) { prints.set(best.id, print); lastPrintTime.set(best.id, time) }
      } else {
        const thumb = await thumbnail(frame, rect)
        const track = { id: uuid(), name: `인물 후보 ${tracks.length + 1}`, selected: true, ...(thumb ? { thumbnail: thumb } : {}), samples: [{ time, rect }] }
        tracks.push(track); if (print) prints.set(track.id, print); lastPrintTime.set(track.id, time); assigned.add(track.id)
      }
    }
  }

  if (project.isImage) {
    const bitmap = await loadImageBitmap(project.sourcePath)
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height))
    const canvas = makeCanvas(bitmap.width * scale, bitmap.height * scale), ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const frame = { w: canvas.width, h: canvas.height, data, bpp: 4 }
    let detections = await detector.detect(frame)
    // Still images are analysed once, so an extra 2× pass is affordable and finds faces below ~24 px.
    if (options.mode !== 'fast') {
      const big = makeCanvas(frame.w * 2, frame.h * 2), bctx = big.getContext('2d', { willReadFrequently: true })
      bctx.imageSmoothingQuality = 'high'; bctx.drawImage(canvas, 0, 0, big.width, big.height)
      const doubled = await detector.detect({ w: big.width, h: big.height, data: bctx.getImageData(0, 0, big.width, big.height).data, bpp: 4 }, 1)
      detections = mergeDetections([...detections, ...doubled.map(d => ({ ...d, x: d.x / 2, y: d.y / 2, w: d.w / 2, h: d.h / 2, points: d.points.map(([x, y]) => [x / 2, y / 2]) }))])
      big.width = big.height = 1
    }
    await track(frame, 0, detections)
    progress(1, '얼굴 분석 완료')
    return tracks
  }
  const ranges = analysisRanges(project)
  const total = ranges.reduce((s, r) => s + r.end - r.start, 0)
  if (!(total > 0)) throw new StudioError('분석할 영상 컷이 없습니다.')
  const edge = options.mode === 'high' ? 1920 : options.mode === 'fast' ? 960 : 1280
  const scale = Math.min(1, edge / Math.max(project.width, project.height))
  const w = Math.max(2, Math.round(project.width * scale / 2) * 2), h = Math.max(2, Math.round(project.height * scale / 2) * 2)
  let completed = 0
  const started = performance.now()
  let processed = 0
  for (const range of ranges) {
    cancellation.check()
    let i = 0, lastProgress = -1
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', range.start.toFixed(6), '-i', project.sourcePath, '-t', (range.end - range.start).toFixed(6),
      '-map', '0:v:0', '-an', '-sn', '-vf', `fps=${rational(project.fps)},scale=${w}:${h}:flags=area,format=bgr24`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1']
    // Frame N+1 is preprocessed while frame N's inference is still running.
    let pending = null
    const settle = async () => { if (pending) { const q = pending; pending = null; await track(q.frame, q.time, await q.detections) } }
    for await (const buf of readFrames(args, w * h * 3, cancellation)) {
      const time = range.start + i / project.fps
      if (time >= range.end) break
      const frame = { w, h, data: buf, bpp: 3 }, detections = detector.detect(frame, i % 2)
      detections.catch(() => {})
      i++
      await settle()
      pending = { frame, time, detections }
      processed++
      if (time - lastProgress >= 0.25) {
        const done = completed + time - range.start, fps = processed / Math.max(0.001, (performance.now() - started) / 1000)
        progress(Math.min(0.99, done / total), `남은 컷 분석 · ${timecode(done)} / ${timecode(total)} · 후보 ${tracks.length}명 · ${fps.toFixed(0)} fps`); lastProgress = time
      }
    }
    await settle()
    completed += range.end - range.start
  }
  cancellation.check()
  progress(1, '얼굴 분석 완료')
  return tracks
}

// Every file used on the timeline is analysed in turn; tracks are tagged with their media id.
export async function analyzeProject(project, cancellation, progress, options = defaultFaceOptions()) {
  const used = mediaList(project).filter(m => project.isImage || project.clips.some(c => mediaOf(project, c) === m.id))
  const multi = !!project.media, weights = used.map(m => m.isImage ? 1 : Math.max(0.1, analysisRanges(project, m.id).reduce((s, r) => s + r.end - r.start, 0)))
  const total = weights.reduce((a, b) => a + b, 0)
  let done = 0
  const all = []
  for (const [i, m] of used.entries()) {
    cancellation.check()
    const prefix = multi ? `[${i + 1}/${used.length}] ${mediaName(m)} · ` : ''
    const tracks = await analyze(mediaView(project, m), cancellation, (v, s) => progress((done + v * weights[i]) / total, prefix + s), options)
    for (const t of tracks) { if (multi) t.media = m.id; t.name = `인물 후보 ${all.length + 1}`; all.push(t) }
    done += weights[i]
  }
  progress(1, `얼굴 분석 완료 · 후보 ${all.length}명`)
  return all
}
