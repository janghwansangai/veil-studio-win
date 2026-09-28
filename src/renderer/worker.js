// Background job worker: heavy work (face analysis, speech, music removal, export, waveform, preview proxy)
// runs here so the editor window stays responsive. One worker per job; Node integration is enabled for workers.
import { Cancellation, isCancel } from './lib/model.js'
import { env, exportMedia, makeProxy, AudioWaveform } from './lib/media.js'
import { analyzeProject } from './lib/faces.js'
import { transcribeProject } from './lib/speech.js'

let token = null
let lastProgress = 0
function progress(value, status) {
  const now = performance.now()
  if (now - lastProgress < 120 && value < 1) return // keep message traffic low
  lastProgress = now
  self.postMessage({ type: 'progress', value, status })
}

const jobs = {
  faces: ({ project, options }) => analyzeProject(project, token, progress, options),
  speech: ({ project, locale, options }) => transcribeProject(project, locale, options, token, progress),
  export: async ({ project, destination, audioCount }) => { const stats = {}; await exportMedia(project, destination, token, progress, { audioCount, stats }); return stats },
  proxy: ({ media }) => makeProxy(media, token, v => progress(v, '미리보기용 사본 생성 중')),
  waveform: async ({ source, duration, ranges, audioCount }) => {
    const w = await AudioWaveform.read(source, duration, ranges, audioCount, token)
    return { peaks: w.peaks, duration: w.duration, ranges: w.ranges, hasAudio: w.hasAudio }
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { token?.cancel(); return }
  if (data.type !== 'start') return
  Object.assign(env, data.env)
  token = new Cancellation()
  try {
    const result = await jobs[data.kind](data.payload)
    self.postMessage({ type: 'done', result })
  } catch (e) {
    self.postMessage({ type: 'error', cancelled: isCancel(e) || token.cancelled, message: e?.message ?? String(e), stack: e?.stack ?? '' })
  }
}
