// Port of EditorStore.swift. The project is treated as an immutable value: every edit
// replaces it with a modified clone, mirroring Swift's value semantics for undo history.
// Heavy work (face analysis, speech, export, waveform, preview proxies) runs as background jobs in
// workers, so the editor stays usable; results are applied when a job finishes.
import * as M from './model.js'
import { env, load as loadMedia, probeMedia, probe, fileURL, loadImageBitmap, proxyPath, AudioWaveform, fileStamp, STILL_LENGTH, nodeFs as fs, nodePath as path } from './media.js'
import { defaultFaceOptions } from './faces.js'
import { defaultSpeechOptions, summary } from './speech.js'
import { MaskRenderer } from './render.js'
import { JobManager } from './jobs.js'

const { ipcRenderer } = window.require('electron')
const { StudioError, isCancel, linkedToVideo } = M

export const EditorTab = { media: '미디어', faces: '얼굴 마스킹', regions: '영역 마스킹', captions: '자막 편집' }
export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'ts', '3gp', 'flv', 'mpg', 'mpeg']
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'webp', 'gif', 'avif']
const STILL_CLIP = 5 // seconds a photo occupies when placed on the timeline

export const dialogs = {
  async open(options) { const r = await ipcRenderer.invoke('dialog:open', options); return r.canceled ? null : r.filePaths[0] },
  async openMany(options) { const r = await ipcRenderer.invoke('dialog:open', { ...options, properties: ['openFile', 'multiSelections'] }); return r.canceled ? [] : r.filePaths },
  async save(options) { const r = await ipcRenderer.invoke('dialog:save', options); return r.canceled ? null : r.filePath },
  async message(options) { return (await ipcRenderer.invoke('dialog:message', options)).response },
  contextMenu(items) { return ipcRenderer.invoke('menu:context', items) }
}
const MEDIA_FILTERS = [{ name: '동영상 · 이미지', extensions: [...VIDEO_EXT, ...IMAGE_EXT] }, { name: '동영상', extensions: VIDEO_EXT }, { name: '이미지', extensions: IMAGE_EXT }, { name: '모든 파일', extensions: ['*'] }]
// Korean SRT files are often saved as CP949/EUC-KR rather than UTF-8.
function decodeText(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('�')) return utf8
  try { return new TextDecoder('euc-kr').decode(bytes) } catch { return utf8 }
}
const samePath = (a, b) => { try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() || fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase() } catch { return false } }
const activeTextInput = () => { const e = document.activeElement; return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(e.type)) || e.isContentEditable) }
const stampMatches = m => { try { const s = fileStamp(m.path); return s.fileSize === m.fileSize && Math.abs(s.modified - (m.modified ?? NaN)) <= 0.002 } catch { return false } }

export class EditorStore {
  constructor() {
    this._project = M.newProject()
    this.listeners = { change: new Set(), time: new Set() }
    this.playhead = 0; this.playing = false; this.busy = false; this.progress = 0; this.rate = 1
    this.status = '파일을 불러와 편집을 시작하세요'; this.error = null
    this.tab = 'faces'; this.drawMode = false
    this.selectedTrack = 'video'; this.selectedLane = 0
    this.selectedCaption = null; this.selectedRegion = null; this.selectedClip = null; this.selectedClips = new Set(); this.selectedMedia = null
    this.wholeOverlayTrack = false
    this.clipboardCaptions = []; this.clipboardRegions = []; this.clipboardClips = []
    this.previewReady = false; this.waveforms = new Map(); this.waveformRequested = new Map(); this.waveformStatus = ''; this.waveformRevision = 0
    this.faceCoverage = new Map()
    this.exportSheet = false; this.helpSheet = false
    this.autoCaptions = true; this.speechOptions = defaultSpeechOptions(); this.faceOptions = defaultFaceOptions(); this.language = 'ko-KR'; this.speechNotes = []
    this.lastExport = null; this.projectURL = null
    this.undoStack = []; this.redoStack = []
    this.automaticRecoveryEnabled = true
    this.restoring = false; this.gestureStart = null; this.savedProject = null
    this.sessionID = M.uuid()
    this.timelineZoom = 1; this.snapping = true
    this.renderer = new MaskRenderer()
    this.canvas = null; this.stills = new Map(); this.visible = []
    this.players = new Map()
    this.jobs = new JobManager(() => this.changed())
    this.loop = this.loop.bind(this)
    this.pending = false; this.timePending = false
  }

  // ---------- observation ----------
  on(kind, f) { this.listeners[kind].add(f); return () => this.listeners[kind].delete(f) }
  changed() {
    if (this.pending) return
    this.pending = true
    queueMicrotask(() => { this.pending = false; for (const f of this.listeners.change) f(); this.syncChrome() })
  }
  timeChanged() {
    if (this.timePending) return
    this.timePending = true
    requestAnimationFrame(() => { this.timePending = false; for (const f of this.listeners.time) f() })
  }
  syncChrome() {
    const title = `${this.hasUnsavedChanges ? '● ' : ''}${this.fileName} — Veil Studio`
    if (title !== this.lastTitle) { this.lastTitle = title; ipcRenderer.send('app:title', { title, edited: this.hasUnsavedChanges }) }
    const text = this.editingText
    const state = {
      openMedia: !this.busy, openProject: !this.busy, recover: !this.busy, saveProject: this.loaded && !this.busy, saveProjectAs: this.loaded && !this.busy, export: this.loaded && !this.busy,
      importMedia: !this.busy, newProject: !this.busy,
      undo: !this.busy && (text || this.undoStack.length > 0), redo: !this.busy && (text || this.redoStack.length > 0),
      cut: !this.busy && (text || this.selectionAvailable), copy: !this.busy && (text || this.selectionAvailable), delete: !this.busy && (text || this.selectionAvailable),
      paste: !this.busy && (text || (this.canEditTimeline && this.pasteAvailable)), selectAll: !this.busy && (text || this.canEditTimeline),
      togglePlay: this.loaded && !this.project.isImage && !this.busy, split: this.canEditTimeline,
      moveLeft: this.selectionAvailable, moveRight: this.selectionAvailable, markIn: this.canEditTimeline, markOut: this.canEditTimeline,
      exportSelected: this.selectionAvailable, clearRange: !!this.project.exportRange, deleteRange: this.canEditTimeline && !!this.project.exportRange,
      addMarker: this.canEditTimeline, toggleClip: this.canDeleteClips, liftClip: this.canDeleteClips, zoomIn: this.canEditTimeline, zoomOut: this.canEditTimeline, zoomFit: this.canEditTimeline,
      toggleSnapping: this.canEditTimeline, trimStart: this.canEditTimeline, trimEnd: this.canEditTimeline
    }
    const key = JSON.stringify(state)
    if (key !== this.lastMenu) { this.lastMenu = key; ipcRenderer.send('menu:state', { ...state, snappingChecked: this.snapping }) }
  }

  // ---------- project value ----------
  get project() { return this._project }
  set project(p) {
    const old = this._project
    this._project = p
    this.visible = M.visibleTimeline(p)
    if (this.restoring || M.projectsEqual(p, old)) { this.requestDraw(); this.changed(); return }
    if (this.gestureStart == null && old.sourcePath) { this.undoStack.push(old); if (this.undoStack.length > 40) this.undoStack.shift(); this.redoStack = [] }
    if (this.gestureStart == null) { this.schedulePreview(); this.scheduleRecovery() }
    this.requestDraw(); this.changed()
  }
  edit(fn) { const p = M.cloneProject(this.project); const r = fn(p); this.project = p; return r }
  updateItem(kind, id, patch) {
    const i = this.project[kind].findIndex(x => x.id === id)
    if (i < 0) return
    this.edit(p => { p[kind][i] = { ...p[kind][i], ...(typeof patch === 'function' ? patch(p[kind][i]) : patch) } })
  }

  get loaded() { return !!this.project.sourcePath }
  get fileName() { return this.loaded ? path.basename(this.project.sourcePath) + (this.project.media?.length > 1 ? ` 외 ${this.project.media.length - 1}개` : '') : '새 프로젝트' }
  get media() { return this.loaded ? M.mediaList(this.project) : [] }
  get hasUnsavedChanges() { return this.loaded && !M.projectsEqual(this.project, this.savedProject) }
  get canEditTimeline() { return this.loaded && !this.project.isImage && !this.busy }
  get canDeleteClips() { return this.canEditTimeline && this.project.clips.some(c => this.selectedClips.has(c.id) && (c.lane ?? 0) === this.selectedLane) }
  get current() { return this.project.isImage ? null : M.entryAt(this.visible, this.playhead) }
  get currentMedia() { return this.current ? M.mediaById(this.project, this.current.entry.clip.media) : M.mediaList(this.project)[0] }
  get sourcePlayhead() { return this.project.isImage ? 0 : (this.current?.time ?? M.sourceTime(this.project, this.playhead)) }
  get overlayTime() { return this.project.overlaysOnTimeline === true ? this.playhead : this.sourcePlayhead }
  get editingText() { return activeTextInput() }
  get audioCount() { return M.mediaList(this.project)[0].audioCount ?? 0 }
  get selectionAvailable() {
    if (linkedToVideo(this.selectedTrack)) return this.canDeleteClips
    if (this.selectedTrack === 'regions') return this.project.regions.some(r => r.id === this.selectedRegion && (r.lane ?? 0) === this.selectedLane)
    return this.project.captions.some(c => c.id === this.selectedCaption && (c.lane ?? 0) === this.selectedLane)
  }
  get pasteAvailable() { return linkedToVideo(this.selectedTrack) ? this.clipboardClips.length > 0 : this.selectedTrack === 'regions' ? this.clipboardRegions.length > 0 : this.clipboardCaptions.length > 0 }
  get editedDuration() { return M.editedDuration(this.project) }
  get frame() { return 1 / Math.max(1, this.project.fps) }
  get runningJobs() { return this.jobs.visible }

  // ---------- lifecycle ----------
  // Before replacing the project or closing: offer to cancel background jobs, then to save.
  async confirmLeaving() {
    this.focusTimeline(); this.endTimelineGesture(); this.pause()
    if (this.busy) { this.error = '파일을 여는 중입니다. 잠시 후 다시 시도해 주세요.'; this.changed(); return false }
    const jobs = this.runningJobs
    if (jobs.length) {
      const r = await dialogs.message({ type: 'warning', title: 'Veil Studio', message: `진행 중인 작업 ${jobs.length}개를 취소할까요?`, detail: jobs.map(j => `· ${j.label}`).join('\n'), buttons: ['작업 취소 후 계속', '돌아가기'], defaultId: 1, cancelId: 1, noLink: true })
      if (r !== 0) return false
      await this.cancelJobs()
    }
    if (!this.hasUnsavedChanges) return true
    const response = await dialogs.message({ type: 'warning', title: 'Veil Studio', message: '변경한 프로젝트를 저장하시겠습니까?', detail: '저장하지 않고 계속하면 현재 변경 사항을 잃을 수 있습니다.', buttons: ['저장', '저장하지 않음', '취소'], defaultId: 0, cancelId: 2, noLink: true })
    if (response === 0) return this.saveProjectIfPossible()
    return response === 1
  }
  async cancelJobs(filter = () => true) {
    const jobs = this.jobs.jobs.filter(filter)
    for (const j of jobs) j.cancel()
    await Promise.race([Promise.allSettled(jobs.map(j => j.promise)), new Promise(r => setTimeout(r, 10000))])
  }
  async openMedia() {
    if (this.busy) return
    const files = await dialogs.openMany({ title: '편집할 동영상 또는 이미지를 선택하세요 (여러 개 선택 가능). 원본은 변경하지 않습니다.', filters: MEDIA_FILTERS })
    if (files.length) this.openFiles(files)
  }
  async importMedia() {
    if (this.busy) return
    const files = await dialogs.openMany({ title: '프로젝트에 추가할 동영상 · 이미지 (여러 개 선택 가능)', filters: MEDIA_FILTERS })
    if (files.length) this.addMedia(files, 'append')
  }
  // Menu/drag entry point: a video project takes further files as additional media; otherwise a new project starts.
  async openFiles(files) {
    const projectFile = files.find(f => f.toLowerCase().endsWith('.veilproject'))
    if (projectFile) return this.openProject(false, projectFile)
    if (this.loaded && !this.project.isImage) return this.addMedia(files, 'append')
    await this.load(files[0])
    if (files.length > 1 && this.loaded && !this.project.isImage) await this.addMedia(files.slice(1), 'append')
  }
  async newProject() {
    if (this.busy || !(await this.confirmLeaving())) return
    await this.setProject(M.newProject()); this.projectURL = null; this.status = '새 프로젝트 · 미디어를 불러오세요'; this.changed()
  }
  async load(file) {
    if (file.toLowerCase().endsWith('.veilproject')) return this.openProject(false, file)
    if (this.busy || !(await this.confirmLeaving())) return
    this.pause(); this.begin('파일 정보 읽는 중')
    try {
      const { project } = await loadMedia(file)
      await this.setProject(project); this.projectURL = null
      this.status = '파일 준비 완료 · 얼굴 분석을 시작하세요'; this.finish()
    } catch (e) { this.fail(e) }
  }
  async setProject(input) {
    this.pause(); clearTimeout(this.previewTimer); clearTimeout(this.recoveryTimer)
    this.jobs.cancelAll(j => j.session === this.sessionID)
    this.previewReady = false
    for (const pl of this.players.values()) { pl.video.pause(); pl.video.removeAttribute('src'); pl.video.load() }
    this.players = new Map()
    for (const s of this.stills.values()) s.close?.()
    this.stills = new Map(); this.waveforms = new Map(); this.waveformRequested = new Map(); this.waveformStatus = ''; this.faceCoverage = new Map()
    this.sessionID = M.uuid(); this.savedProject = null; this.projectURL = null; this.gestureStart = null
    this.clipboardCaptions = []; this.clipboardRegions = []; this.wholeOverlayTrack = false; this.drawMode = false; this.timelineZoom = 1
    const p = M.cloneProject(input)
    M.repairEditableTimes(p); M.migrateOverlayTimeline(p); M.separateOverlappingOverlays(p)
    this.selectedTrack = 'video'; this.selectedLane = 0; this.selectedCaption = null; this.selectedMedia = M.mediaList(p)[0].id
    this.speechNotes = []; this.restoring = true; this.project = p; this.restoring = false
    this.undoStack = []; this.redoStack = []; this.playhead = 0
    this.selectedClip = p.clips[0]?.id ?? null; this.selectedRegion = null; this.lastExport = null
    this.selectedClips = new Set(p.clips.slice(0, 1).map(c => c.id)); this.clipboardClips = []
    if (p.sourcePath) { this.refreshPreview(); this.scheduleRecovery() }
    this.changed(); this.timeChanged()
    if (p.sourcePath) await this.loadPreviewSources()
  }
  // Prepares a player (or a still bitmap) for every source file.
  async loadPreviewSources() {
    const p = this.project, session = this.sessionID
    if (p.isImage) {
      try {
        const bitmap = await loadImageBitmap(p.sourcePath)
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
        const small = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * scale)), resizeHeight: Math.max(1, Math.round(bitmap.height * scale)), resizeQuality: 'high' })
        bitmap.close()
        if (session !== this.sessionID) return small.close()
        this.stills.set(M.PRIMARY, small); this.previewReady = true
      } catch (e) { this.status = '미리보기를 만들 수 없습니다: ' + e.message }
      this.requestDraw(); this.changed(); return
    }
    await Promise.all(M.mediaList(p).map(m => this.preparePreview(m, session)))
  }
  async preparePreview(m, session = this.sessionID) {
    if (m.isImage) {
      if (this.stills.has(m.id)) return
      try {
        const bitmap = await loadImageBitmap(m.path)
        const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height))
        const small = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * scale)), resizeHeight: Math.max(1, Math.round(bitmap.height * scale)), resizeQuality: 'high' })
        bitmap.close()
        if (session !== this.sessionID) return small.close()
        this.stills.set(m.id, small); this.previewReady = true; this.requestDraw(); this.changed()
      } catch (e) { this.status = `미리보기를 만들 수 없습니다: ${M.mediaName(m)}` }
      return
    }
    if (this.players.has(m.id)) return
    const video = document.createElement('video')
    video.preload = 'auto'; video.playsInline = true
    const pl = { video, ready: false, media: m.id }
    this.players.set(m.id, pl)
    if (m.id === M.mediaList(this.project)[0].id) this.video = video
    video.addEventListener('seeked', () => { if (!this.playing) this.drawPreview() })
    video.addEventListener('loadeddata', () => { if (!this.playing) this.drawPreview() })
    video.addEventListener('error', () => {
      if (!pl.ready || !video.getAttribute('src')) return
      pl.ready = false; this.pause()
      this.status = `미리보기 재생 오류 · ${M.mediaName(m)} 원본이 이동·삭제되지 않았는지 확인하세요`; this.changed()
    })
    const tryPlay = url => new Promise(resolve => {
      const done = ok => { clearTimeout(timer); video.removeEventListener('loadeddata', good); video.removeEventListener('error', bad); resolve(ok) }
      const good = () => done(video.videoWidth > 0), bad = () => done(false)
      const timer = setTimeout(() => done(video.readyState >= 2 && video.videoWidth > 0), 8000)
      video.addEventListener('loadeddata', good); video.addEventListener('error', bad)
      video.src = url; video.load()
    })
    const cached = proxyPath(m)
    let ok = await tryPlay(fileURL(fs.existsSync(cached) ? cached : m.path))
    if (session !== this.sessionID) return
    if (!ok) {
      // Chromium cannot decode this codec (e.g. ProRes, some HEVC): build a local H.264 preview copy in the background.
      const job = this.jobs.start('proxy', { media: m }, { label: `미리보기 사본 · ${M.mediaName(m)}`, session })
      try { ok = await tryPlay(fileURL(await job.promise)) } catch (e) { if (!isCancel(e)) this.reportJobError(e, '미리보기 사본'); ok = false }
      if (session !== this.sessionID) return
      if (!ok) { this.status = `${M.mediaName(m)}: 미리보기를 재생할 수 없습니다. 분석과 내보내기는 계속 사용할 수 있습니다.`; this.changed(); return }
    }
    pl.ready = true; this.previewReady = true
    this.applyPlayerAudio(); this.showFrame(); this.changed()
  }
  begin(message) { this.busy = true; this.progress = 0; this.status = message; this.pause(); this.changed() }
  finish() { this.busy = false; this.changed() }
  fail(e) {
    this.busy = false
    if (isCancel(e)) this.status = '작업이 취소되었습니다'
    else { console.error(e); this.error = e?.message ?? String(e); this.status = '작업을 완료하지 못했습니다' }
    this.changed()
  }
  reportJobError(e, label) {
    if (isCancel(e)) { this.status = `${label} 취소됨`; this.changed(); return }
    if (e?.workerStack) ipcRenderer.send('app:log', `${label}: ${e.workerStack}`)
    this.error = `${label}: ${e?.message ?? e}`; this.status = `${label}을(를) 완료하지 못했습니다`; this.changed()
  }
  cancel() { this.jobs.cancelAll() }
  // Files that are used on the timeline must be unchanged since they were analysed.
  verifySource() {
    const used = M.mediaList(this.project).filter(m => this.project.isImage || this.project.clips.some(c => M.mediaOf(this.project, c) === m.id))
    for (const m of used) if (!stampMatches(m)) throw new StudioError(`원본 파일이 변경되었거나 이동했습니다: ${M.mediaName(m)}\n파일을 다시 불러와 분석하세요.`)
  }
  guardSource() { try { this.verifySource(); return true } catch (e) { this.error = e.message; this.changed(); return false } }

  // ---------- media library ----------
  // placement: 'append' (end of the main track), 'insert' (at the playhead, rippling), 'connect' (above, at the playhead), 'library'.
  async addMedia(files, placement = 'append') {
    if (!this.loaded) return this.openFiles(files)
    if (this.project.isImage) { this.error = '사진 한 장을 편집하는 프로젝트에는 파일을 추가할 수 없습니다. 파일 → 새 프로젝트에서 동영상으로 시작하세요.'; this.changed(); return }
    const session = this.sessionID, added = [], failed = []
    this.status = `미디어 ${files.length}개 확인 중`; this.changed()
    for (const file of files) {
      try {
        const existing = M.mediaList(this.project).find(m => samePath(m.path, file) && stampMatches(m))
        added.push(existing ?? await probeMedia(file))
      } catch (e) { failed.push(`${path.basename(file)}: ${e.message.split('\n')[0]}`) }
      if (session !== this.sessionID) return
    }
    if (added.length) {
      const ids = this.edit(p => {
        if (!p.media) p.media = [M.primaryMedia(p)]
        for (const m of added) if (!p.media.some(x => x.id === m.id)) p.media.push({ ...m, ...(m.isImage ? { fps: p.fps } : {}) })
        return placement === 'library' ? [] : this.placeClips(p, added.map(m => ({ id: M.uuid(), start: 0, end: m.isImage ? STILL_CLIP : m.duration, media: m.id })), placement)
      })
      if (ids.length) { this.selectedClips = new Set(ids); this.selectedClip = ids[0]; this.selectedTrack = 'video' }
      this.selectedMedia = added[added.length - 1].id
      for (const m of added) this.preparePreview(M.mediaById(this.project, m.id))
      this.refreshWaveform(); this.showFrame()
      const where = { append: '타임라인 끝에 추가', insert: '재생 위치에 삽입', connect: '위 트랙에 연결', library: '미디어 목록에 추가' }[placement]
      this.status = `미디어 ${added.length}개 ${where}` + (this.project.analysisComplete ? ' · 새 파일은 얼굴 분석을 다시 실행하세요' : '')
    }
    if (failed.length) this.error = `다음 파일을 추가하지 못했습니다:\n${failed.join('\n')}`
    this.changed()
  }
  // Places new clips on p; returns their ids.
  placeClips(p, clips, placement) {
    if (placement === 'connect') {
      M.enableVideoLanes(p)
      const total = clips.reduce((s, c) => s + M.clipDuration(c), 0), at = this.playhead
      const lanes = Math.max(p.videoLaneCount ?? 1, ...p.clips.map(c => (c.lane ?? 0) + 1))
      let lane = 1
      while (lane < lanes && M.timeline(p).some(e => (e.clip.lane ?? 0) === lane && e.start < at + total && e.end > at)) lane++
      p.videoLaneCount = Math.max(lanes, lane + 1)
      let cursor = at
      for (const c of clips) { p.clips.push({ ...c, lane, position: cursor }); cursor += M.clipDuration(c) }
      delete p.exportRange
      return clips.map(c => c.id)
    }
    if ((p.videoLaneCount ?? 1) > 1) {
      // Multi-track timeline: work on the main track (lane 0) and ripple only that track.
      const total = clips.reduce((s, c) => s + M.clipDuration(c), 0)
      const mainEnd = Math.max(0, ...M.timeline(p).filter(e => (e.clip.lane ?? 0) === 0).map(e => e.end))
      let at = placement === 'insert' ? this.playhead : mainEnd
      if (placement === 'insert') {
        const hit = M.timeline(p).find(e => (e.clip.lane ?? 0) === 0 && at > e.start && at < e.end)
        if (hit) M.splitTimeline(p, at, hit.id)
        for (const c of p.clips) if ((c.lane ?? 0) === 0 && (c.position ?? 0) >= at - 0.000001) c.position += total
      }
      for (const c of clips) { p.clips.push({ ...c, lane: 0, position: at }); at += M.clipDuration(c) }
      delete p.exportRange
      return clips.map(c => c.id)
    }
    if (placement === 'insert') return M.insertTimelineClips(p, clips, this.playhead)
    p.clips.push(...clips); delete p.exportRange
    return clips.map(c => c.id)
  }
  placeMedia(id, placement) {
    const m = M.mediaList(this.project).find(x => x.id === id)
    if (!m || !this.canEditTimeline) return
    const ids = this.edit(p => this.placeClips(p, [{ id: M.uuid(), start: 0, end: m.isImage ? STILL_CLIP : m.duration, media: m.id }], placement))
    this.selectedClips = new Set(ids); this.selectedClip = ids[0]; this.selectedTrack = 'video'
    this.status = `${M.mediaName(m)} · ${{ append: '끝에 추가', insert: '재생 위치에 삽입', connect: '위 트랙에 연결' }[placement]}`; this.showFrame(); this.changed()
  }
  // Drop from the media library: main track inserts at the nearest cut, upper tracks connect at the drop time.
  dropMedia(id, lane, time) {
    const m = M.mediaList(this.project).find(x => x.id === id)
    if (!m || !this.canEditTimeline) return
    const clip = { id: M.uuid(), start: 0, end: m.isImage ? STILL_CLIP : m.duration, media: m.id }
    const multi = (this.project.videoLaneCount ?? 1) > 1
    if (lane > 0 || multi) {
      const p = M.cloneProject(this.project); M.enableVideoLanes(p)
      p.videoLaneCount = Math.max(p.videoLaneCount ?? 1, lane + 1, 2)
      const at = Math.max(0, time), end = at + M.clipDuration(clip)
      if (M.timeline(p).some(e => (e.clip.lane ?? 0) === lane && e.start < end && e.end > at)) { this.status = '놓은 위치에 컷이 있습니다. 빈 곳이나 위 트랙에 놓으세요.'; this.changed(); return }
      p.clips.push({ ...clip, lane, position: at }); delete p.exportRange
      this.commitTimeline(p, at)
    } else {
      const cuts = [0, ...M.timeline(this.project).map(e => e.end)]
      const at = cuts.reduce((best, t) => Math.abs(t - time) < Math.abs(best - time) ? t : best, 0)
      const p = M.cloneProject(this.project); M.insertTimelineClips(p, [clip], at); this.commitTimeline(p, at)
    }
    this.selectedClips = new Set([clip.id].filter(x => this.project.clips.some(c => c.id === x)))
    const placed = this.project.clips.find(c => c.id === clip.id) ?? this.project.clips.find(c => M.mediaOf(this.project, c) === m.id)
    if (placed) { this.selectedClips = new Set([placed.id]); this.selectedClip = placed.id; this.selectedTrack = 'video' }
    this.status = `${M.mediaName(m)} 배치`; this.changed()
  }
  async removeMedia(id) {
    const p = this.project, m = M.mediaList(p).find(x => x.id === id)
    if (!m || !p.media) return
    if (id === p.media[0].id) { this.error = '첫 번째(기준) 미디어는 목록에서 뺄 수 없습니다.'; this.changed(); return }
    const used = p.clips.filter(c => M.mediaOf(p, c) === id).length
    if (used) {
      const r = await dialogs.message({ type: 'warning', message: `${M.mediaName(m)}을(를) 프로젝트에서 뺄까요?`, detail: `타임라인의 컷 ${used}개와 이 파일의 얼굴 분석 결과도 함께 삭제됩니다.`, buttons: ['삭제', '취소'], defaultId: 1, cancelId: 1, noLink: true })
      if (r !== 0) return
    }
    this.edit(q => { q.clips = q.clips.filter(c => M.mediaOf(q, c) !== id); q.faces = q.faces.filter(f => M.mediaOf(q, f) !== id); q.media = q.media.filter(x => x.id !== id); delete q.exportRange })
    const pl = this.players.get(id); if (pl) { pl.video.pause(); pl.video.removeAttribute('src'); this.players.delete(id) }
    this.stills.get(id)?.close?.(); this.stills.delete(id)
    this.playhead = Math.min(this.playhead, this.editedDuration); this.showFrame(); this.changed()
  }

  // ---------- analysis / captions (background jobs) ----------
  async analyze() {
    if (!this.loaded || this.busy) return
    if (this.jobs.running('faces').length) { this.status = '얼굴 분석이 이미 진행 중입니다'; this.changed(); return }
    if (!this.guardSource()) return
    const session = this.sessionID, snapshot = M.cloneProject(this.project)
    const job = this.jobs.start('faces', { project: snapshot, options: { ...this.faceOptions } }, { session })
    this.status = '얼굴 분석 중 · 분석하는 동안에도 편집할 수 있습니다'; this.changed()
    // Speech runs in parallel (GPU) while faces use the CPU.
    if (this.autoCaptions && !snapshot.isImage && !snapshot.captions.length && !this.jobs.running('speech').length) this.transcribe()
    try {
      const faces = await job.promise
      if (session !== this.sessionID) return
      this.edit(p => { p.faces = faces; p.analysisComplete = true; p.maskApplied = false })
      this.status = `인물 후보 ${faces.length}개 발견 · 선택 후 마스킹 적용`; this.changed()
    } catch (e) { if (session === this.sessionID) this.reportJobError(e, '얼굴 분석') }
  }
  async transcribe(testOnly = false) {
    if (!this.loaded || this.project.isImage || this.busy) return
    if (this.jobs.running('speech').length) { this.status = '자동 자막이 이미 진행 중입니다'; this.changed(); return }
    if (!this.guardSource()) return
    const session = this.sessionID, snapshot = M.cloneProject(this.project), before = JSON.stringify(this.project.captions)
    if (testOnly) {
      const hit = this.current
      if (!hit) { this.status = '테스트할 영상 컷 안에 재생 헤드를 놓아 주세요.'; this.changed(); return }
      snapshot.clips = [{ id: M.uuid(), start: hit.time, end: Math.min(hit.entry.clip.end, hit.time + 15), media: hit.entry.clip.media }]; delete snapshot.videoLaneCount
    }
    this.speechNotes = []
    const job = this.jobs.start('speech', { project: snapshot, locale: this.language, options: { ...this.speechOptions } }, { label: testOnly ? '15초 시험 인식' : '자동 자막', session })
    try {
      const report = await job.promise
      if (session !== this.sessionID) return
      if (testOnly) {
        this.speechNotes = [...report.warnings, ...report.captions.map(c => `${M.timecode(c.start)} · ${c.text}`)]
        this.status = '15초 이내 인식 테스트 완료 · 기존 자막은 유지됩니다'; this.tab = 'captions'; this.changed(); return
      }
      const captions = M.mapSourceCaptions(this.project, report.captions)
      let mode = 'replace'
      // Captions edited while recognition ran are never overwritten silently.
      if (JSON.stringify(this.project.captions) !== before && this.project.captions.length) {
        const r = await dialogs.message({ type: 'question', message: '자동 자막이 완료되었습니다. 그 사이 자막이 수정되었습니다.', detail: `새로 인식한 자막 ${captions.length}개를 어떻게 적용할까요?`, buttons: ['기존 자막 교체', '기존 자막 뒤에 추가', '결과 버리기'], defaultId: 1, cancelId: 2, noLink: true })
        mode = ['replace', 'append', 'discard'][r]
      }
      if (mode === 'discard') { this.status = '자동 자막 결과를 적용하지 않았습니다'; this.changed(); return }
      this.edit(p => { p.captions = mode === 'append' ? [...p.captions, ...captions] : captions; M.separateOverlappingOverlays(p) })
      this.speechNotes = report.warnings; this.status = summary(report); this.tab = 'captions'; this.changed()
    } catch (e) { if (session === this.sessionID) this.reportJobError(e, testOnly ? '시험 인식' : '자동 자막') }
  }
  applyMasks() { this.edit(p => { p.maskApplied = true }); this.status = `선택한 인물 후보 ${this.project.faces.filter(f => f.selected).length}개에 마스킹 적용`; this.changed() }
  mergeSelected() {
    const faces = this.project.faces.filter(f => f.selected)
    if (faces.length < 2) return
    // Keep simultaneous detections as separate tracks: merging identities must not lose a box.
    const name = `${faces[0].name} · 병합 그룹`, ids = new Set(faces.map(f => f.id))
    this.edit(p => { for (const f of p.faces) if (ids.has(f.id)) f.name = name })
    this.status = '선택한 후보를 같은 이름의 그룹으로 묶었습니다. 모든 검출 영역은 유지됩니다.'; this.changed()
  }
  toggleFace(id, selected) {
    const face = this.project.faces.find(f => f.id === id)
    if (!face) return
    this.edit(p => { for (const f of p.faces) if (f.id === id || (face.name.includes('· 병합 그룹') && f.name === face.name)) f.selected = selected })
  }
  setAllFaces(selected) { this.edit(p => { for (const f of p.faces) f.selected = selected }) }
  addRegion(rect) {
    if (!(rect.width > 0.008 && rect.height > 0.008)) return
    const r = { id: M.uuid(), name: `영역 ${this.project.regions.length + 1}`, enabled: true, start: 0, end: this.project.isImage ? this.project.duration : this.editedDuration, rect, keyframes: [] }
    this.edit(p => { p.regions.push(r); M.separateOverlappingOverlays(p) })
    this.selectOverlay(r.id, true); this.drawMode = false; this.tab = 'regions'; this.changed()
  }
  addKeyframe() {
    const i = this.project.regions.findIndex(r => r.id === this.selectedRegion)
    if (i < 0) return
    const source = this.overlayTime, rect = M.regionRectAt(this.project.regions[i], source)
    this.edit(p => { const r = p.regions[i]; r.keyframes = r.keyframes.filter(k => Math.abs(k.time - source) >= 0.02); r.keyframes.push({ id: M.uuid(), time: source, rect }) })
  }
  addCaption() {
    const a = Math.min(this.overlayTime, Math.max(0, this.editedDuration - 0.5))
    const c = { id: M.uuid(), start: a, end: Math.min(this.editedDuration, a + 3), text: '새 자막' }
    if (this.selectedTrack === 'captions') c.lane = this.selectedLane
    this.edit(p => { p.captions.push(c); M.separateOverlappingOverlays(p) })
    this.selectOverlay(c.id, false)
  }

  // ---------- preview & playback ----------
  attachCanvas(canvas) { this.canvas = canvas; this.requestDraw() }
  requestDraw() {
    if (this.drawQueued) return
    this.drawQueued = true
    requestAnimationFrame(() => { this.drawQueued = false; if (!this.playing) this.drawPreview() })
  }
  clipAt(hit) { return hit ? (this.project.clips[hit.entry.index] ?? hit.entry.clip) : null }
  fadeAt(clip, src) { return Math.max(0, Math.min(1, clip.fadeIn ? (src - clip.start) / clip.fadeIn : 1, clip.fadeOut ? (clip.end - src) / clip.fadeOut : 1)) }
  drawPreview() {
    const canvas = this.canvas
    if (!canvas) return
    const ctx = canvas.getContext('2d'), p = this.project, w = canvas.width, h = canvas.height
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h)
    if (!this.loaded) return
    if (p.isImage) {
      const still = this.stills.get(M.PRIMARY)
      if (!still) return
      ctx.drawImage(still, 0, 0, w, h)
      this.renderer.renderFrame(canvas, canvas, p, 0, 0, false)
      return
    }
    const hit = this.current, clip = this.clipAt(hit)
    let time = -1, mediaId = null
    if (hit && !clip.disabled) {
      const m = M.mediaById(p, hit.entry.clip.media), source = m.isImage ? this.stills.get(m.id) : this.players.get(m.id)?.video
      const ready = m.isImage ? !!source : this.players.get(m.id)?.ready && source.readyState >= 2
      time = hit.time; mediaId = m.id
      if (ready) {
        // Each file is fitted into the project frame; colour and fades are previewed with canvas filters.
        const f = M.fitRect(m, p), sx = w / p.width, sy = h / p.height
        const b = clip.brightness ?? 0, c = clip.contrast ?? 1, s = clip.saturation ?? 1
        ctx.save()
        if (b || c !== 1 || s !== 1) ctx.filter = `brightness(${(1 + b).toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`
        ctx.globalAlpha = this.fadeAt(clip, hit.time)
        ctx.drawImage(source, f.x * sx, f.y * sy, f.w * sx, f.h * sy)
        ctx.restore()
      }
    }
    this.renderer.renderFrame(canvas, canvas, p, time, this.playhead, false, mediaId)
  }
  showFrame() {
    if (this.project.isImage) { this.requestDraw(); return }
    const hit = this.current
    if (hit) {
      const m = M.mediaById(this.project, hit.entry.clip.media), pl = this.players.get(m.id)
      if (!m.isImage && pl?.ready) {
        const v = pl.video, target = Math.min(hit.time, Math.max(0, (v.duration || hit.time) - 0.001))
        if (Math.abs(v.currentTime - target) > 0.0005) { v.currentTime = target; return }
      }
    }
    this.requestDraw()
  }
  seek(time) {
    if (!Number.isFinite(time)) return
    this.playhead = Math.min(this.editedDuration, Math.max(0, time))
    if (this.playing) this.enterSegment(this.playhead); else this.showFrame()
    this.timeChanged()
  }
  seekSource(time, mediaId = null) {
    const t = M.timelineTime(this.project, time, this.selectedClip, mediaId)
    if (t != null) this.seek(t); else { this.status = '이 원본 시점은 현재 편집 타임라인에 포함되어 있지 않습니다'; this.changed() }
  }
  pause() {
    clearInterval(this.reverseTimer); this.reverseTimer = null
    if (!this.playing) { for (const pl of this.players.values()) pl.video.pause(); return }
    this.playing = false; this.rate = 1
    for (const pl of this.players.values()) { pl.video.pause(); pl.video.playbackRate = 1 }
    cancelAnimationFrame(this.raf); this.segment = null; this.activePlayer = null
    this.showFrame(); this.changed(); this.timeChanged()
  }
  togglePlay() { if (this.playing || this.reverseTimer) this.pause(); else this.play(1) }
  play(rate = 1) {
    if (!this.canEditTimeline || !this.previewReady || !this.project.clips.length) return
    clearInterval(this.reverseTimer); this.reverseTimer = null
    if (!this.playing && this.playhead >= this.editedDuration - 0.015) this.seek(0)
    this.rate = rate
    if (this.playing) { if (this.activePlayer) this.activePlayer.video.playbackRate = rate; this.changed(); return }
    this.playing = true; this.enterSegment(this.playhead); this.raf = requestAnimationFrame(this.loop); this.changed()
  }
  // J/K/L shuttle: L speeds up (1×, 2×, 4×), J plays backwards (stepped seeks), K stops.
  shuttle(direction) {
    if (direction === 0) return this.pause()
    if (direction > 0) return this.play(this.playing && this.rate >= 1 ? Math.min(4, this.rate * 2) : 1)
    const speed = this.reverseTimer ? Math.min(4, (this.reverseSpeed ?? 1) * 2) : 1
    this.pause()
    this.reverseSpeed = speed
    const started = performance.now(), from = this.playhead
    this.reverseTimer = setInterval(() => {
      const t = from - (performance.now() - started) / 1000 * speed
      if (t <= 0) { this.seek(0); this.pause(); return }
      this.seek(t)
    }, 80)
    this.changed()
  }
  applyPlayerAudio(clip = null) {
    for (const pl of this.players.values()) pl.video.muted = true
    const pl = this.activePlayer
    if (!pl || !clip) return
    pl.video.muted = !!(this.project.export.muted || clip.muted || clip.disabled)
    pl.video.volume = Math.min(1, Math.pow(10, (clip.volume ?? 0) / 20))
  }
  enterSegment(time) {
    const hit = M.entryAt(this.visible, time)
    this.segment = hit?.entry ?? null; this.clockStart = performance.now(); this.clockTime = time
    const previous = this.activePlayer
    this.activePlayer = null
    if (hit) {
      const clip = this.clipAt(hit), m = M.mediaById(this.project, hit.entry.clip.media), pl = this.players.get(m.id)
      if (!m.isImage && !clip.disabled && pl?.ready) {
        this.activePlayer = pl
        const v = pl.video
        if (Math.abs(v.currentTime - hit.time) > 0.08) v.currentTime = hit.time
        v.playbackRate = this.rate
        this.applyPlayerAudio(clip)
        v.play().catch(() => {})
      }
    }
    if (previous && previous !== this.activePlayer) previous.video.pause()
    if (!this.activePlayer) this.applyPlayerAudio()
  }
  loop() {
    if (!this.playing) return
    const duration = this.editedDuration, e = this.segment, pl = this.activePlayer
    let t
    if (e && pl) {
      const v = pl.video, vt = v.currentTime
      t = v.seeking ? this.playhead : e.start + (vt - e.clip.start)
      if (!v.seeking && (vt >= e.clip.end - 0.5 / this.project.fps || v.ended)) {
        t = e.end
        if (t >= duration - 0.015) { this.playhead = duration; this.pause(); return }
        this.playhead = t; this.enterSegment(t); this.timeChanged(); this.raf = requestAnimationFrame(this.loop); return
      }
    } else {
      // Gaps, photos and disabled clips advance on the clock.
      t = this.clockTime + (performance.now() - this.clockStart) / 1000 * this.rate
      const boundary = e ? e.end : this.visible.find(x => x.start >= this.clockTime - 0.000001)?.start
      if (boundary != null && t >= boundary) { t = boundary; if (t < duration - 0.015) this.enterSegment(t) }
    }
    if (t >= duration - 0.015) { this.playhead = duration; this.pause(); return }
    this.playhead = Math.max(0, t); this.drawPreview(); this.timeChanged()
    this.raf = requestAnimationFrame(this.loop)
  }
  // Frame and edit-point navigation (←/→, Shift+←/→, ↑/↓ cut boundaries, Home/End).
  step(frames) { this.pause(); this.seek(Math.round((this.playhead + frames * this.frame) / this.frame) * this.frame) }
  editPoints() {
    const points = new Set([0, this.editedDuration])
    for (const e of M.timeline(this.project)) { points.add(e.start); points.add(e.end) }
    return [...points].sort((a, b) => a - b)
  }
  jumpEdit(direction) {
    this.pause()
    const pts = this.editPoints(), eps = this.frame / 2
    const target = direction > 0 ? pts.find(t => t > this.playhead + eps) : [...pts].reverse().find(t => t < this.playhead - eps)
    if (target != null) this.seek(target)
  }
  // Snaps a timeline time to nearby edit points, markers and the playhead (tolerance in seconds).
  snap(time, tolerance, exclude = null) {
    if (!this.snapping || !Number.isFinite(time)) return time
    let best = time, bestDist = tolerance
    const consider = t => { const d = Math.abs(t - time); if (d < bestDist) { best = t; bestDist = d } }
    consider(this.playhead)
    for (const e of M.timeline(this.project)) if (e.id !== exclude) { consider(e.start); consider(e.end) }
    for (const m of this.project.markers ?? []) consider(m.time)
    for (const c of this.project.captions) if (c.id !== exclude) { consider(c.start); consider(c.end) }
    for (const r of this.project.regions) if (r.id !== exclude) { consider(r.start); consider(r.end) }
    return best
  }
  setZoom(value) { this.timelineZoom = Math.max(1, Math.min(200, value)); this.changed() }
  toggleSnapping() { this.snapping = !this.snapping; this.status = this.snapping ? '스냅 켬' : '스냅 끔'; this.changed() }

  // ---------- markers & clip attributes ----------
  addMarker() {
    if (!this.canEditTimeline) return
    const t = this.playhead
    if ((this.project.markers ?? []).some(m => Math.abs(m.time - t) < this.frame / 2)) return
    this.edit(p => { p.markers = [...(p.markers ?? []), { id: M.uuid(), time: t, name: `마커 ${(p.markers?.length ?? 0) + 1}` }].sort((a, b) => a.time - b.time) })
    this.status = `마커 추가 · ${M.timecode(t)}`; this.changed()
  }
  deleteMarker(id) { this.edit(p => { p.markers = (p.markers ?? []).filter(m => m.id !== id); if (!p.markers.length) delete p.markers }) }
  renameMarker(id, name) { this.edit(p => { const m = (p.markers ?? []).find(x => x.id === id); if (m) m.name = name }) }
  get selectedClipObjects() { return this.project.clips.filter(c => this.selectedClips.has(c.id)) }
  setClipAttrs(patch) {
    const ids = this.selectedClips
    if (!ids.size) return
    this.edit(p => { for (const c of p.clips) if (ids.has(c.id)) { for (const [k, v] of Object.entries(patch)) { if (v == null || v === false) delete c[k]; else c[k] = v } } })
    this.requestDraw(); this.applyPlayerAudio(this.clipAt(this.current))
  }
  toggleClipEnabled() {
    if (!this.canDeleteClips) return
    const disable = !this.selectedClipObjects.every(c => c.disabled)
    this.setClipAttrs({ disabled: disable })
    this.status = disable ? '선택 컷 사용 안 함 (V)' : '선택 컷 다시 사용'; this.changed()
  }
  // Delete without closing the gap (Shift+Delete in Final Cut Pro).
  liftClips() {
    if (!this.canDeleteClips) return
    const ids = this.selectedClips
    // Keeping the gap needs positioned clips, i.e. the multi-track timeline.
    this.edit(p => { M.enableVideoLanes(p); p.videoLaneCount = Math.max(p.videoLaneCount ?? 1, 2); p.clips = p.clips.filter(c => !ids.has(c.id)); delete p.exportRange })
    this.selectedClips = new Set(); this.selectedClip = null; this.status = '선택 컷 삭제 · 빈 구간 유지'; this.showFrame(); this.changed()
  }
  // Trim the clip under the playhead so it starts/ends here (Option-[ / Option-]).
  trimToPlayhead(edge) {
    if (!this.canEditTimeline) return
    const hit = M.timeline(this.project).find(e => (e.clip.lane ?? 0) === this.selectedLane && this.playhead > e.start && this.playhead < e.end)
    if (!hit) { this.status = '재생 위치가 컷 안에 있어야 합니다'; this.changed(); return }
    const src = hit.clip.start + this.playhead - hit.start
    if (edge < 0) {
      const p = M.cloneProject(this.project), c = p.clips[hit.index], start = hit.start
      if (c.position != null) c.position = this.playhead
      c.start = src; delete p.exportRange
      this.commitTimeline(p, c.position != null ? this.playhead : start)
    } else this.trimClip(hit.id, null, src)
    this.status = edge < 0 ? '컷 시작을 재생 위치로 자름' : '컷 끝을 재생 위치로 자름'; this.changed()
  }

  // ---------- selection & timeline edits ----------
  focusTimeline() { if (activeTextInput()) document.activeElement.blur() }
  selectClip(id, extending = false) {
    this.focusTimeline(); this.selectedTrack = 'video'; this.selectedLane = this.project.clips.find(c => c.id === id)?.lane ?? 0; this.selectedClip = id
    const next = new Set(this.selectedClips)
    if (extending) { if (next.has(id)) next.delete(id); else next.add(id) } else { next.clear(); next.add(id) }
    this.selectedClips = next; this.changed()
  }
  beginTimelineGesture() { if (this.gestureStart == null) this.gestureStart = this.project }
  endTimelineGesture() {
    const initial = this.gestureStart
    if (initial && !M.projectsEqual(initial, this.project)) { this.undoStack.push(initial); if (this.undoStack.length > 40) this.undoStack.shift(); this.redoStack = [] }
    this.edit(p => M.separateOverlappingOverlays(p))
    this.synchronizeSelectedLane(); this.gestureStart = null
    if (initial) { this.schedulePreview(); this.scheduleRecovery() }
    this.changed()
  }
  commitTimeline(p, seekTo = null) {
    this.pause(); this.project = p
    const ids = new Set(p.clips.map(c => c.id))
    this.selectedClips = new Set([...this.selectedClips].filter(id => ids.has(id)))
    if (!ids.has(this.selectedClip)) this.selectedClip = p.clips[0]?.id ?? null
    this.playhead = Math.min(M.editedDuration(p), Math.max(0, seekTo ?? this.playhead))
    this.showFrame(); this.timeChanged(); this.changed()
  }
  split() {
    if (!this.canEditTimeline) return
    if (this.selectedTrack === 'regions' || this.selectedTrack === 'captions') return this.splitOverlay()
    const p = M.cloneProject(this.project)
    const entry = M.timeline(p).find(e => (e.clip.lane ?? 0) === this.selectedLane && this.playhead > e.start && this.playhead < e.end)
    const id = entry ? M.splitTimeline(p, this.playhead, entry.id) : null
    if (!id) { this.status = '분할할 컷 안쪽으로 재생 헤드를 이동하세요'; this.changed(); return }
    this.commitTimeline(p); this.selectClip(id); this.status = '현재 위치에서 컷 분할'
  }
  copyClips() {
    if (!this.canDeleteClips) return
    this.clipboardClips = this.project.clips.filter(c => this.selectedClips.has(c.id))
    this.status = `컷 ${this.clipboardClips.length}개 복사 · 재생 위치에 붙여넣을 수 있습니다`; this.changed()
  }
  cutClips() { if (!this.canDeleteClips) return; this.copyClips(); this.deleteClip() }
  pasteClips() {
    if (!this.canEditTimeline || !this.clipboardClips.length) return
    const p = M.cloneProject(this.project)
    // Clips copied from a file that has since been removed cannot be pasted.
    const known = new Set(M.mediaList(p).map(m => m.id)), source = this.clipboardClips.filter(c => c.media == null || known.has(c.media))
    if (!source.length) { this.status = '붙여넣을 컷의 원본이 프로젝트에 없습니다'; this.changed(); return }
    let ids
    if ((p.videoLaneCount ?? 1) > 1) {
      let cursor = this.playhead
      const copies = source.map(c => { const v = { id: M.uuid(), start: c.start, end: c.end, ...M.clipAttrs(c), lane: this.selectedLane, position: cursor }; cursor += M.clipDuration(c); return v })
      if (M.timeline(p).some(e => (e.clip.lane ?? 0) === this.selectedLane && e.start < cursor && e.end > this.playhead)) { this.status = '붙여넣을 위치에 컷이 있습니다. 빈 영상 트랙을 선택하세요.'; this.changed(); return }
      p.clips.push(...copies); delete p.exportRange; ids = copies.map(c => c.id)
    } else ids = M.insertTimelineClips(p, source, this.playhead)
    this.commitTimeline(p)
    this.selectedClips = new Set(ids); this.selectedClip = ids[0]; this.focusTimeline(); this.status = '재생 위치에 컷 붙여넣기 · 빈 공간 없이 연결'; this.changed()
  }
  deleteClip() {
    if (!this.canDeleteClips) return
    const destination = M.timeline(this.project).find(e => this.selectedClips.has(e.id))?.start ?? this.playhead
    const p = M.cloneProject(this.project); M.removeTimelineClips(p, this.selectedClips); this.commitTimeline(p, destination)
    this.selectedClips = new Set(); this.selectedClip = null; this.status = '선택 컷 삭제 · 뒤의 컷을 앞으로 붙였습니다'; this.changed()
  }
  selectAllClips() {
    if (!this.canEditTimeline) return
    if (this.selectedTrack === 'captions') { this.wholeOverlayTrack = true; this.selectedCaption = this.project.captions.find(c => (c.lane ?? 0) === this.selectedLane)?.id ?? null; this.changed(); return }
    if (this.selectedTrack === 'regions') { this.wholeOverlayTrack = true; this.selectedRegion = this.project.regions.find(r => (r.lane ?? 0) === this.selectedLane)?.id ?? null; this.changed(); return }
    this.selectedTrack = 'video'; this.selectedClips = new Set(this.project.clips.filter(c => (c.lane ?? 0) === this.selectedLane).map(c => c.id)); this.selectedClip = this.project.clips[0]?.id ?? null; this.focusTimeline(); this.changed()
  }
  moveClip(id, target) {
    if ((this.project.videoLaneCount ?? 1) > 1) {
      const entry = M.timeline(this.project).find(e => e.id === target)
      return this.moveItem(id, 'video', entry?.clip.lane ?? this.selectedLane, entry?.start ?? this.editedDuration)
    }
    if (!this.canEditTimeline) return
    const p = M.cloneProject(this.project); M.moveTimelineClip(p, id, target)
    const t = M.timeline(p).find(e => e.id === id)?.start ?? 0
    this.commitTimeline(p, t); this.selectClip(id); this.status = '컷 순서 변경'
  }
  moveSelected(direction) {
    const p = this.project
    if (this.selectedTrack === 'captions') { const c = p.captions.find(c => c.id === this.selectedCaption); if (c) this.editOverlayTime(c.id, false, { start: c.start, end: c.end }, direction / p.fps, 0); return }
    if (this.selectedTrack === 'regions') { const r = p.regions.find(r => r.id === this.selectedRegion); if (r) this.editOverlayTime(r.id, true, { start: r.start, end: r.end }, direction / p.fps, 0); return }
    if ((p.videoLaneCount ?? 1) > 1 && this.selectedClip) {
      const entry = M.timeline(p).find(e => e.id === this.selectedClip)
      if (entry) return this.moveItem(entry.id, 'video', entry.clip.lane ?? 0, entry.start + direction / p.fps)
    }
    const index = p.clips.findIndex(c => c.id === this.selectedClip)
    if (index < 0) return
    if (direction < 0 && index > 0) this.moveClip(this.selectedClip, p.clips[index - 1].id)
    if (direction > 0 && index < p.clips.length - 1) this.moveClip(this.selectedClip, index + 2 < p.clips.length ? p.clips[index + 2].id : null)
  }
  trimClip(id, start = null, end = null) {
    const index = this.project.clips.findIndex(c => c.id === id)
    if (!this.canEditTimeline || index < 0) return
    const old = this.project.clips[index], p = M.cloneProject(this.project), c = p.clips[index]
    const limit = M.mediaById(p, c.media).duration
    const minimum = Math.min(1 / this.project.fps, limit)
    if (start != null && Number.isFinite(start)) c.start = Math.max(0, Math.min(c.end - minimum, start))
    if (end != null && Number.isFinite(end)) c.end = Math.min(limit, Math.max(c.start + minimum, end))
    if (old.position != null) {
      const lane = old.lane ?? 0, position = old.position, tl = M.timeline(this.project)
      const prev = Math.max(0, ...tl.filter(e => e.id !== id && (e.clip.lane ?? 0) === lane && e.end <= position).map(e => e.end))
      const next = Math.min(Infinity, ...tl.filter(e => e.id !== id && (e.clip.lane ?? 0) === lane && e.start >= position + M.clipDuration(old)).map(e => e.start))
      c.start = Math.max(c.start, old.start - (position - prev))
      c.position = position + c.start - old.start
      c.end = Math.min(c.end, old.start + next - position)
    }
    delete p.exportRange; this.commitTimeline(p)
  }
  markIn() { this.setExportRange(this.playhead, this.project.exportRange?.end ?? this.editedDuration) }
  markOut() { this.setExportRange(this.project.exportRange?.start ?? 0, this.playhead) }
  setExportRange(start, end) {
    const d = this.editedDuration
    if (!this.canEditTimeline || !(d > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return
    const a = Math.max(0, Math.min(start, d)), b = Math.max(0, Math.min(end, d))
    if (b - a < Math.min(1 / this.project.fps, d)) { this.status = '종료 지점은 시작 지점보다 최소 한 프레임 뒤여야 합니다'; this.changed(); return }
    this.edit(p => { p.exportRange = { start: a, end: b } })
  }
  clearExportRange() { this.edit(p => { delete p.exportRange }) }
  exportSelectedClips() {
    const p = this.project
    if (this.selectedTrack === 'captions') { const c = p.captions.find(c => c.id === this.selectedCaption); if (c) this.setExportRange(c.start, c.end); return }
    if (this.selectedTrack === 'regions') { const r = p.regions.find(r => r.id === this.selectedRegion); if (r) this.setExportRange(r.start, r.end); return }
    const entries = M.timeline(p).filter(e => this.selectedClips.has(e.id))
    if (entries.length) this.setExportRange(Math.min(...entries.map(e => e.start)), Math.max(...entries.map(e => e.end)))
  }
  deleteMarkedRange() {
    const range = this.project.exportRange
    if (!this.canEditTimeline || !range) return
    const lane = this.selectedLane
    const slice = (list, extra = () => ({})) => list.flatMap(x => {
      if ((x.lane ?? 0) !== lane || !(x.end > range.start && x.start < range.end)) return [x]
      const parts = []
      if (x.start < range.start) parts.push({ ...x, end: range.start })
      if (x.end > range.end) parts.push({ ...x, id: M.uuid(), start: range.end, ...extra(x) })
      return parts
    })
    if (this.selectedTrack === 'captions' || this.selectedTrack === 'regions') {
      this.edit(p => { if (this.selectedTrack === 'captions') p.captions = slice(p.captions); else p.regions = slice(p.regions) })
      this.status = '선택 트랙의 지정 구간만 삭제했습니다'; this.changed(); return
    }
    if ((this.project.videoLaneCount ?? 1) > 1) {
      const p = M.cloneProject(this.project)
      p.clips = M.timeline(p).flatMap(e => {
        if ((e.clip.lane ?? 0) !== lane || !(e.end > range.start && e.start < range.end)) return [e.clip]
        const parts = []
        if (e.start < range.start) parts.push({ ...e.clip, end: e.clip.start + range.start - e.start })
        if (e.end > range.end) parts.push({ ...e.clip, id: M.uuid(), start: e.clip.start + range.end - e.start, position: range.end })
        return parts
      })
      delete p.exportRange; this.commitTimeline(p); return
    }
    const p = M.cloneProject(this.project); M.deleteTimelineRange(p, range); this.commitTimeline(p, range.start)
    this.selectedClips = new Set(); this.selectedClip = null; this.status = '지정 구간 삭제 · 뒤의 컷을 앞으로 붙였습니다'; this.changed()
  }
  editOverlayTime(id, region, original, delta, edge) {
    if (!Number.isFinite(delta)) return
    const d = this.editedDuration, minimum = Math.min(1 / Math.max(1, this.project.fps), original.end - original.start)
    let a = original.start, b = original.end
    if (edge === 0) { const shift = Math.max(-a, Math.min(Math.max(d, original.end) - b, delta)); a += shift; b += shift }
    else if (edge < 0) a = Math.max(0, Math.min(b - minimum, a + delta))
    else b = Math.min(Math.max(d, original.end), Math.max(a + minimum, b + delta))
    this.edit(p => {
      if (region) {
        const r = p.regions.find(r => r.id === id)
        if (r) { const shift = a - r.start; if (edge === 0) r.keyframes = r.keyframes.map(k => ({ ...k, time: Math.max(0, k.time + shift) })); r.start = a; r.end = b }
      } else { const c = p.captions.find(c => c.id === id); if (c) { c.start = a; c.end = b } }
      if (this.gestureStart == null) M.separateOverlappingOverlays(p)
    })
    this.synchronizeSelectedLane()
  }
  editRegionRect(id, rect) {
    const i = this.project.regions.findIndex(r => r.id === id)
    if (i < 0) return
    const time = this.overlayTime
    this.edit(p => {
      const r = p.regions[i]
      if (!r.keyframes.length) r.rect = rect
      else { r.keyframes = r.keyframes.filter(k => Math.abs(k.time - time) >= 0.02); r.keyframes.push({ id: M.uuid(), time, rect }) }
    })
  }
  editCommand(command) {
    if (activeTextInput()) { document.execCommand(command === 'delete' ? 'delete' : command); return }
    const map = { cut: () => this.editSelection('cut'), copy: () => this.editSelection('copy'), paste: () => this.editSelection('paste'), delete: () => this.editSelection('delete'), selectAll: () => this.selectAllClips(), undo: () => this.undo(), redo: () => this.redo() }
    if (!this.busy) map[command]?.()
  }
  undo() { this.focusTimeline(); const p = this.undoStack.pop(); if (!p) return; this.redoStack.push(this.project); this.restoreHistory(p) }
  redo() { this.focusTimeline(); const p = this.redoStack.pop(); if (!p) return; this.undoStack.push(this.project); this.restoreHistory(p) }
  restoreHistory(p) {
    this.pause(); this.restoring = true; this.project = p; this.restoring = false
    this.playhead = Math.min(this.playhead, M.editedDuration(p))
    const ids = new Set(p.clips.map(c => c.id))
    this.selectedClips = new Set([...this.selectedClips].filter(id => ids.has(id))); this.selectedClip = [...this.selectedClips][0] ?? null
    this.selectedLane = Math.max(0, Math.min(this.selectedLane, this.laneCount(this.selectedTrack) - 1))
    if (!p.regions.some(r => r.id === this.selectedRegion)) this.selectedRegion = p.regions[0]?.id ?? null
    if (!p.captions.some(c => c.id === this.selectedCaption)) this.selectedCaption = p.captions[0]?.id ?? null
    for (const m of M.mediaList(p)) if (!p.isImage) this.preparePreview(m)
    this.refreshPreview(); this.scheduleRecovery(); this.showFrame(); this.changed(); this.timeChanged()
  }
  schedulePreview() { clearTimeout(this.previewTimer); this.previewTimer = setTimeout(() => this.refreshPreview(), 130) }
  refreshPreview() {
    if (!this.loaded) return
    this.refreshWaveform()
    const p = this.project, coverage = new Map()
    if (p.maskApplied) {
      for (const m of M.mediaList(p)) {
        const spans = [], tolerance = Math.max(0.06, 1.5 / m.fps)
        const times = p.faces.filter(f => f.selected && M.mediaOf(p, f) === m.id).flatMap(f => m.isImage ? [0, m.duration] : f.samples.map(s => s.time)).sort((a, b) => a - b)
        for (const time of times) {
          const last = spans[spans.length - 1]
          if (last && time - tolerance <= last.end) last.end = Math.max(last.end, time + tolerance)
          else spans.push({ start: time - tolerance, end: time + tolerance })
        }
        coverage.set(m.id, spans)
      }
    }
    this.faceCoverage = coverage
    if (!this.playing) this.applyPlayerAudio()
    this.requestDraw(); this.changed()
  }
  get faceSourceCoverage() { return this.faceCoverage.get(M.mediaList(this.project)[0].id) ?? [] }

  // ---------- files ----------
  saveProject() { return this.saveProjectIfPossible() }
  async saveProjectIfPossible(forceDialog = false) {
    this.focusTimeline(); this.endTimelineGesture()
    if (!this.loaded || this.busy) return false
    if (this.projectURL && !forceDialog) return this.save(this.projectURL)
    const base = path.basename(this.project.sourcePath, path.extname(this.project.sourcePath))
    const file = await dialogs.save({ defaultPath: path.join(path.dirname(this.project.sourcePath), `${base}.veilproject`), filters: [{ name: 'Veil 프로젝트', extensions: ['veilproject'] }] })
    if (!file) return false
    return this.save(file)
  }
  save(file) {
    try {
      if (M.mediaList(this.project).some(m => samePath(file, m.path))) throw new StudioError('원본 파일에는 프로젝트를 덮어쓸 수 없습니다.')
      const cleaned = M.cloneProject(this.project), repaired = M.repairFaceBounds(cleaned); M.validate(cleaned)
      const tmp = `${file}.${M.uuid()}.tmp`
      fs.writeFileSync(tmp, M.encodeProject(cleaned)); fs.renameSync(tmp, file)
      if (repaired > 0) this.project = cleaned
      this.projectURL = file; this.savedProject = this.project
      this.status = repaired > 0 ? `프로젝트 저장 완료 · 가장자리 얼굴 좌표 ${repaired}개 보정` : '프로젝트 저장 완료'
      this.changed(); return true
    } catch (e) { this.error = e.message; this.changed(); return false }
  }
  scheduleRecovery() {
    if (!this.automaticRecoveryEnabled) return
    clearTimeout(this.recoveryTimer)
    // Written asynchronously so large projects (many face samples) never stall editing; one write at a time.
    this.recoveryTimer = setTimeout(async () => {
      if (!this.loaded) return
      if (this.recoveryWriting) { this.scheduleRecovery(); return }
      this.recoveryWriting = true
      try {
        await fs.promises.mkdir(path.dirname(env.recovery), { recursive: true })
        const tmp = env.recovery + '.tmp'
        await fs.promises.writeFile(tmp, M.encodeProject(this.project)); await fs.promises.rename(tmp, env.recovery)
      } catch { this.status = '자동 복구 저장 실패 · 프로젝트를 직접 저장해 주세요'; this.changed() }
      finally { this.recoveryWriting = false }
    }, 1000)
  }
  async openProject(recovery = false, given = null) {
    if (this.busy) return
    let file = given
    if (recovery) file = env.recovery
    else if (!file) file = await dialogs.open({ properties: ['openFile'], filters: [{ name: 'Veil 프로젝트', extensions: ['veilproject'] }] })
    if (!file) return
    try {
      if (!fs.existsSync(file)) throw new StudioError(recovery ? '자동 저장된 작업이 없습니다.' : '프로젝트 파일을 찾을 수 없습니다.')
      const p = M.decodeProject(fs.readFileSync(file, 'utf8'))
      const repaired = M.repairFaceBounds(p), timingRepairs = M.repairEditableTimes(p); M.validate(p)
      let relinked = 0
      for (const m of M.mediaList(p)) {
        if (stampMatches(m)) continue
        if (!(await this.relinkSource(p, m))) return
        relinked++
      }
      if (!(await this.confirmLeaving())) return
      // Older projects do not store the audio stream count of the main file.
      if (!p.isImage && p.audioCount == null) { const info = await probe(p.sourcePath); p.audioCount = info.audioCount ?? 0; if (p.media) p.media[0].audioCount = p.audioCount }
      this.pause(); await this.setProject(p); this.projectURL = recovery ? null : file
      if (!recovery && !relinked) { this.savedProject = this.project }
      this.status = (recovery ? '자동 저장한 작업 복구 완료' : '프로젝트 열기 완료') + (relinked ? ` · 원본 ${relinked}개 위치 재연결` : '') + (repaired > 0 ? ` · 가장자리 좌표 ${repaired}개 보정` : '') + (timingRepairs > 0 ? ` · 뒤집힌 자막 ${timingRepairs}개를 최소 1프레임으로 보정: 시간 재확인 필요` : '')
      this.changed()
    } catch (e) { this.error = e.message; this.changed() }
  }
  // Projects made on another computer (e.g. the macOS app) keep that machine's path; allow re-linking an identical file.
  async relinkSource(p, m) {
    const name = M.mediaName(m)
    const r = await dialogs.message({ type: 'warning', message: '프로젝트의 원본이 없거나 변경되었습니다.', detail: `원본: ${m.path}\n\n같은 원본 파일(${name})을 직접 선택하면 다시 연결합니다. 파일 크기가 같아야 하며, 다른 파일이면 얼굴 분석 결과가 맞지 않습니다.`, buttons: ['원본 찾기…', '취소'], defaultId: 0, cancelId: 1, noLink: true })
    if (r !== 0) return false
    const file = await dialogs.open({ title: `원본 선택: ${name}`, properties: ['openFile'] })
    if (!file) return false
    const stamp = fileStamp(file)
    if (stamp.fileSize !== m.fileSize) throw new StudioError(`선택한 파일의 크기가 프로젝트의 원본(${name})과 다릅니다. 같은 원본 파일을 선택해 주세요.`)
    const resolved = path.resolve(file)
    if (m.id === M.mediaList(p)[0].id) { p.sourcePath = resolved; p.modified = stamp.modified }
    const entry = p.media?.find(x => x.id === m.id)
    if (entry) { entry.path = resolved; entry.modified = stamp.modified }
    return true
  }
  async importSRT() {
    const file = await dialogs.open({ properties: ['openFile'], filters: [{ name: 'SRT 자막', extensions: ['srt'] }, { name: '모든 파일', extensions: ['*'] }] })
    if (!file) return
    try {
      const captions = M.Subtitles.parse(decodeText(fs.readFileSync(file)))
      if (!captions.length) throw new StudioError('유효한 SRT 자막이 없습니다. (UTF-8 또는 한국어 ANSI/EUC-KR 형식)')
      this.edit(p => { p.captions = captions; M.separateOverlappingOverlays(p) }); this.tab = 'captions'; this.changed()
    } catch (e) { this.error = e.message; this.changed() }
  }
  async exportSRT() {
    const file = await dialogs.save({ defaultPath: path.join(path.dirname(this.project.sourcePath), '자막.srt'), filters: [{ name: 'SRT 자막', extensions: ['srt'] }] })
    if (!file) return
    try { fs.writeFileSync(file, M.Subtitles.srt(M.outputCaptions(this.project)), 'utf8'); this.status = '컷 편집을 반영한 SRT 저장 완료'; this.changed() }
    catch (e) { this.error = e.message; this.changed() }
  }
  async exportMedia() {
    if (!this.guardSource()) return
    const e = this.project.export
    const ext = this.project.isImage ? M.resolvedImageFormat(e) : M.videoExtension(e)
    const base = path.basename(this.project.sourcePath, path.extname(this.project.sourcePath))
    const file = await dialogs.save({ defaultPath: path.join(path.dirname(this.project.sourcePath), `${base}_편집.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    if (!file) return
    if (M.mediaList(this.project).some(m => samePath(file, m.path))) { this.error = '원본을 보호하기 위해 다른 파일 이름으로 저장해 주세요.'; this.changed(); return }
    if (this.jobs.running('export').some(j => j.destination && samePath(j.destination, file))) { this.error = '같은 파일로 내보내는 작업이 이미 진행 중입니다.'; this.changed(); return }
    this.exportSheet = false
    const session = this.sessionID
    const job = this.jobs.start('export', { project: M.cloneProject(this.project), destination: file }, { label: `내보내기 · ${path.basename(file)}`, session: null })
    job.destination = file
    this.status = '내보내는 동안에도 편집할 수 있습니다 (내보내기는 시작 시점의 편집 내용을 사용)'; this.changed()
    try {
      await job.promise
      this.lastExport = file; this.status = `내보내기 완료 · ${path.basename(file)}`; if (session !== this.sessionID) this.status += ' (이전 프로젝트)'; this.changed()
    } catch (err) { this.reportJobError(err, '내보내기') }
  }
  showLastExport() { if (this.lastExport) ipcRenderer.invoke('shell:show', this.lastExport) }

  // ---------- overlays & lanes ----------
  selectOverlay(id, region) {
    this.focusTimeline(); this.wholeOverlayTrack = false; this.selectedTrack = region ? 'regions' : 'captions'
    if (region) { this.selectedRegion = id; this.selectedLane = this.project.regions.find(r => r.id === id)?.lane ?? 0; this.tab = 'regions' }
    else { this.selectedCaption = id; this.selectedLane = this.project.captions.find(c => c.id === id)?.lane ?? 0; this.tab = 'captions' }
    this.changed()
  }
  splitOverlay() {
    if (this.wholeOverlayTrack) {
      this.wholeOverlayTrack = false
      const list = this.selectedTrack === 'captions' ? this.project.captions : this.project.regions
      const ids = list.filter(x => (x.lane ?? 0) === this.selectedLane).map(x => x.id)
      this.beginTimelineGesture()
      for (const id of ids) { if (this.selectedTrack === 'captions') this.selectedCaption = id; else this.selectedRegion = id; this.splitOverlay() }
      this.endTimelineGesture(); return
    }
    const t = this.playhead, p = M.cloneProject(this.project)
    const kind = this.selectedTrack === 'captions' ? 'captions' : 'regions', selected = kind === 'captions' ? this.selectedCaption : this.selectedRegion
    const i = p[kind].findIndex(x => x.id === selected)
    if (i < 0 || !(t > p[kind][i].start && t < p[kind][i].end)) { this.status = '선택한 블록 안쪽에 재생 헤드를 놓으세요'; this.changed(); return }
    const right = { ...p[kind][i], id: M.uuid(), start: t }
    p[kind][i] = { ...p[kind][i], end: t }; p[kind].splice(i + 1, 0, right)
    if (kind === 'captions') this.selectedCaption = right.id; else this.selectedRegion = right.id
    this.project = p; this.status = '선택한 트랙만 분할했습니다'; this.changed()
  }
  editSelection(action) {
    if (!this.canEditTimeline) return
    if (linkedToVideo(this.selectedTrack)) { ({ copy: () => this.copyClips(), cut: () => this.cutClips(), paste: () => this.pasteClips(), delete: () => this.deleteClip() })[action]?.(); return }
    const captions = this.selectedTrack === 'captions', lane = this.selectedLane, whole = this.wholeOverlayTrack
    const picked = x => (whole && (x.lane ?? 0) === lane) || x.id === (captions ? this.selectedCaption : this.selectedRegion)
    const p = M.cloneProject(this.project)
    if (action === 'copy' || action === 'cut') { if (captions) this.clipboardCaptions = p.captions.filter(picked); else this.clipboardRegions = p.regions.filter(picked) }
    if (action === 'delete' || action === 'cut') {
      if (captions) { p.captions = p.captions.filter(x => !picked(x)); this.selectedCaption = null } else { p.regions = p.regions.filter(x => !picked(x)); this.selectedRegion = null }
    }
    if (action === 'paste') {
      const clip = captions ? this.clipboardCaptions : this.clipboardRegions
      if (clip.length) {
        const shift = this.playhead - Math.min(...clip.map(x => x.start))
        for (const original of clip) {
          const v = { ...structuredClone(original), id: M.uuid(), lane, start: original.start + shift, end: original.end + shift }
          if (!captions) v.keyframes = v.keyframes.map(k => ({ ...k, time: Math.max(0, k.time + shift) }))
          if (captions) { p.captions.push(v); this.selectedCaption = v.id } else { p.regions.push(v); this.selectedRegion = v.id }
        }
      }
      this.wholeOverlayTrack = false
    }
    M.separateOverlappingOverlays(p); this.project = p; this.synchronizeSelectedLane(); this.changed()
  }
  laneCount(kind) {
    const p = this.project, max = list => list.reduce((m, x) => Math.max(m, x.lane ?? 0), 0) + 1
    switch (kind) {
      case 'video': return Math.max(p.videoLaneCount ?? 1, max(p.clips))
      case 'regions': return Math.max(p.regionLaneCount ?? 1, max(p.regions))
      case 'captions': return Math.max(p.captionLaneCount ?? 1, max(p.captions))
      default: return this.laneCount('video')
    }
  }
  get timelineRows() {
    const rows = []
    for (let lane = this.laneCount('video') - 1; lane >= 0; lane--) for (const kind of ['video', 'audio', 'faces']) rows.push({ kind, lane, id: `${kind}-${lane}`, title: M.rowTitle(kind, lane) })
    for (const kind of ['regions', 'captions']) for (let lane = this.laneCount(kind) - 1; lane >= 0; lane--) rows.push({ kind, lane, id: `${kind}-${lane}`, title: M.rowTitle(kind, lane) })
    return rows
  }
  addLane(kind) {
    const count = this.laneCount(kind)
    if (count >= 64) { this.status = '종류별 트랙은 최대 64개입니다'; this.changed(); return }
    if (!['video', 'regions', 'captions'].includes(kind)) return
    this.edit(p => {
      if (kind === 'video') { M.enableVideoLanes(p); p.videoLaneCount = count + 1 }
      if (kind === 'regions') p.regionLaneCount = count + 1
      if (kind === 'captions') p.captionLaneCount = count + 1
    })
    this.selectLane(kind, count)
  }
  moveItem(id, kind, lane, time = null) {
    const p = M.cloneProject(this.project)
    if (linkedToVideo(kind) && p.clips.some(c => c.id === id)) {
      M.enableVideoLanes(p); p.videoLaneCount = Math.max(2, this.laneCount('video'), lane + 1)
      const c = p.clips.find(c => c.id === id)
      const at = Math.max(0, time ?? c.position ?? 0), end = at + M.clipDuration(c)
      if (M.timeline(p).some(e => e.id !== id && (e.clip.lane ?? 0) === lane && e.start < end && e.end > at)) { this.status = '같은 영상 트랙의 컷과 겹칩니다. 빈 트랙으로 이동하세요.'; this.changed(); return }
      c.lane = lane; c.position = at; delete p.exportRange
      this.selectedClip = id; this.selectedClips = new Set([id])
    } else if (kind === 'regions' && p.regions.some(r => r.id === id)) {
      const r = p.regions.find(r => r.id === id); r.lane = lane
      if (time != null) { const d = Math.max(0, time) - r.start; r.start += d; r.end += d; r.keyframes = r.keyframes.map(k => ({ ...k, time: Math.max(0, k.time + d) })) }
      this.selectedRegion = id; this.tab = 'regions'
    } else if (kind === 'captions' && p.captions.some(c => c.id === id)) {
      const c = p.captions.find(c => c.id === id); c.lane = lane
      if (time != null) { const d = Math.max(0, time) - c.start; c.start += d; c.end += d }
      this.selectedCaption = id; this.tab = 'captions'
    } else return
    M.separateOverlappingOverlays(p); this.project = p; this.selectedTrack = kind; this.selectedLane = lane; this.synchronizeSelectedLane(); this.focusTimeline()
    this.showFrame(); this.changed()
  }
  selectLane(kind, lane) {
    this.focusTimeline(); this.wholeOverlayTrack = false; this.selectedTrack = kind; this.selectedLane = lane
    if (linkedToVideo(kind)) { this.selectedClip = null; this.selectedClips = new Set() }
    if (kind === 'regions') { this.selectedRegion = null; this.tab = 'regions' }
    if (kind === 'captions') { this.selectedCaption = null; this.tab = 'captions' }
    if (kind === 'faces' || kind === 'audio') {
      const top = M.timeline(this.project).find(e => (e.clip.lane ?? 0) === lane && this.playhead >= e.start && this.playhead < e.end)
      if (top) { this.selectedClip = top.id; this.selectedClips = new Set([top.id]); this.selectedLane = top.clip.lane ?? 0 }
    }
    this.changed()
  }
  synchronizeSelectedLane() {
    if (this.selectedTrack === 'regions') { const r = this.project.regions.find(r => r.id === this.selectedRegion); if (r) this.selectedLane = r.lane ?? 0 }
    if (this.selectedTrack === 'captions') { const c = this.project.captions.find(c => c.id === this.selectedCaption); if (c) this.selectedLane = c.lane ?? 0 }
  }
  waveformFor(mediaId) { return this.waveforms.get(mediaId ?? M.mediaList(this.project)[0].id) ?? null }
  get waveform() { return this.waveformFor(null) }
  // Waveforms are read per file in background workers, only for the ranges used on the timeline.
  refreshWaveform() {
    if (!this.loaded || this.project.isImage) return
    const session = this.sessionID, p = this.project
    for (const m of M.mediaList(p)) {
      if (m.isImage || !p.clips.some(c => M.mediaOf(p, c) === m.id)) continue
      const ranges = M.analysisRanges(p, m.id), key = JSON.stringify(ranges)
      if (this.waveforms.get(m.id)?.covers(ranges) || this.waveformRequested.get(m.id) === key) continue
      this.waveformRequested.set(m.id, key)
      this.jobs.jobs.filter(j => j.kind === 'waveform' && j.media === m.id).forEach(j => j.cancel())
      const job = this.jobs.start('waveform', { source: m.path, duration: m.duration, ranges, audioCount: m.audioCount ?? 1 }, { session })
      job.media = m.id
      this.waveformStatus = '파형 생성 중…'; this.changed()
      job.promise.then(w => {
        if (this.sessionID !== session) return
        this.waveforms.set(m.id, new AudioWaveform(w.peaks, w.duration, w.ranges, w.hasAudio)); this.waveformRevision++
        this.waveformStatus = w.hasAudio ? '' : '오디오 없음'; this.changed()
      }).catch(e => { if (!isCancel(e) && this.sessionID === session) { this.waveformStatus = '파형을 읽지 못했습니다'; this.changed() } })
    }
  }
  closeGap(range, lane) {
    if (!this.canEditTimeline || !M.gaps(this.project, lane).some(g => Math.abs(g.start - range.start) < 1e-9 && Math.abs(g.end - range.end) < 1e-9)) return
    const p = M.cloneProject(this.project); M.enableVideoLanes(p)
    for (const c of p.clips) if ((c.lane ?? 0) === lane && (c.position ?? 0) >= range.end - 0.000001) c.position = Math.max(0, (c.position ?? 0) - (range.end - range.start))
    delete p.exportRange; this.commitTimeline(p, range.start)
    this.status = '빈 구간 삭제 · 영상·오디오·얼굴 마스크 세트를 붙였습니다'; this.changed()
  }
}
