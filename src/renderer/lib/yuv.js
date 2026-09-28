// YUV 4:2:0 (limited range) helpers for the export path. Only the rectangle that receives
// masks or captions is converted to RGBA and back; every other pixel keeps the decoder's values.
const MATRIX = {
  709: { r: [1.793, 0], g: [-0.213, -0.533], b: [0, 2.112], y: [0.183, 0.614, 0.062], u: [-0.101, -0.339, 0.439], v: [0.439, -0.399, -0.040] },
  601: { r: [1.596, 0], g: [-0.392, -0.813], b: [0, 2.017], y: [0.257, 0.504, 0.098], u: [-0.148, -0.291, 0.439], v: [0.439, -0.368, -0.071] }
}
export const matrixFor = height => (height >= 720 ? 709 : 601)
export const frameBytes = (w, h) => w * h * 3 / 2

export function blackFrame(w, h) {
  const buf = Buffer.alloc(frameBytes(w, h), 128)
  buf.fill(16, 0, w * h)
  return buf
}

// Region → RGBA (rgba is a Uint8ClampedArray of rw*rh*4).
export function toRGBA(buf, W, H, rx, ry, rw, rh, rgba, standard) {
  const m = MATRIX[standard], uo = W * H, vo = uo + (W >> 1) * (H >> 1), cw = W >> 1
  let o = 0
  for (let y = 0; y < rh; y++) {
    const yy = ry + y, row = yy * W, crow = (yy >> 1) * cw
    for (let x = 0; x < rw; x++) {
      const xx = rx + x, c = 1.164 * (buf[row + xx] - 16), ci = crow + (xx >> 1)
      const d = buf[uo + ci] - 128, e = buf[vo + ci] - 128
      rgba[o] = c + m.r[0] * e
      rgba[o + 1] = c + m.g[0] * d + m.g[1] * e
      rgba[o + 2] = c + m.b[1] * d
      rgba[o + 3] = 255
      o += 4
    }
  }
}

// Writes back only pixels that changed, so untouched areas are bit-exact.
export function fromRGBA(buf, W, H, rx, ry, rw, rh, rgba, before, standard) {
  const m = MATRIX[standard], uo = W * H, vo = uo + (W >> 1) * (H >> 1), cw = W >> 1
  const Y = (r, g, b) => 16 + m.y[0] * r + m.y[1] * g + m.y[2] * b
  for (let y = 0; y < rh; y += 2) {
    for (let x = 0; x < rw; x += 2) {
      let changed = false, sr = 0, sg = 0, sb = 0
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y + dy) * rw + x + dx) * 4
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
        sr += r; sg += g; sb += b
        if (r !== before[i] || g !== before[i + 1] || b !== before[i + 2]) {
          changed = true
          buf[(ry + y + dy) * W + rx + x + dx] = Math.max(0, Math.min(255, Math.round(Y(r, g, b))))
        }
      }
      if (!changed) continue
      sr /= 4; sg /= 4; sb /= 4
      const ci = ((ry + y) >> 1) * cw + ((rx + x) >> 1)
      buf[uo + ci] = Math.max(0, Math.min(255, Math.round(128 + m.u[0] * sr + m.u[1] * sg + m.u[2] * sb)))
      buf[vo + ci] = Math.max(0, Math.min(255, Math.round(128 + m.v[0] * sr + m.v[1] * sg + m.v[2] * sb)))
    }
  }
}
