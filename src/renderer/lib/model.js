// Port of Models.swift / Timeline.swift. Project JSON stays compatible with the macOS app.
// Normalized rectangles keep the macOS convention: origin at the bottom-left, y grows upward.

export class StudioError extends Error {}
export class CancellationError extends Error { constructor() { super('작업이 취소되었습니다'); this.cancelled = true } }
export const isCancel = e => !!(e && e.cancelled)

export class Cancellation {
  constructor() { this.cancelled = false; this.listeners = new Set() }
  cancel() { if (this.cancelled) return; this.cancelled = true; for (const f of this.listeners) { try { f() } catch {} } }
  onCancel(f) { this.listeners.add(f); return () => this.listeners.delete(f) }
  check() { if (this.cancelled) throw new CancellationError() }
}

export const uuid = () => crypto.randomUUID().toUpperCase()
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const finite = Number.isFinite
// Swift's Date encodes as seconds since 2001-01-01.
export const REFERENCE_EPOCH_MS = 978307200000
export const dateFromMs = ms => (ms - REFERENCE_EPOCH_MS) / 1000
export const msFromDate = d => d * 1000 + REFERENCE_EPOCH_MS

// ---------- Rect ----------
export const rect = (x, y, width, height) => ({ x, y, width, height })
export function intersect(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 < x1 || y2 < y1) return null
  return rect(x1, y1, x2 - x1, y2 - y1)
}
const UNIT = rect(0, 0, 1, 1)
export function scaled(r, w, h) { return rect(r.x * w, r.y * h, r.width * w, r.height * h) }
export function expanded(r, margin) {
  const dx = r.width * margin / 2, dy = r.height * margin / 2
  return intersect(rect(r.x - dx, r.y - dy, r.width + dx * 2, r.height + dy * 2), UNIT) ?? rect(0, 0, 0, 0)
}
export function interpolate(a, b, t) {
  return rect(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.width + (b.width - a.width) * t, a.height + (b.height - a.height) * t)
}
export function clippedToImage(r) {
  if (![r.x, r.y, r.width, r.height].every(finite) || r.width <= 0 || r.height <= 0) return null
  if (r.x >= 0 && r.y >= 0 && r.x + r.width <= 1 && r.y + r.height <= 1) return r
  const c = intersect(r, UNIT)
  if (!c || c.width <= 0 || c.height <= 0) return null
  return c
}
export function validRect(r) {
  return !!r && [r.x, r.y, r.width, r.height].every(finite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001
}
export const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// ---------- Enums (raw values match the macOS app) ----------
export const MaskEffect = { pixel: '모자이크', blur: '블러', solid: '단색', sticker: '스티커' }
export const MaskShape = { oval: '타원', rectangle: '사각형', rounded: '둥근 사각형', heart: '하트', star: '별' }
export const CropRatios = [['원본', null], ['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3]]
export const Resolutions = [['원본 크기', null], ['4K · 2160p', 3840], ['Full HD · 1080p', 1920], ['HD · 720p', 1280]]
// HEIC encoding is not available on Windows; the value is kept only for project compatibility.
export const ImageOutputs = ['png', 'jpg', 'tiff']
export const VideoOutputs = ['mp4', 'mov']
export const ratioValue = raw => (CropRatios.find(r => r[0] === raw) ?? CropRatios[0])[1]
export const resolutionEdge = raw => (Resolutions.find(r => r[0] === raw) ?? Resolutions[0])[1]

export const defaultDesign = () => ({ effect: '모자이크', shape: '타원', strength: 0.65, margin: 0.35, red: 0.30, green: 0.33, blue: 0.94, sticker: '🙂' })
export const defaultExport = () => ({ ratio: '원본', resolution: 'Full HD · 1080p', cropX: 0.5, cropY: 0.5, hevc: false, muted: false, burnCaptions: true, captionSize: 0.045, jpeg: false })
export function newProject() {
  return {
    version: 1, sourcePath: '', fileSize: 0, isImage: false, duration: 0, width: 0, height: 0, fps: 30,
    faces: [], regions: [], captions: [], clips: [], design: defaultDesign(), export: defaultExport(),
    maskApplied: false, analysisComplete: false
  }
}
export const faceDesign = p => p.faceDesign ?? p.design
export const regionDesign = p => p.regionDesign ?? p.design
export const resolvedImageFormat = e => {
  const f = e.imageFormat ?? (e.jpeg ? 'jpg' : 'png')
  return ImageOutputs.includes(f) ? f : 'png'
}
export const videoExtension = e => e.videoFormat ?? 'mp4'

export function cropRect(e, w, h) {
  const ratio = ratioValue(e.ratio)
  if (ratio == null) return rect(0, 0, w, h)
  const width = Math.min(w, h * ratio), height = Math.min(h, w / ratio)
  return rect((w - width) * e.cropX, (h - height) * e.cropY, width, height)
}
export function outputSize(e, w, h, even = true) {
  const crop = cropRect(e, w, h), long = Math.max(crop.width, crop.height)
  const factor = Math.min(1, (resolutionEdge(e.resolution) ?? long) / long)
  const step = even ? 2 : 1
  return { width: Math.max(step, Math.floor(crop.width * factor / step) * step), height: Math.max(step, Math.floor(crop.height * factor / step) * step) }
}

// ---------- Face / region sampling ----------
export function faceRectAt(face, time, still = false, tolerance = 0.12) {
  const s = face.samples
  if (!s.length) return null
  if (still) return s[0].rect
  let low = 0, high = s.length
  while (low < high) { const mid = (low + high) >> 1; if (s[mid].time < time) low = mid + 1; else high = mid }
  const next = low < s.length ? s[low] : null, prev = low > 0 ? s[low - 1] : null
  if (prev && next && next.time - prev.time <= tolerance * 2 && next.time > prev.time) return interpolate(prev.rect, next.rect, (time - prev.time) / (next.time - prev.time))
  if (next && Math.abs(next.time - time) <= tolerance) return next.rect
  if (prev && Math.abs(prev.time - time) <= tolerance) return prev.rect
  return null
}
export function regionRectAt(region, time) {
  const sorted = [...region.keyframes].sort((a, b) => a.time - b.time)
  if (!sorted.length) return region.rect
  if (time <= sorted[0].time) return sorted[0].rect
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1]
    if (time <= b.time) return interpolate(a.rect, b.rect, (time - a.time) / Math.max(0.001, b.time - a.time))
  }
  return sorted[sorted.length - 1].rect
}

// ---------- Media (several source files per project) ----------
// Single-file projects keep only the legacy top-level fields (macOS compatible). When more files are added,
// p.media lists every source; media[0] mirrors the legacy fields. Clips and face tracks refer to a media id.
export const PRIMARY = 'main'
export function primaryMedia(p) {
  return { id: PRIMARY, path: p.sourcePath, fileSize: p.fileSize, modified: p.modified, isImage: p.isImage, duration: p.duration, width: p.width, height: p.height, fps: p.fps, audioCount: p.audioCount ?? 1 }
}
export const mediaList = p => (p.media?.length ? p.media : [primaryMedia(p)])
export function mediaById(p, id) { const list = mediaList(p); return (id != null && list.find(m => m.id === id)) || list[0] }
export const mediaOf = (p, item) => mediaById(p, item?.media).id
export const mediaName = m => (m.path ?? '').split(/[\\/]/).pop()
// Clip attributes that travel with the clip when it is split, copied or pasted.
const CLIP_KEYS = ['media', 'volume', 'muted', 'fadeIn', 'fadeOut', 'disabled', 'brightness', 'contrast', 'saturation', 'name']
export function clipAttrs(c) { const out = {}; for (const k of CLIP_KEYS) if (c[k] != null) out[k] = c[k]; return out }

// Where a media frame lands inside the project frame: aspect-fit and centred (letterbox), project pixels.
export function fitRect(m, p) {
  const s = Math.min(p.width / m.width, p.height / m.height), w = m.width * s, h = m.height * s
  return { x: (p.width - w) / 2, y: (p.height - h) / 2, w, h, s }
}
// A rect normalized to the media frame (bottom-left origin) → normalized to the project frame.
export function mediaToProjectRect(r, m, p) {
  if (Math.abs(m.width - p.width) < 0.5 && Math.abs(m.height - p.height) < 0.5) return r
  const f = fitRect(m, p)
  return rect((f.x + r.x * f.w) / p.width, (f.y + r.y * f.h) / p.height, r.width * f.w / p.width, r.height * f.h / p.height)
}

// ---------- Timeline ----------
export const clipDuration = c => Math.max(0, c.end - c.start)
export const rangeDuration = r => Math.max(0, r.end - r.start)
export function timeline(p) {
  let cursor = 0
  return p.clips.map((clip, index) => {
    const entry = { clip, index, start: clip.position ?? cursor, get end() { return this.start + clipDuration(this.clip) }, get id() { return this.clip.id } }
    cursor += clipDuration(clip)
    return entry
  })
}
export const makeEntry = (clip, index, start) => ({ clip, index, start, get end() { return this.start + clipDuration(this.clip) }, get id() { return this.clip.id } })
export const editedDuration = p => timeline(p).reduce((m, e) => Math.max(m, e.end), 0)
export const exportDuration = p => p.exportRange ? rangeDuration(p.exportRange) : editedDuration(p)

export function visibleTimeline(p) {
  const entries = timeline(p)
  if ((p.videoLaneCount ?? 1) <= 1) return entries
  const edges = [...new Set(entries.flatMap(e => [e.start, e.end]))].sort((a, b) => a - b)
  const result = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1]
    if (!(b > a)) continue
    let top = null
    for (const e of entries) if (e.start <= a && e.end >= b && (!top || (e.clip.lane ?? 0) > (top.clip.lane ?? 0))) top = e
    if (!top) continue
    const c = { ...top.clip }; c.start += a - top.start; c.end = c.start + b - a; c.position = a
    result.push(makeEntry(c, top.index, a))
  }
  return result
}
export function sourceTime(p, output) {
  const vis = visibleTimeline(p)
  const entry = vis.find(e => output >= e.start && output < e.end)
  if (entry) return entry.clip.start + output - entry.start
  if (output >= editedDuration(p)) return vis.length ? vis[vis.length - 1].clip.end : output
  return -1
}
// Entry of the visible timeline at `time` (binary search) plus the source time inside it.
export function entryAt(entries, time) {
  let low = 0, high = entries.length
  while (low < high) { const mid = (low + high) >> 1; if (entries[mid].end <= time) low = mid + 1; else high = mid }
  if (low < entries.length && time >= entries[low].start) return { entry: entries[low], time: entries[low].clip.start + time - entries[low].start }
  return null
}
export function mappedSourceTime(entries, time) {
  let low = 0, high = entries.length
  while (low < high) { const mid = (low + high) >> 1; if (entries[mid].end <= time) low = mid + 1; else high = mid }
  if (low < entries.length && time >= entries[low].start) return entries[low].clip.start + time - entries[low].start
  if (entries.length && time >= entries[entries.length - 1].end) return entries[entries.length - 1].clip.end
  return -1
}
export function timelineTime(p, source, preferredClip = null, mediaId = null) {
  const id = mediaId ?? mediaList(p)[0].id
  const matches = timeline(p).filter(e => mediaOf(p, e.clip) === id && source >= e.clip.start && source <= e.clip.end)
  const entry = matches.find(e => e.id === preferredClip) ?? matches[0]
  return entry ? entry.start + source - entry.clip.start : null
}
export function clipsIn(p, range) {
  const out = []
  for (const e of timeline(p)) {
    const start = Math.max(range.start, e.start), end = Math.min(range.end, e.end)
    if (end - start <= 0.000001) continue
    const c = { id: uuid(), start: e.clip.start + start - e.start, end: e.clip.start + end - e.start, ...clipAttrs(e.clip) }
    // A fade only survives when the range keeps that edge of the clip.
    if (start > e.start + 0.000001) delete c.fadeIn
    if (end < e.end - 0.000001) delete c.fadeOut
    if (e.clip.lane != null) c.lane = e.clip.lane
    if (e.clip.position != null) c.position = start - range.start
    out.push(c)
  }
  return out
}
export function outputCaptions(p, respectExportRange = true) {
  if (p.overlaysOnTimeline === true) {
    const range = respectExportRange ? (p.exportRange ?? { start: 0, end: editedDuration(p) }) : { start: 0, end: editedDuration(p) }
    return p.captions.flatMap(c => {
      const a = Math.max(range.start, c.start), b = Math.min(range.end, c.end)
      return b > a ? [{ ...c, start: a - range.start, end: b - range.start }] : []
    }).sort((x, y) => x.start - y.start)
  }
  const result = []
  for (const entry of (respectExportRange ? visibleTimeline(projectForExport(p)) : visibleTimeline(p))) {
    const clip = entry.clip, offset = entry.start
    for (const c of p.captions) {
      const start = Math.max(c.start, clip.start), end = Math.min(c.end, clip.end)
      if (end > start) result.push({ ...c, id: uuid(), start: offset + start - clip.start, end: offset + end - clip.start })
    }
  }
  return result.sort((x, y) => x.start - y.start)
}
// A single-file view of one media entry (what the per-file analysers work on).
export function mediaView(p, m) {
  const view = { ...p, sourcePath: m.path, fileSize: m.fileSize, modified: m.modified, isImage: p.isImage || m.isImage, width: m.width, height: m.height,
    fps: m.isImage ? p.fps : m.fps, duration: m.duration, audioCount: m.audioCount, clips: p.clips.filter(c => mediaOf(p, c) === m.id).map(c => ({ ...c, media: undefined })) }
  delete view.media
  return view
}
// Captions in source time (tagged with their media) → timeline captions for every visible use of that source.
export function mapSourceCaptions(p, captions) {
  const result = []
  for (const entry of visibleTimeline(p)) {
    const clip = entry.clip, id = mediaOf(p, clip)
    for (const c of captions) {
      if ((c.media ?? mediaList(p)[0].id) !== id) continue
      const start = Math.max(c.start, clip.start), end = Math.min(c.end, clip.end)
      if (end > start) result.push({ id: uuid(), start: entry.start + start - clip.start, end: entry.start + end - clip.start, text: c.text })
    }
  }
  return result.sort((x, y) => x.start - y.start)
}
export function projectForExport(p) {
  const out = { ...p }
  if (!p.isImage && p.exportRange) {
    const range = p.exportRange
    out.clips = clipsIn(p, range)
    if (p.overlaysOnTimeline === true) {
      out.captions = outputCaptions(p)
      out.regions = p.regions.flatMap(r => {
        if (!(Math.min(r.end, range.end) > Math.max(r.start, range.start))) return []
        return [{ ...r, start: Math.max(r.start, range.start) - range.start, end: Math.min(r.end, range.end) - range.start, keyframes: r.keyframes.map(k => ({ ...k, time: k.time - range.start })) }]
      })
    }
  }
  delete out.exportRange
  return out
}
export function splitTimeline(p, time, clipID = null) {
  const threshold = Math.max(0.001, 0.5 / p.fps)
  const entry = timeline(p).find(e => (clipID == null || e.id === clipID) && time > e.start + threshold && time < e.end - threshold)
  if (!entry) return null
  const source = entry.clip.start + time - entry.start
  const second = { id: uuid(), start: source, end: entry.clip.end, ...clipAttrs(entry.clip) }
  // Fades belong to the outer edges of the original clip.
  delete second.fadeIn
  if (p.clips[entry.index].fadeOut != null) delete p.clips[entry.index].fadeOut
  if (entry.clip.lane != null) second.lane = entry.clip.lane
  if (entry.clip.position != null) second.position = time
  p.clips[entry.index] = { ...p.clips[entry.index], end: source }
  p.clips.splice(entry.index + 1, 0, second)
  return second.id
}
export function removeTimelineClips(p, ids) { p.clips = p.clips.filter(c => !ids.has(c.id)); delete p.exportRange }
export function insertTimelineClips(p, source, time) {
  const t = Math.max(0, Math.min(editedDuration(p), time))
  splitTimeline(p, t)
  let index = timeline(p).findIndex(e => e.start >= t - 0.000001)
  if (index < 0) index = p.clips.length
  const copies = source.map(c => ({ id: uuid(), start: c.start, end: c.end, ...clipAttrs(c) }))
  p.clips.splice(index, 0, ...copies); delete p.exportRange
  return copies.map(c => c.id)
}
export function moveTimelineClip(p, id, destination) {
  const old = p.clips.findIndex(c => c.id === id)
  if (id === destination || old < 0) return
  const [clip] = p.clips.splice(old, 1)
  let next = destination == null ? -1 : p.clips.findIndex(c => c.id === destination)
  if (next < 0) next = p.clips.length
  p.clips.splice(next, 0, clip); delete p.exportRange
}
export function deleteTimelineRange(p, range) {
  const left = clipsIn(p, { start: 0, end: range.start }), right = clipsIn(p, { start: range.end, end: editedDuration(p) })
  p.clips = [...left, ...right]; delete p.exportRange
}
export function overlayItems(p, regionsOnly) {
  const values = regionsOnly ? p.regions.map(r => [r.id, r.start, r.end, r.name, r.lane ?? 0]) : p.captions.map(c => [c.id, c.start, c.end, c.text, c.lane ?? 0])
  if (p.overlaysOnTimeline === true) return values.map(([id, start, end, title, lane]) => ({ sourceID: id, start, end, title, lane, region: regionsOnly }))
  return timeline(p).flatMap(entry => values.flatMap(([id, start, end, title, lane]) => {
    const a = Math.max(start, entry.clip.start), b = Math.min(end, entry.clip.end)
    return b > a ? [{ sourceID: id, start: entry.start + a - entry.clip.start, end: entry.start + b - entry.clip.start, title, lane, region: regionsOnly }] : []
  }))
}
export function migrateOverlayTimeline(p) {
  if (p.isImage || p.overlaysOnTimeline === true) return
  p.captions = outputCaptions(p, false)
  const old = p.regions
  p.regions = timeline(p).flatMap(entry => old.flatMap(r => {
    const a = Math.max(r.start, entry.clip.start), b = Math.min(r.end, entry.clip.end)
    if (!(b > a)) return []
    const v = { ...r, id: uuid(), start: entry.start + a - entry.clip.start, end: entry.start + b - entry.clip.start, rect: regionRectAt(r, a) }
    v.keyframes = r.keyframes.length ? [
      { id: uuid(), time: v.start, rect: regionRectAt(r, a) },
      ...r.keyframes.filter(k => k.time > a && k.time < b).map(k => ({ id: uuid(), time: entry.start + k.time - entry.clip.start, rect: k.rect })),
      { id: uuid(), time: v.end, rect: regionRectAt(r, b) }
    ] : []
    return [v]
  }))
  p.overlaysOnTimeline = true
}
export function repairEditableTimes(p) {
  let count = 0
  const frame = 1 / Math.max(1, p.fps)
  p.captions = p.captions.map(c => {
    if (!finite(c.start) || !finite(c.end)) return c
    const v = { ...c }
    if (v.start < 0) { v.start = 0; count++ }
    if (v.end <= v.start) { v.end = v.start + frame; count++ }
    return v
  })
  return count
}
// Union of source ranges still used on the timeline, for one media file (default: the primary file).
export function analysisRanges(p, mediaId = null) {
  const id = mediaId ?? mediaList(p)[0].id
  const ranges = p.clips.filter(c => mediaOf(p, c) === id).map(c => ({ start: c.start, end: c.end })).sort((a, b) => a.start - b.start)
  const result = []
  for (const r of ranges) {
    const last = result[result.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else result.push({ ...r })
  }
  return result
}
export function enableVideoLanes(p) {
  const entries = timeline(p)
  p.clips = p.clips.map((c, i) => ({ ...c, position: entries[i].start }))
}
export function separateOverlappingOverlays(p) {
  const pass = (items) => {
    const ends = new Map()
    const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start)
    const out = items.map(x => ({ ...x }))
    for (const i of order) {
      let lane = out[i].lane ?? 0
      if ((ends.get(lane) ?? -1) > out[i].start) {
        for (let l = 0; l <= out.length; l++) if ((ends.get(l) ?? -1) <= out[i].start) { lane = l; break }
      }
      out[i].lane = lane; ends.set(lane, out[i].end)
    }
    return [out, ends.size ? Math.max(...ends.keys()) : 0]
  }
  let [captions, cMax] = pass(p.captions); p.captions = captions
  p.captionLaneCount = Math.max(p.captionLaneCount ?? 1, cMax + 1)
  let [regions, rMax] = pass(p.regions); p.regions = regions
  p.regionLaneCount = Math.max(p.regionLaneCount ?? 1, rMax + 1)
}
export function gaps(p, lane) {
  let cursor = 0
  const result = []
  for (const e of timeline(p).filter(e => (e.clip.lane ?? 0) === lane).sort((a, b) => a.start - b.start)) {
    if (e.start - cursor > 0.000001) result.push({ start: cursor, end: e.start })
    cursor = Math.max(cursor, e.end)
  }
  return result
}

// ---------- Validation / repair ----------
export function repairFaceBounds(p) {
  let count = 0
  p.faces = p.faces.map(face => {
    let changed = false
    const samples = face.samples.map(s => {
      const c = clippedToImage(s.rect)
      if (!c) throw new StudioError(`얼굴 분석 좌표가 손상되었습니다: ${face.name}, ${timecode(s.time)}. 이 후보를 다시 분석해 주세요.`)
      if (!sameRect(c, s.rect)) { count++; changed = true; return { time: s.time, rect: c } }
      return s
    })
    return changed ? { ...face, samples } : face
  })
  return count
}
const inRange = (v, a, b) => finite(v) && v >= a && v <= b
export function validate(p) {
  const bad = m => { throw new StudioError(m) }
  if (!(p.version === 1 && finite(p.width) && finite(p.height) && p.width > 0 && p.height > 0 && p.width * p.height <= 120_000_000 && finite(p.duration) && p.duration >= 0 && finite(p.fps) && p.fps > 0)) bad('올바른 프로젝트 파일이 아닙니다.')
  if (new Set(p.clips.map(c => c.id)).size !== p.clips.length) bad('컷 식별자가 중복되었습니다.')
  const laneOK = x => { const l = x.lane ?? 0; return l >= 0 && l < 64 }
  if (![p.videoLaneCount, p.regionLaneCount, p.captionLaneCount].every(v => v == null || (v >= 1 && v <= 64)) ||
      !p.clips.every(c => laneOK(c) && (c.position == null || (finite(c.position) && c.position >= 0))) ||
      !p.regions.every(laneOK) || !p.captions.every(laneOK)) bad('트랙 번호 또는 영상 배치 시간이 잘못되었습니다.')
  const media = mediaList(p)
  if (p.media) {
    if (new Set(media.map(m => m.id)).size !== media.length || !media.every(m => typeof m.path === 'string' && m.path && finite(m.duration) && m.duration > 0 && finite(m.width) && m.width > 0 && finite(m.height) && m.height > 0 && finite(m.fps) && m.fps > 0)) bad('프로젝트의 미디어 목록이 손상되었습니다.')
    if (!p.clips.every(c => c.media == null || media.some(m => m.id === c.media)) || !p.faces.every(f => f.media == null || media.some(m => m.id === f.media))) bad('컷이 가리키는 미디어를 찾을 수 없습니다.')
  }
  for (const c of p.clips) if (!(finite(c.start) && finite(c.end) && c.start >= 0 && c.end <= mediaById(p, c.media).duration + 0.01 && clipDuration(c) > 0)) bad('각 컷의 시작·끝은 원본 범위 안에 있어야 합니다.')
  for (const c of p.clips) if (![c.volume ?? 0, c.fadeIn ?? 0, c.fadeOut ?? 0, c.brightness ?? 0, c.contrast ?? 1, c.saturation ?? 1].every(finite) || (c.fadeIn ?? 0) < 0 || (c.fadeOut ?? 0) < 0) bad('컷 속성 값이 손상되었습니다.')
  if (p.markers && !p.markers.every(m => finite(m.time) && m.time >= 0)) bad('마커 데이터가 손상되었습니다.')
  if (p.exportRange) {
    const r = p.exportRange
    if (!(finite(r.start) && finite(r.end) && r.start >= 0 && r.end <= editedDuration(p) + 0.000001 && r.end > r.start)) bad('내보내기 구간이 편집 타임라인 범위를 벗어났습니다.')
  }
  for (const f of p.faces) {
    let previous = -Infinity
    for (const s of f.samples) {
      if (!(finite(s.time) && s.time >= 0 && s.time <= mediaById(p, f.media).duration + 0.1 && s.time >= previous && validRect(s.rect))) bad('얼굴 분석 데이터가 손상되었습니다.')
      previous = s.time
    }
  }
  const overlay = p.overlaysOnTimeline === true
  for (const r of p.regions) {
    if (!(validRect(r.rect) && finite(r.start) && finite(r.end) && r.start >= 0 && r.end >= r.start && (overlay || r.end <= p.duration + 0.01) &&
      r.keyframes.every(k => finite(k.time) && k.time >= 0 && (overlay || k.time <= p.duration) && validRect(k.rect)))) bad('영역 마스크 데이터가 손상되었습니다.')
  }
  const d = p.design, e = p.export
  if (!(p.captions.every(c => finite(c.start) && finite(c.end) && c.start >= 0 && c.end > c.start) &&
      [d.strength, d.margin, d.red, d.green, d.blue, e.cropX, e.cropY, e.captionSize].every(v => inRange(v, 0, 2)))) bad('편집 설정이 손상되었습니다.')
  for (const m of [faceDesign(p), regionDesign(p)]) {
    if (!(inRange(m.strength, 0, 1) && inRange(m.margin, 0, 1.5) && [m.red, m.green, m.blue].every(v => inRange(v, 0, 1)))) bad('마스크 디자인 설정이 허용 범위를 벗어났습니다.')
  }
  if (!(inRange(d.strength, 0, 1) && inRange(d.margin, 0, 1.5) && [d.red, d.green, d.blue, e.cropX, e.cropY].every(v => inRange(v, 0, 1)) && inRange(e.captionSize, 0.01, 0.2))) bad('마스크·크롭 설정이 허용 범위를 벗어났습니다.')
}

// ---------- Time / subtitles ----------
const pad = (n, w) => String(n).padStart(w, '0')
export function timecode(seconds) {
  if (!finite(seconds)) return '00:00.0'
  const s = Math.max(0, seconds), m = Math.floor(s / 60), rest = s - m * 60
  return `${pad(m, 2)}:${rest.toFixed(1).padStart(4, '0')}`
}
export const Subtitles = {
  timestamp(t) { const ms = Math.round(Math.max(0, t) * 1000); return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}` },
  srt(captions) { return captions.map((c, i) => `${i + 1}\n${this.timestamp(c.start)} --> ${this.timestamp(c.end)}\n${c.text}\n`).join('\n') },
  parse(text) {
    const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const seconds = s => {
      const clean = s.trim().split(' ')[0] ?? ''
      const parts = clean.replace(',', '.').split(':').map(Number)
      if (parts.some(v => !finite(v))) return null
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
      if (parts.length === 2) return parts[0] * 60 + parts[1]
      return null
    }
    return normalized.split(/\n\s*\n/).flatMap(block => {
      const lines = block.split('\n'), i = lines.findIndex(l => l.includes('-->'))
      if (i < 0) return []
      const times = lines[i].split('-->')
      if (times.length !== 2) return []
      const a = seconds(times[0]), b = seconds(times[1])
      if (a == null || b == null || !(b > a) || a < 0) return []
      const content = lines.slice(i + 1).join('\n').trim()
      return content ? [{ id: uuid(), start: a, end: b, text: content }] : []
    }).sort((x, y) => x.start - y.start)
  }
}

// ---------- JSON (macOS-compatible) ----------
const OPTIONAL_NULL = ['modified', 'overlaysOnTimeline', 'videoLaneCount', 'regionLaneCount', 'captionLaneCount', 'faceDesign', 'regionDesign', 'exportRange']
export function decodeProject(text) {
  let raw
  try { raw = JSON.parse(text) } catch { throw new StudioError('올바른 프로젝트 파일이 아닙니다.') }
  if (!raw || typeof raw !== 'object') throw new StudioError('올바른 프로젝트 파일이 아닙니다.')
  const p = { ...newProject(), ...raw }
  for (const k of OPTIONAL_NULL) if (p[k] == null) delete p[k]
  p.design = { ...defaultDesign(), ...(raw.design ?? {}) }
  if (raw.faceDesign) p.faceDesign = { ...defaultDesign(), ...raw.faceDesign }
  if (raw.regionDesign) p.regionDesign = { ...defaultDesign(), ...raw.regionDesign }
  p.export = { ...defaultExport(), ...(raw.export ?? {}) }
  for (const k of ['imageFormat', 'videoFormat']) if (p.export[k] == null) delete p.export[k]
  const req = (arr, name) => { if (!Array.isArray(arr)) throw new StudioError(`프로젝트의 ${name} 데이터가 없습니다.`); return arr }
  p.faces = req(p.faces, '얼굴').map(f => ({ id: f.id ?? uuid(), name: String(f.name ?? ''), selected: f.selected !== false, ...(f.thumbnail ? { thumbnail: f.thumbnail } : {}), samples: req(f.samples, '얼굴 샘플') }))
  p.regions = req(p.regions, '영역').map(r => ({ ...r, id: r.id ?? uuid(), enabled: r.enabled !== false, keyframes: (r.keyframes ?? []).map(k => ({ ...k, id: k.id ?? uuid() })) }))
  p.captions = req(p.captions, '자막').map(c => ({ ...c, id: c.id ?? uuid(), text: String(c.text ?? '') }))
  p.clips = req(p.clips, '컷').map(c => ({ ...c, id: c.id ?? uuid() }))
  return p
}
const stripNulls = v => {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== null && v[k] !== undefined) out[k] = stripNulls(v[k])
    return out
  }
  return v
}
export const encodeProject = p => JSON.stringify(stripNulls(p))

// Clone for undo/edit: face samples are never mutated in place, so they can be shared.
export function cloneProject(p) {
  const { faces, ...rest } = p
  const copy = structuredClone(rest)
  copy.faces = faces.map(f => ({ ...f }))
  return copy
}
export function projectsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const { faces: fa, ...ra } = a, { faces: fb, ...rb } = b
  if (fa.length !== fb.length) return false
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i], y = fb[i]
    if (x.id !== y.id || x.name !== y.name || x.selected !== y.selected || x.samples !== y.samples || x.thumbnail !== y.thumbnail) {
      if (x.samples === y.samples || JSON.stringify(x) !== JSON.stringify(y)) return false
    }
  }
  return JSON.stringify(stripNulls(ra)) === JSON.stringify(stripNulls(rb))
}

export const EditTrack = { video: '영상', audio: '오디오 · 영상 연결', faces: '얼굴 · 영상 연결', regions: '영역 마스크', captions: '자막' }
export const linkedToVideo = k => k === 'video' || k === 'faces' || k === 'audio'
export const rowTitle = (kind, lane) => (kind === 'faces' || kind === 'audio') ? `${kind === 'audio' ? '오디오' : '얼굴 마스크'} ${lane + 1} · 연결` : `${EditTrack[kind]} ${lane + 1}`

export function timelineWheelDestination(current, delta, precise, fine, duration) {
  if (![delta, current, duration].every(finite)) return current
  const step = (precise ? 0.02 : 0.25) * (fine ? 0.1 : 1)
  return Math.min(Math.max(0, duration), Math.max(0, current - delta * step))
}
