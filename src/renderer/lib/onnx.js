// Shared ONNX Runtime session helper (CPU or the fastest DirectML adapter).
import { env, nodePath } from './media.js'

const req = globalThis.require ?? window.require
export const ort = req('onnxruntime-node')
const os = req('node:os')

export const modelFile = (folder, name) => nodePath.join(folder, name)
export function sessionOptions(provider, threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)))) {
  return {
    executionProviders: provider ? [provider, 'cpu'] : ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
    intraOpNumThreads: threads, enableMemPattern: !provider
  }
}

// DirectML adapter order differs per PC (integrated GPUs are often device 0 and several times slower),
// so every adapter is timed once with the small face detector and the fastest one is kept.
let bestAdapter = null
export async function fastestAdapter() {
  if (bestAdapter !== null) return bestAdapter
  let best = { id: -1, ms: Infinity }
  const x = new ort.Tensor('float32', new Float32Array(3 * 640 * 640).fill(90), [1, 3, 640, 640])
  for (let id = 0; id < 4; id++) {
    try {
      const s = await ort.InferenceSession.create(modelFile(env.faceModels, 'face_detection_yunet_2023mar.onnx'), sessionOptions({ name: 'dml', deviceId: id }))
      for (let i = 0; i < 2; i++) await s.run({ [s.inputNames[0]]: x })
      const t = performance.now(); for (let i = 0; i < 6; i++) await s.run({ [s.inputNames[0]]: x })
      const ms = (performance.now() - t) / 6
      if (ms < best.ms) best = { id, ms }
      await s.release?.()
    } catch { /* adapter not usable by DirectML */ }
  }
  bestAdapter = best.id
  return bestAdapter
}

// device: 'cpu' | 'gpu'. Falls back to the CPU when DirectML is unavailable.
export async function createSession(file, device, threads) {
  if (device === 'gpu') {
    const id = await fastestAdapter()
    if (id >= 0) {
      try { return { session: await ort.InferenceSession.create(file, sessionOptions({ name: 'dml', deviceId: id }, threads)), device: `GPU ${id}` } } catch {}
    }
  }
  return { session: await ort.InferenceSession.create(file, sessionOptions(null, threads)), device: 'CPU' }
}
