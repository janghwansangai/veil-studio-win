// Background-music removal before speech recognition using UVR-MDX-NET-Voc_FT
// (MIT, credit: UVR — Anjok07 & aufr33). The model predicts the vocal spectrogram; the STFT/iSTFT and
// windowing follow UVR's MDX separation (n_fft 7680, hop 1024, 3072 bins, 256 frames, compensate 1.021).
import { StudioError, CancellationError } from './model.js'
import { env, nodeFs as fs, nodePath as path } from './media.js'
import { FFT, hann, stft2, istft2 } from './fft.js'
import { ort, createSession, modelFile } from './onnx.js'

const { spawn } = (globalThis.require ?? window.require)('node:child_process')
const RATE = 44100, N_FFT = 7680, HOP = 1024, DIM_F = 3072, DIM_T = 256, COMPENSATE = 1.021
const TRIM = N_FFT / 2, CHUNK = HOP * (DIM_T - 1), GEN = CHUNK - 2 * TRIM
const SEGMENT = 240, CONTEXT = 3 // seconds processed per pass / overlap discarded at segment joins

let cached = null
async function session(device) {
  if (cached && cached.key === device) return cached
  const file = modelFile(env.separationModels, 'UVR-MDX-NET-Voc_FT.onnx')
  if (!fs.existsSync(file)) throw new StudioError('배경음악 제거 모델을 찾지 못했습니다. 앱을 다시 설치해 주세요.')
  const created = await createSession(file, device)
  cached = { key: device, ...created }
  return cached
}

function readStereo(file, start, duration, track, cancellation) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-t', String(duration), '-i', file,
      '-map', `0:a:${track}`, '-vn', '-ac', '2', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true })
    const parts = []
    proc.stdout.on('data', d => parts.push(d))
    proc.stderr.on('data', () => {})
    const off = cancellation.onCancel(() => proc.kill())
    proc.on('error', e => { off(); reject(new StudioError(e.message)) })
    proc.on('close', () => {
      off()
      if (cancellation.cancelled) return reject(new CancellationError())
      const buf = Buffer.concat(parts), n = Math.floor(buf.length / 8)
      const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 8))
      const l = new Float32Array(n), r = new Float32Array(n)
      for (let i = 0; i < n; i++) { l[i] = all[2 * i]; r[i] = all[2 * i + 1] }
      resolve([l, r])
    })
  })
}

// UVR windowing: zero-pad by TRIM on both sides, run CHUNK-long windows every GEN samples, keep the centre.
async function separateBuffer(l, r, model, cancellation, onChunk) {
  const n = l.length, pad = GEN - (n % GEN), total = TRIM + n + pad + TRIM
  const pl = new Float32Array(total), pr = new Float32Array(total)
  pl.set(l, TRIM); pr.set(r, TRIM)
  const fft = new FFT(N_FFT), window = hann(N_FFT)
  const outL = new Float32Array(n + pad), outR = new Float32Array(n + pad)
  const windows = Math.ceil((n + pad) / GEN)
  for (let w = 0, i = 0; i < n + pad; i += GEN, w++) {
    cancellation.check()
    const { data, frames } = stft2(pl.subarray(i, i + CHUNK), pr.subarray(i, i + CHUNK), N_FFT, HOP, DIM_F, fft, window)
    const input = new ort.Tensor('float32', data, [1, 4, DIM_F, frames])
    const result = await model.session.run({ [model.session.inputNames[0]]: input })
    const [a, b] = istft2(result[model.session.outputNames[0]].data, frames, N_FFT, HOP, DIM_F, fft, window, CHUNK)
    outL.set(a.subarray(TRIM, TRIM + GEN), i); outR.set(b.subarray(TRIM, TRIM + GEN), i)
    onChunk((w + 1) / windows)
    await new Promise(res => setTimeout(res, 0)) // keep the UI responsive between windows
  }
  return [outL.subarray(0, n), outR.subarray(0, n)]
}

function wavHeader(samples) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples * 4, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(samples * 4, 40)
  return h
}

// Writes the separated vocals of [offset, offset+length] as a mono 32-bit float WAV.
export async function separateVocals(source, offset, length, track, destination, device, cancellation, progress) {
  const model = await session(device)
  const fd = fs.openSync(destination, 'w')
  let written = 0
  try {
    fs.writeSync(fd, wavHeader(0))
    for (let s = 0; s < length; s += SEGMENT) {
      cancellation.check()
      const segLen = Math.min(SEGMENT, length - s), pre = s > 0 ? CONTEXT : 0, post = Math.min(CONTEXT, length - s - segLen)
      const [l, r] = await readStereo(source, offset + s - pre, pre + segLen + post, track, cancellation)
      if (!l.length) break
      const [vl, vr] = await separateBuffer(l, r, model, cancellation, v => progress((s + v * segLen) / length, model.device))
      const from = Math.round(pre * RATE), to = Math.min(vl.length, from + Math.round(segLen * RATE))
      const mono = new Float32Array(to - from)
      for (let i = 0; i < mono.length; i++) mono[i] = (vl[from + i] + vr[from + i]) * 0.5 * COMPENSATE
      fs.writeSync(fd, Buffer.from(mono.buffer)); written += mono.length
    }
    fs.writeSync(fd, wavHeader(written), 0, 44, 0)
  } finally { fs.closeSync(fd) }
  return { device: model.device, samples: written }
}
