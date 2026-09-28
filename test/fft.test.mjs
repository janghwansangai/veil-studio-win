import test from 'node:test'
import assert from 'node:assert/strict'
import { FFT, hann, stft2, istft2 } from '../src/renderer/lib/fft.js'

test('mixed-radix FFT matches a naive DFT (n = 60, 7680)', () => {
  for (const n of [60, 7680]) {
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + (i % 7) * 0.1), im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.11))
    const fr = re.slice(), fi = im.slice()
    new FFT(n).transform(fr, fi)
    for (const k of [0, 1, 7, n / 2, n - 3]) {
      let sr = 0, si = 0
      for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; sr += re[t] * Math.cos(a) - im[t] * Math.sin(a); si += re[t] * Math.sin(a) + im[t] * Math.cos(a) }
      assert.ok(Math.abs(sr - fr[k]) < 1e-6 * n && Math.abs(si - fi[k]) < 1e-6 * n, `n=${n} k=${k}`)
    }
    const f = new FFT(n); f.transform(fr, fi, true)
    for (let i = 0; i < n; i += 97) assert.ok(Math.abs(fr[i] - re[i]) < 1e-9 && Math.abs(fi[i] - im[i]) < 1e-9)
  }
})

test('STFT → iSTFT round trip reconstructs both channels (full band)', () => {
  const nFft = 7680, hop = 1024, len = hop * 40
  const a = Float32Array.from({ length: len }, (_, i) => Math.sin(i * 0.013) * 0.5), b = Float32Array.from({ length: len }, (_, i) => Math.sin(i * 0.0071 + 1) * 0.3)
  const fft = new FFT(nFft), w = hann(nFft)
  const { data, frames } = stft2(a, b, nFft, hop, nFft / 2 + 1, fft, w)
  const [x, y] = istft2(data, frames, nFft, hop, nFft / 2 + 1, fft, w, len)
  let err = 0
  for (let i = 0; i < len; i++) err = Math.max(err, Math.abs(x[i] - a[i]), Math.abs(y[i] - b[i]))
  assert.ok(err < 1e-4, `max error ${err}`)
})
