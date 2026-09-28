// Runs heavy work in dedicated workers and tracks it for the status bar.
import { env } from './media.js'
import { CancellationError, StudioError, uuid } from './model.js'

export const JobLabels = { faces: '얼굴 분석', speech: '자동 자막', export: '내보내기', proxy: '미리보기 사본', waveform: '오디오 파형' }

export class JobManager {
  constructor(onChange) { this.jobs = []; this.onChange = onChange }
  running(kind) { return this.jobs.filter(j => !kind || j.kind === kind) }
  get visible() { return this.jobs.filter(j => j.kind !== 'waveform') }
  // Resolves with the worker's result; rejects with CancellationError or StudioError.
  start(kind, payload, { label = JobLabels[kind], session = null } = {}) {
    const job = { id: uuid(), kind, label, session, progress: 0, status: `${label} 준비 중`, cancelling: false }
    const worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' })
    job.promise = new Promise((resolve, reject) => {
      const finish = () => { worker.terminate(); this.jobs = this.jobs.filter(j => j !== job); clearTimeout(job.killTimer); this.onChange() }
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') { job.progress = data.value; job.status = data.status; this.onChange(); return }
        finish()
        if (data.type === 'done') resolve(data.result)
        else if (data.cancelled) reject(new CancellationError())
        else { const e = new StudioError(data.message); e.workerStack = data.stack; reject(e) }
      }
      worker.onerror = e => { e.preventDefault?.(); finish(); reject(new StudioError(`${label} 작업 중 오류: ${e.message ?? '알 수 없는 오류'}`)) }
      job.cancel = () => {
        if (job.cancelling) return
        job.cancelling = true; job.status = `${label} 취소 중…`; this.onChange()
        worker.postMessage({ type: 'cancel' })
        // The worker kills its child processes on cancel; terminate it if it does not answer.
        job.killTimer = setTimeout(() => { finish(); reject(new CancellationError()) }, 8000)
      }
    })
    job.promise.catch(() => {})
    this.jobs.push(job); this.onChange()
    worker.postMessage({ type: 'start', kind, payload, env: { ...env } })
    return job
  }
  cancelAll(filter = () => true) { for (const j of this.jobs.filter(filter)) j.cancel() }
}
