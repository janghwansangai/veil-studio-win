// Ports of the pure-logic XCTests from the macOS project.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as M from '../src/renderer/lib/model.js'

const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)
const clip = (start, end, extra = {}) => ({ id: M.uuid(), start, end, ...extra })
function timelineProject() {
  const p = M.newProject(); p.width = 1920; p.height = 1080; p.duration = 10
  p.clips = [clip(0, 2), clip(5, 7), clip(8, 10)]
  return p
}

test('ripple delete, move, paste and duplicate', () => {
  const p = timelineProject(); const last = p.clips[2].id
  M.removeTimelineClips(p, new Set([p.clips[1].id]))
  assert.deepEqual(M.timeline(p).map(e => e.start), [0, 2]); assert.equal(M.editedDuration(p), 4)
  assert.equal(M.sourceTime(p, 2.5), 8.5)
  M.moveTimelineClip(p, last, p.clips[0].id)
  assert.equal(M.sourceTime(p, 0.5), 8.5); assert.equal(M.sourceTime(p, 2.5), 0.5)
  const copied = [p.clips[0]]
  const ids = M.insertTimelineClips(p, copied, 1)
  assert.equal(M.editedDuration(p), 6); assert.equal(p.clips.length, 4)
  assert.deepEqual(M.timeline(p).map(e => e.start), [0, 1, 3, 4]); assert.equal(M.sourceTime(p, 1.5), 8.5)
  assert.equal(M.sourceTime(p, 3.5), 9.5); assert.equal(new Set(p.clips.map(c => c.id)).size, p.clips.length)
  assert.equal(ids.length, 1); M.validate(p)
  M.removeTimelineClips(p, new Set(p.clips.map(c => c.id))); assert.equal(p.clips.length, 0)
  M.insertTimelineClips(p, copied, 0); assert.equal(M.editedDuration(p), 2)
})

test('selection range slices cuts and captions', () => {
  const p = timelineProject(); p.sourcePath = 'C:/tmp/source.mov'
  p.captions = [{ id: M.uuid(), start: 1, end: 2, text: 'A' }, { id: M.uuid(), start: 5, end: 7, text: 'B' }, { id: M.uuid(), start: 8, end: 10, text: 'C' }]
  p.exportRange = { start: 1.5, end: 4.5 }
  M.validate(p)
  const out = M.projectForExport(p)
  assert.deepEqual(out.clips.map(c => c.start), [1.5, 5, 8]); assert.deepEqual(out.clips.map(c => c.end), [2, 7, 8.5]); assert.equal(M.editedDuration(out), 3)
  assert.deepEqual(M.outputCaptions(p).map(c => c.start), [0, 0.5, 2.5]); assert.deepEqual(M.outputCaptions(p).map(c => c.end), [0.5, 2.5, 3])
  assert.deepEqual(M.outputCaptions(p, false).map(c => c.start), [1, 2, 4])
  const saved = M.decodeProject(M.encodeProject(p)); assert.deepEqual(saved.exportRange, p.exportRange)
  M.deleteTimelineRange(p, p.exportRange); assert.equal(M.editedDuration(p), 3)
  assert.deepEqual(p.clips.map(c => c.start), [0, 8.5]); assert.deepEqual(p.clips.map(c => c.end), [1.5, 10]); assert.equal(p.exportRange, undefined)
})

test('subtitle roundtrip and malformed input', () => {
  const captions = [{ start: 1.25, end: 2.5, text: '안녕\n두 줄' }, { start: 3600.001, end: 3601, text: 'B' }]
  const parsed = M.Subtitles.parse(M.Subtitles.srt(captions))
  assert.deepEqual(parsed.map(c => [c.start, c.end, c.text]), [[1.25, 2.5, '안녕\n두 줄'], [3600.001, 3601, 'B']])
  assert.equal(M.Subtitles.parse('garbage\n\n1\n00:00:05,000 --> 00:00:04,000\nX').length, 0)
  assert.equal(M.Subtitles.parse('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF\r\n').length, 1)
})

test('face interpolation does not bridge disappearance', () => {
  const r = M.rect(0.1, 0.1, 0.2, 0.2), s = M.rect(0.3, 0.3, 0.2, 0.2)
  const face = { samples: [{ time: 0, rect: r }, { time: 0.1, rect: s }, { time: 2, rect: s }] }
  near(M.faceRectAt(face, 0.05).x, 0.2)
  assert.equal(M.faceRectAt(face, 1), null)
})

test('keyframes and crop geometry', () => {
  const region = { rect: M.rect(0, 0, 0.1, 0.1), keyframes: [{ time: 0, rect: M.rect(0, 0, 0.1, 0.1) }, { time: 2, rect: M.rect(0.4, 0, 0.1, 0.1) }] }
  near(M.regionRectAt(region, 1).x, 0.2)
  const e = M.defaultExport(); e.ratio = '9:16'; e.resolution = '원본 크기'
  const crop = M.cropRect(e, 1920, 1080)
  near(crop.width, 607.5); near(crop.x, (1920 - 607.5) / 2)
  assert.deepEqual(M.outputSize(e, 1920, 1080), { width: 606, height: 1080 })
  e.ratio = '원본'; e.resolution = 'HD · 720p'
  assert.deepEqual(M.outputSize(e, 1920, 1080), { width: 1280, height: 720 })
})

test('invalid projects rejected and offscreen faces repaired', () => {
  const p = timelineProject(); p.clips.push(clip(9, 12))
  assert.throws(() => M.validate(p), M.StudioError)
  const q = timelineProject()
  q.faces = [{ id: M.uuid(), name: 'A', selected: true, samples: [{ time: 1, rect: M.rect(-0.1, 0.5, 0.3, 0.6) }] }]
  assert.equal(M.repairFaceBounds(q), 1); near(q.faces[0].samples[0].rect.x, 0); near(q.faces[0].samples[0].rect.height, 0.5)
  M.validate(q)
  q.faces[0].samples = [{ time: 1, rect: M.rect(2, 2, 0.1, 0.1) }]
  assert.throws(() => M.repairFaceBounds(q), M.StudioError)
})

test('independent overlay tracks migration', () => {
  const invalid = M.newProject(); invalid.captions = [{ id: M.uuid(), start: 58.13, end: 4, text: 'repair' }]
  assert.equal(M.repairEditableTimes(invalid), 1); assert.ok(invalid.captions[0].end > 58.13)
  const p = timelineProject()
  p.captions = [{ id: M.uuid(), start: 0.5, end: 1.5, text: 'A' }, { id: M.uuid(), start: 5, end: 6, text: 'B' }]
  p.regions = [{ id: M.uuid(), name: 'M', enabled: true, start: 0, end: 10, rect: M.rect(0.2, 0.2, 0.3, 0.3), keyframes: [] }]
  M.migrateOverlayTimeline(p)
  assert.deepEqual(p.captions.map(c => c.start), [0.5, 2]); assert.equal(p.regions.length, 3)
  const saved = M.encodeProject(p); M.migrateOverlayTimeline(p); assert.equal(M.encodeProject(p), saved)
  p.exportRange = { start: 0.5, end: 1.5 }
  const out = M.projectForExport(p)
  assert.equal(out.captions[0].start, 0); assert.equal(out.captions[0].end, 1); assert.equal(out.regions[0].start, 0)
})

test('overlay lanes and analysis ranges', () => {
  const p = timelineProject(); p.clips.push(clip(1, 3), clip(5.5, 6))
  assert.deepEqual(M.analysisRanges(p), [{ start: 0, end: 3 }, { start: 5, end: 7 }, { start: 8, end: 10 }])
  p.captions = [{ id: M.uuid(), start: 0, end: 2, text: 'A' }, { id: M.uuid(), start: 1, end: 3, text: 'B' }, { id: M.uuid(), start: 3, end: 4, text: 'C' }]
  const region = (s, e) => ({ id: M.uuid(), name: 'R', enabled: true, start: s, end: e, rect: M.rect(0, 0, 0.5, 0.5), keyframes: [] })
  p.regions = [region(0, 2), region(1, 3)]
  M.separateOverlappingOverlays(p)
  assert.deepEqual(p.captions.map(c => c.lane ?? 0), [0, 1, 0]); assert.equal(p.regionLaneCount, 2)
  const saved = M.encodeProject(p); M.separateOverlappingOverlays(p); assert.equal(M.encodeProject(p), saved)
  assert.equal(M.encodeProject(M.decodeProject(saved)), saved)
})

test('layered video timeline', () => {
  const p = timelineProject(); p.videoLaneCount = 2; p.duration = 2
  p.clips = [clip(0, 2, { lane: 0, position: 0 }), clip(1, 1.5, { lane: 1, position: 0.25 })]
  assert.equal(M.editedDuration(p), 2)
  near(M.sourceTime(p, 0.3), 1.05); near(M.sourceTime(p, 0.8), 0.8)
  near(M.mappedSourceTime(M.visibleTimeline(p), 0.3), 1.05)
  M.splitTimeline(p, 0.5, p.clips[1].id)
  assert.equal(p.clips.length, 3); assert.equal(p.clips[0].end, 2)
  M.validate(p)
  const q = timelineProject(); q.clips = [clip(0, 0.5, { lane: 0, position: 0 }), clip(1, 1.5, { lane: 0, position: 1 })]
  assert.deepEqual(M.gaps(q, 0), [{ start: 0.5, end: 1 }])
  assert.equal(M.mappedSourceTime(M.visibleTimeline(q), 0.75), -1)
})

test('wheel destination', () => {
  assert.equal(M.timelineWheelDestination(5, 4, false, false, 10), 4)
  near(M.timelineWheelDestination(5, 4, false, true, 10), 4.9)
  assert.equal(M.timelineWheelDestination(0.1, 10, false, false, 10), 0)
})

test('decodes a project saved by the macOS app', async () => {
  const fs = await import('node:fs')
  const path = new URL('../../mask_child_mac/output/', import.meta.url)
  let file
  try { file = fs.readdirSync(path).find(f => f.endsWith('.veilproject')) } catch { return }
  if (!file) return
  const p = M.decodeProject(fs.readFileSync(new URL(file, path), 'utf8'))
  M.repairFaceBounds(p); M.repairEditableTimes(p); M.validate(p)
  assert.ok(p.faces.length > 0 && p.clips.length > 0)
  assert.ok(M.decodeProject(M.encodeProject(p)))
})
