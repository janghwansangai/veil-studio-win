// Canvas port of MaskRenderer (MediaEngine.swift). Preview and export share this code path.
import { faceRectAt, regionRectAt, expanded, faceDesign, regionDesign, cropRect, outputSize, clamp, mediaById, mediaOf, mediaToProjectRect } from './model.js'

export const CAPTION_FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif'
const EMOJI_FONT = '"Segoe UI Emoji", "Segoe UI Symbol", "Malgun Gothic", sans-serif'

// Shape outlines in a 256×256 box with a top-left origin (flipped from the Core Graphics originals).
function shapePath(ctx, shape) {
  ctx.beginPath()
  switch (shape) {
    case '사각형': ctx.rect(0, 0, 256, 256); break
    case '둥근 사각형': ctx.roundRect(0, 0, 256, 256, 42); break
    case '하트':
      ctx.moveTo(128, 246); ctx.bezierCurveTo(25, 166, 12, 141, 12, 98)
      ctx.bezierCurveTo(12, 9, 90, -11, 128, 53); ctx.bezierCurveTo(166, -11, 244, 9, 244, 98)
      ctx.bezierCurveTo(244, 141, 230, 166, 128, 246); ctx.closePath(); break
    case '별':
      for (let i = 0; i < 10; i++) {
        const a = i * Math.PI / 5 + Math.PI / 2, radius = i % 2 === 0 ? 127 : 65
        const x = 128 + Math.cos(a) * radius, y = 256 - (128 + Math.sin(a) * radius)
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.closePath(); break
    default: ctx.ellipse(128, 128, 128, 128, 0, 0, Math.PI * 2)
  }
}

// Works in the window and in background workers (OffscreenCanvas).
export function makeCanvas(w = 1, h = 1) {
  const width = Math.max(1, Math.round(w)), height = Math.max(1, Math.round(h))
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height)
  const c = document.createElement('canvas'); c.width = width; c.height = height; return c
}
export async function canvasBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality })
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

export class MaskRenderer {
  // cpu: scratch canvases stay in system memory, avoiding GPU round-trips when the target canvas is read back (export).
  constructor({ cpu = false } = {}) {
    this.a = makeCanvas(); this.b = makeCanvas()
    if (cpu) for (const c of [this.a, this.b]) c.getContext('2d', { willReadFrequently: true })
  }
  size(canvas, w, h) { w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h)); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h } return canvas }

  // mediaId: the source file shown at this moment; face tracks of other files are ignored.
  masks(p, time, overlayTime, mediaId = null) {
    const fd = faceDesign(p), rd = regionDesign(p)
    const masks = []
    if (p.maskApplied && time >= 0) {
      const media = mediaById(p, mediaId), tolerance = Math.max(0.06, 1.5 / media.fps), still = p.isImage || media.isImage
      for (const face of p.faces) {
        if (!face.selected || mediaOf(p, face) !== media.id) continue
        const r = faceRectAt(face, time, still, tolerance)
        if (r) masks.push([mediaToProjectRect(expanded(r, fd.margin), media, p), fd])
      }
    }
    const t = p.overlaysOnTimeline === true ? (overlayTime ?? time) : time
    const regions = [...p.regions].sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
    for (const r of regions) if (r.enabled && (p.isImage || (t >= r.start && t < r.end))) masks.push([regionRectAt(r, t), rd])
    return masks
  }
  captions(p, overlayTime) {
    if (!p.export.burnCaptions) return []
    return [...p.captions].sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0)).filter(c => overlayTime >= c.start && overlayTime < c.end && c.text)
  }
  // Frames without masks or captions can skip the canvas entirely during export.
  hasOverlays(p, time, overlayTime, mediaId = null) {
    const t = p.overlaysOnTimeline === true ? (overlayTime ?? time) : time
    return this.masks(p, time, overlayTime, mediaId).length > 0 || this.captions(p, t).length > 0
  }
  // Output-space rectangles touched by masks (incl. blur sampling margin) and captions.
  // Overlapping boxes are merged so masks that interact are rendered together; the rest stay small.
  regions(p, time, overlayTime, w, h, view, mediaId = null) {
    const boxes = []
    for (const [n, d] of this.masks(p, time, overlayTime, mediaId)) {
      const left = n.x * view.W - view.ox, top = (1 - n.y - n.height) * view.H - view.oy
      const a = Math.max(0, left), b = Math.max(0, top), c = Math.min(w, left + n.width * view.W), e = Math.min(h, top + n.height * view.H)
      if (c - a <= 1 || e - b <= 1) continue
      const m = d.effect === '블러' ? Math.ceil(Math.max(8, Math.min(c - a, e - b) * (0.06 + d.strength * 0.22)) * 3) + 2 : 2
      boxes.push([a - m, b - m, c + m, e + m])
    }
    const t = p.overlaysOnTimeline === true ? (overlayTime ?? time) : time
    for (const c of this.captions(p, t)) { const box = captionBox(c, w, h, p.export.captionSize); boxes.push([box.x - 2, box.y - 2, box.x + box.width + 2, box.y + box.height + 2]) }
    for (let merged = true; merged;) {
      merged = false
      for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j]
        if (A[0] < B[2] && B[0] < A[2] && A[1] < B[3] && B[1] < A[3]) {
          boxes[i] = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])]; boxes.splice(j, 1); merged = true; break
        }
      }
    }
    // Even-aligned for 4:2:0 chroma.
    return boxes.map(([x1, y1, x2, y2]) => {
      const x = Math.max(0, Math.floor(x1 / 2) * 2), y = Math.max(0, Math.floor(y1 / 2) * 2)
      const r = Math.min(w, Math.ceil(x2 / 2) * 2), b = Math.min(h, Math.ceil(y2 / 2) * 2)
      return { x, y, w: r - x, h: b - y }
    }).filter(r => r.w >= 2 && r.h >= 2)
  }
  // ctx shows only `region` of the w×h output frame.
  renderRegion(ctx, region, w, h, p, time, overlayTime, view, mediaId = null) {
    this.applyMasks(ctx, region.w, region.h, p, time, overlayTime, { W: view.W, H: view.H, ox: view.ox + region.x, oy: view.oy + region.y }, mediaId)
    ctx.save(); ctx.translate(-region.x, -region.y)
    this.drawCaptions(ctx, w, h, p, p.overlaysOnTimeline === true ? (overlayTime ?? time) : time)
    ctx.restore()
  }
  // The frame is already drawn on ctx (w×h). Masks are applied in order like the Core Image chain.
  // view maps the full source frame (W×H pixels) onto the canvas when it only shows a cropped part.
  applyMasks(ctx, w, h, p, time, overlayTime, view = { W: w, H: h, ox: 0, oy: 0 }, mediaId = null) {
    for (const [n, d] of this.masks(p, time, overlayTime, mediaId)) this.applyOne(ctx, w, h, n, d, view)
  }
  applyOne(ctx, w, h, n, d, view = { W: w, H: h, ox: 0, oy: 0 }) {
    // Normalized rects have a bottom-left origin.
    let left = n.x * view.W - view.ox, top = (1 - n.y - n.height) * view.H - view.oy, rw = n.width * view.W, rh = n.height * view.H
    const x1 = Math.max(0, left), y1 = Math.max(0, top), x2 = Math.min(w, left + rw), y2 = Math.min(h, top + rh)
    if (x2 - x1 <= 1 || y2 - y1 <= 1) return
    left = x1; top = y1; rw = x2 - x1; rh = y2 - y1
    const src = ctx.canvas
    let effect = null
    if (d.effect === '모자이크') {
      const block = Math.max(6, Math.min(rw, rh) * (0.07 + d.strength * 0.25))
      const sw = Math.max(1, Math.round(rw / block)), sh = Math.max(1, Math.round(rh / block))
      const small = this.size(this.b, sw, sh), sctx = small.getContext('2d')
      sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'medium'
      sctx.clearRect(0, 0, sw, sh); sctx.drawImage(src, left, top, rw, rh, 0, 0, sw, sh)
      effect = (c) => { c.imageSmoothingEnabled = false; c.drawImage(small, 0, 0, sw, sh, left, top, rw, rh); c.imageSmoothingEnabled = true }
    } else if (d.effect === '블러') {
      const radius = Math.max(8, Math.min(rw, rh) * (0.06 + d.strength * 0.22))
      const m = Math.ceil(radius * 3)
      const ax = Math.max(0, left - m), ay = Math.max(0, top - m), bx = Math.min(w, left + rw + m), by = Math.min(h, top + rh + m)
      // A strong Gaussian blur has no fine detail left, so it is computed at 1/k resolution and scaled back.
      const k = Math.max(1, radius / 6)
      const tw = Math.ceil((rw + m * 2) / k), th = Math.ceil((rh + m * 2) / k)
      const tmp = this.size(this.a, tw, th), tctx = tmp.getContext('2d')
      tctx.filter = 'none'; tctx.imageSmoothingQuality = 'medium'; tctx.clearRect(0, 0, tmp.width, tmp.height)
      // Stretched copy underneath approximates Core Image's clampedToExtent at frame edges.
      tctx.drawImage(src, ax, ay, bx - ax, by - ay, 0, 0, tw, th)
      tctx.drawImage(src, ax, ay, bx - ax, by - ay, (ax - (left - m)) / k, (ay - (top - m)) / k, (bx - ax) / k, (by - ay) / k)
      const out = this.size(this.b, tw, th), octx = out.getContext('2d')
      octx.clearRect(0, 0, out.width, out.height); octx.filter = `blur(${radius / k}px)`; octx.drawImage(tmp, 0, 0); octx.filter = 'none'
      effect = (c) => { c.imageSmoothingQuality = 'high'; c.drawImage(out, m / k, m / k, rw / k, rh / k, left, top, rw, rh) }
    } else {
      const color = `rgb(${Math.round(d.red * 255)},${Math.round(d.green * 255)},${Math.round(d.blue * 255)})`
      effect = (c) => {
        c.fillStyle = color; c.fillRect(left, top, rw, rh)
        if (d.effect === '스티커' && d.sticker) {
          c.save(); c.translate(left, top); c.scale(rw / 256, rh / 256)
          c.font = `180px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'
          c.fillText(d.sticker, 128, 136, 250); c.restore()
        }
      }
    }
    ctx.save()
    ctx.translate(left, top); ctx.scale(rw / 256, rh / 256); shapePath(ctx, d.shape); ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clip(); effect(ctx); ctx.restore()
  }

  drawCaptions(ctx, w, h, p, overlayTime) {
    for (const c of this.captions(p, overlayTime)) drawCaption(ctx, c.text, captionBox(c, w, h, p.export.captionSize))
  }
  // Export path: ctx already holds the cropped, scaled output frame.
  renderOutput(ctx, w, h, p, time, overlayTime, view) {
    this.applyMasks(ctx, w, h, p, time, overlayTime, view)
    this.drawCaptions(ctx, w, h, p, p.overlaysOnTimeline === true ? (overlayTime ?? time) : time)
  }

  // Full pipeline: frame on `frame` canvas (source resolution or scaled), output on `out` canvas.
  renderFrame(frame, out, p, time, overlayTime, crop, mediaId = null) {
    const w = frame.width, h = frame.height, fctx = frame.getContext('2d')
    if (!p.isImage && time < 0) { fctx.fillStyle = '#000'; fctx.fillRect(0, 0, w, h) }
    this.applyMasks(fctx, w, h, p, time, overlayTime, undefined, mediaId)
    const octx = out.getContext('2d')
    if (crop) {
      const r = cropRect(p.export, w, h), top = h - r.y - r.height
      octx.imageSmoothingQuality = 'high'
      octx.drawImage(frame, r.x, top, r.width, r.height, 0, 0, out.width, out.height)
    } else if (out !== frame) octx.drawImage(frame, 0, 0, out.width, out.height)
    const t = p.overlaysOnTimeline === true ? (overlayTime ?? time) : time
    this.drawCaptions(octx, out.width, out.height, p, t)
  }
}

export function captionBox(c, w, h, captionSize) {
  const font = Math.max(12, Math.min(w, h) * captionSize)
  const width = Math.floor(w * clamp(c.boxWidth ?? 0.86, 0.1, 1))
  const lineCount = Math.max(1, Math.min(5, Math.ceil(c.text.length * font * 0.8 / Math.max(1, width)) + (c.text.match(/\n/g)?.length ?? 0)))
  const height = Math.floor(font * (lineCount * 1.35 + 0.7))
  const x = (w - width) * clamp(c.horizontal ?? 0.5, 0, 1)
  const bottom = Math.max(0, h - height) * clamp(c.vertical ?? (h * 0.055 / Math.max(1, h - height)), 0, 1)
  return { x, y: h - bottom - height, width, height, font }
}

function wrapLines(ctx, text, maxWidth) {
  const lines = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      const test = line + word
      if (ctx.measureText(test).width <= maxWidth || !line.trim()) {
        if (ctx.measureText(test).width <= maxWidth) { line = test; continue }
        // A single word wider than the box (common in Korean) breaks per character.
        for (const ch of word) { if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch } else line += ch }
      } else { lines.push(line.trimEnd()); line = word.trimStart() }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

export function drawCaption(ctx, text, box) {
  const { x, y, width, height, font } = box
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.beginPath(); ctx.roundRect(x, y, width, height, height * 0.1); ctx.fill()
  ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip()
  const padding = font * 0.3
  ctx.font = `600 ${font}px ${CAPTION_FONT}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  const lines = wrapLines(ctx, text, width - padding * 2)
  const lineHeight = font * 1.22, total = lines.length * lineHeight
  let cy = y + Math.max(0, (height - total) / 2) + lineHeight / 2
  for (const line of lines) { ctx.fillText(line, x + width / 2, cy); cy += lineHeight }
  ctx.restore()
}

export { outputSize }
