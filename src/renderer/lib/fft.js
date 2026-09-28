// Mixed-radix (2/3/4/5) complex FFT and PyTorch-compatible STFT/iSTFT (center=True, reflect padding,
// periodic Hann window) used by the vocal separation model.

function factorize(n) {
  const f = []
  for (const r of [4, 2, 3, 5]) while (n % r === 0) { f.push(r); n /= r }
  if (n !== 1) throw new Error('FFT size must factor into 2, 3 and 5')
  return f
}

export class FFT {
  constructor(n) {
    this.n = n
    const factors = factorize(n) // applied bottom-up
    this.levels = []
    let size = 1
    for (const r of factors) { this.levels.push({ r, m: size }); size *= r }
    // Input permutation for the iterative decimation-in-time passes.
    const perm = (len, list) => {
      if (!list.length) return [0]
      const r = list[list.length - 1], sub = perm(len / r, list.slice(0, -1)), out = []
      for (let q = 0; q < r; q++) for (const j of sub) out.push(q + r * j)
      return out
    }
    this.perm = Int32Array.from(perm(n, factors))
    this.cos = new Float64Array(n); this.sin = new Float64Array(n)
    for (let i = 0; i < n; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n) }
    this.re = new Float64Array(n); this.im = new Float64Array(n)
    this.vr = new Float64Array(5); this.vi = new Float64Array(5)
  }
  // In-place transform of (re, im) — Float32Array or Float64Array. inverse applies 1/n.
  transform(re, im, inverse = false) {
    const { n, perm, cos, sin, vr, vi } = this, ar = this.re, ai = this.im, sign = inverse ? -1 : 1
    for (let i = 0; i < n; i++) { ar[i] = re[perm[i]]; ai[i] = im[perm[i]] }
    for (const { r, m } of this.levels) {
      const block = r * m, step = n / block, rootStep = n / r
      for (let b = 0; b < n; b += block) {
        for (let k = 0; k < m; k++) {
          for (let q = 0; q < r; q++) {
            const idx = b + q * m + k, t = (q * k * step) % n
            const wr = cos[t], wi = sign * sin[t], xr = ar[idx], xi = ai[idx]
            vr[q] = xr * wr - xi * wi; vi[q] = xr * wi + xi * wr
          }
          for (let t = 0; t < r; t++) {
            let sr = 0, si = 0
            for (let q = 0; q < r; q++) {
              const u = (q * t * rootStep) % n, wr = cos[u], wi = sign * sin[u]
              sr += vr[q] * wr - vi[q] * wi; si += vr[q] * wi + vi[q] * wr
            }
            ar[b + t * m + k] = sr; ai[b + t * m + k] = si
          }
        }
      }
    }
    const scale = inverse ? 1 / n : 1
    for (let i = 0; i < n; i++) { re[i] = ar[i] * scale; im[i] = ai[i] * scale }
  }
}

export const hann = n => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n))

// Two real channels share one complex FFT (x0 + i·x1). Output: spec[c][f][t] as re/im planes,
// frames T = 1 + len/hop, bins limited to dimF — the layout MDX-Net expects: [c0 re, c0 im, c1 re, c1 im].
export function stft2(ch0, ch1, nFft, hop, dimF, fft, window) {
  const len = ch0.length, T = 1 + Math.floor(len / hop), half = nFft / 2
  const out = new Float32Array(4 * dimF * T)
  const re = new Float64Array(nFft), im = new Float64Array(nFft)
  const reflect = i => { if (i < 0) i = -i; if (i >= len) i = 2 * (len - 1) - i; return Math.min(len - 1, Math.max(0, i)) }
  for (let t = 0; t < T; t++) {
    const start = t * hop - half
    for (let n = 0; n < nFft; n++) { const s = reflect(start + n); re[n] = ch0[s] * window[n]; im[n] = ch1[s] * window[n] }
    fft.transform(re, im)
    for (let f = 0; f < dimF; f++) {
      const g = f === 0 ? 0 : nFft - f
      const zr = re[f], zi = im[f], cr = re[g], ci = -im[g] // conj(Z[N-f])
      const plane = f * T + t
      out[plane] = (zr + cr) / 2; out[dimF * T + plane] = (zi + ci) / 2           // X0 = (Z + conj Z[N-k]) / 2
      out[2 * dimF * T + plane] = (zi - ci) / 2; out[3 * dimF * T + plane] = -(zr - cr) / 2 // X1 = (Z - conj Z[N-k]) / 2i
    }
  }
  return { data: out, frames: T }
}

// Inverse of stft2 for two channels (bins ≥ dimF are zero), overlap-add with window-square normalisation.
export function istft2(spec, T, nFft, hop, dimF, fft, window, length) {
  const half = nFft / 2, total = nFft + hop * (T - 1)
  const y0 = new Float64Array(total), y1 = new Float64Array(total), env = new Float64Array(total)
  const re = new Float64Array(nFft), im = new Float64Array(nFft)
  for (let t = 0; t < T; t++) {
    re.fill(0); im.fill(0)
    // Z = X0 + i·X1 with both spectra Hermitian → real parts give x0, imaginary parts give x1.
    for (let f = 0; f < dimF; f++) {
      const p = f * T + t
      const a = spec[p], b = spec[dimF * T + p], c = spec[2 * dimF * T + p], d = spec[3 * dimF * T + p]
      re[f] += a - d; im[f] += b + c
      if (f > 0) { re[nFft - f] += a + d; im[nFft - f] += c - b }
    }
    fft.transform(re, im, true)
    const o = t * hop
    for (let n = 0; n < nFft; n++) { const w = window[n]; y0[o + n] += re[n] * w; y1[o + n] += im[n] * w; env[o + n] += w * w }
  }
  const a = new Float32Array(length), b = new Float32Array(length)
  for (let i = 0; i < length; i++) { const e = env[half + i]; const s = e > 1e-11 ? 1 / e : 0; a[i] = y0[half + i] * s; b[i] = y1[half + i] * s }
  return [a, b]
}
