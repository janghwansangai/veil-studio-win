// Timeline: zoomable ruler with markers and export range, linked video/audio/face rows,
// independent region/caption rows, snapping, multi-file clips (Final Cut Pro style basics).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../vendor.js'
import { store } from '../state.js'
import * as M from '../lib/model.js'
import { dialogs } from '../lib/store.js'
import { Icon } from './icons.js'
import { NumberField } from './common.js'

const ROW = 31, LABEL = 105, GAP = 12, SNAP_PX = 8

export function TimelineView() {
  const s = store, p = s.project
  const clip = p.clips.find(c => c.id === s.selectedClip)
  const body = useRef(), line = useRef()
  const [view, setView] = useState({ width: 600, scroll: 0 })
  const zoom = s.timelineZoom, duration = Math.max(0.01, M.editedDuration(p)), W = Math.max(1, view.width * zoom), pps = W / duration
  useLayoutEffect(() => {
    const el = body.current
    const ro = new ResizeObserver(() => setView(v => ({ ...v, width: Math.max(1, el.clientWidth - LABEL - GAP) })))
    ro.observe(el); return () => ro.disconnect()
  }, [])
  // Keep the playhead in view after zoom changes and while playing.
  const lastZoom = useRef(zoom)
  useLayoutEffect(() => {
    const el = body.current
    if (lastZoom.current !== zoom) {
      lastZoom.current = zoom
      const x = W * s.playhead / duration
      el.scrollLeft = Math.max(0, x - view.width / 2)
    }
  }, [zoom])
  // The playhead line is moved directly so playback never re-renders the timeline.
  useEffect(() => {
    const place = () => {
      const el = body.current, ln = line.current
      if (!el || !ln) return
      const x = W * store.playhead / duration
      if (store.playing && zoom > 1 && (x < el.scrollLeft || x > el.scrollLeft + view.width - 20)) el.scrollLeft = Math.max(0, x - view.width * 0.2)
      const left = LABEL + GAP + x - el.scrollLeft
      ln.style.left = `${left}px`; ln.style.display = left < LABEL + GAP - 1 || left > LABEL + GAP + view.width + 1 ? 'none' : ''
    }
    place(); return store.on('time', place)
  }, [W, p, view.width, view.scroll])
  const onScroll = e => setView(v => ({ ...v, scroll: e.currentTarget.scrollLeft }))
  // Ctrl+wheel zooms around the pointer; Shift+wheel scrolls sideways.
  const onWheel = e => {
    const el = body.current
    if (e.ctrlKey) {
      e.preventDefault()
      const rect = el.getBoundingClientRect(), cursor = e.clientX - rect.left - LABEL - GAP
      const t = (el.scrollLeft + cursor) / pps, next = Math.max(1, Math.min(200, zoom * (e.deltaY < 0 ? 1.25 : 0.8)))
      s.setZoom(next)
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, t * view.width * next / duration - cursor) })
    } else if (e.shiftKey && zoom > 1) { e.preventDefault(); el.scrollLeft += e.deltaY }
  }
  const rows = s.timelineRows, rangeOff = !s.canEditTimeline || !p.clips.length
  const labelSelected = row => (s.selectedTrack === row.kind || (M.linkedToVideo(s.selectedTrack) && M.linkedToVideo(row.kind))) && s.selectedLane === row.lane
  const ctx = { W, pps, duration, scroll: view.scroll, viewport: view.width, zoomWheel: onWheel }
  return html`<div class="timeline" style="height:100%">
    <div class="tl-bar" style="height:34px">
      <span class="row gap6 bold" style="font-size:11px"><${Icon} name="sliders" size=${13} />${M.EditTrack[s.selectedTrack]}</span>
      <button title="실행 취소 Ctrl+Z" disabled=${!s.undoStack.length} onClick=${() => s.undo()}><${Icon} name="undo" /></button>
      <button title="다시 실행 Ctrl+Y" disabled=${!s.redoStack.length} onClick=${() => s.redo()}><${Icon} name="redo" /></button>
      <span class="vdivider" style="height:14px;align-self:center" />
      <button title="재생 위치에서 분할 Ctrl+B" disabled=${!s.canEditTimeline} onClick=${() => s.split()}><${Icon} name="scissors" /> 분할</button>
      <button title="선택 잘라내기 Ctrl+X" disabled=${!s.selectionAvailable} onClick=${() => s.editSelection('cut')}><${Icon} name="cut" /></button>
      <button title="선택 복사 Ctrl+C" disabled=${!s.selectionAvailable} onClick=${() => s.editSelection('copy')}><${Icon} name="copy" /></button>
      <button title="재생 위치에 붙여넣기 Ctrl+V" disabled=${!s.canEditTimeline || !s.pasteAvailable} onClick=${() => s.editSelection('paste')}><${Icon} name="paste" /></button>
      <button title="선택 삭제 후 붙이기 Delete · 빈 구간 남기고 삭제 Shift+Delete" disabled=${!s.selectionAvailable} onClick=${() => s.editSelection('delete')}><${Icon} name="trash" /></button>
      <button title="선택 앞으로 이동 Ctrl+Alt+←" disabled=${!s.selectionAvailable} onClick=${() => s.moveSelected(-1)}><${Icon} name="toStart" /></button>
      <button title="선택 뒤로 이동 Ctrl+Alt+→" disabled=${!s.selectionAvailable} onClick=${() => s.moveSelected(1)}><${Icon} name="toEnd" /></button>
      <button title="컷 사용 / 사용 안 함 V" disabled=${!s.canDeleteClips} onClick=${() => s.toggleClipEnabled()}><${Icon} name="eye" /></button>
      <button title="마커 추가 M" disabled=${!s.canEditTimeline} onClick=${() => s.addMarker()}><${Icon} name="diamond" /></button>
      <span class="grow" />
      ${clip && html`<span class="muted">원본 구간</span>
        <${NumberField} title="원본 시작" value=${clip.start} onCommit=${v => s.trimClip(clip.id, v, null)} /><span>–</span>
        <${NumberField} title="원본 끝" value=${clip.end} onCommit=${v => s.trimClip(clip.id, null, v)} />`}
      <span class="muted">편집 후 ${M.timecode(M.editedDuration(p))}</span>
    </div>
    <div class="tl-bar" style=${'height:32px' + (rangeOff ? ';opacity:0.4;pointer-events:none' : '')}>
      <span class="row gap6 mint"><${Icon} name="crop" size=${12} />내보내기 구간</span>
      <button onClick=${() => s.markIn()}>시작 I</button>
      <button onClick=${() => s.markOut()}>끝 O</button>
      <${NumberField} title="내보내기 시작" value=${p.exportRange?.start ?? 0} onCommit=${v => s.setExportRange(v, p.exportRange?.end ?? M.editedDuration(p))} /><span>–</span>
      <${NumberField} title="내보내기 끝" value=${p.exportRange?.end ?? M.editedDuration(p)} onCommit=${v => s.setExportRange(p.exportRange?.start ?? 0, v)} />
      <span class="muted">초</span>
      <button disabled=${!s.selectionAvailable} onClick=${() => s.exportSelectedClips()}>선택 컷 범위</button>
      <button disabled=${!p.exportRange} onClick=${() => s.clearExportRange()}>범위 해제</button>
      <button disabled=${!p.exportRange} onClick=${() => s.deleteMarkedRange()}>범위 삭제</button>
      <span class="grow" />
      <span class="mint">${p.exportRange ? '지정 구간' : '전체'} · ${M.timecode(M.exportDuration(p))}</span>
    </div>
    <div class="tl-bar" style="height:25px">
      <button onClick=${async () => { const id = await dialogs.contextMenu([{ id: 'video', label: '영상 트랙' }, { id: 'regions', label: '영역 마스크 트랙' }, { id: 'captions', label: '자막 트랙' }]); if (id) s.addLane(id) }}><${Icon} name="plus" size=${12} /> 트랙 추가</button>
      <button onClick=${() => s.edit(q => M.separateOverlappingOverlays(q))}>겹친 항목 분리</button>
      <span class="muted">블록 우클릭 → 트랙 이동 · 위쪽 트랙이 앞에 표시됩니다</span>
      <span class="grow" />
      <button title="스냅 (N)" class=${s.snapping ? 'accentc' : ''} onClick=${() => s.toggleSnapping()}>스냅 ${s.snapping ? '켬' : '끔'}</button>
      <span class="vdivider" style="height:12px;align-self:center" />
      <button title="축소 Ctrl+-" disabled=${zoom <= 1} onClick=${() => s.setZoom(zoom / 1.5)}>−</button>
      <span class="mono muted" style="min-width:42px;text-align:center">${zoom <= 1 ? '전체' : `${zoom.toFixed(zoom < 10 ? 1 : 0)}×`}</span>
      <button title="확대 Ctrl+=" onClick=${() => s.setZoom(zoom * 1.5)}>+</button>
      <button title="타임라인 전체 보기 Shift+Z" disabled=${zoom <= 1} onClick=${() => s.setZoom(1)}>맞춤</button>
    </div>
    <div class="tl-grid">
      <div class="tl-ruler-row"><span class="tl-labels tiny" style="padding-top:2px">편집 시간</span><${Ruler} ...${ctx} /></div>
      <div class="tl-body" ref=${body} onScroll=${onScroll} onWheel=${onWheel}>
        <div class="tl-scroll-inner" style=${`width:${LABEL + GAP + W}px`}>
          <div class="col tl-sticky">${rows.map(row => html`<button key=${row.id} class=${'tl-label' + (labelSelected(row) ? ' sel' : '')} onClick=${() => s.selectLane(row.kind, row.lane)}>${row.title}</button>`)}</div>
          <${Lanes} rows=${rows} ...${ctx} />
        </div>
      </div>
      <div class="playhead" ref=${line} />
    </div>
    <div class="tiny muted" style="padding:4px 0 8px">컷: 드래그로 순서·트랙 이동 · 양 끝: 길이 조절 · Ctrl+휠: 확대/축소 · ←/→ 프레임 · ↑/↓ 편집점 · J/K/L 재생 · M 마커 · V 사용 안 함</div>
  </div>`
}

// Tick spacing that keeps labels ~90 px apart at any zoom.
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
function Ruler({ W, pps, duration, scroll, viewport, zoomWheel }) {
  const s = store, p = s.project, canvas = useRef()
  useLayoutEffect(() => {
    const c = canvas.current, dpr = window.devicePixelRatio || 1
    c.width = Math.round(viewport * dpr); c.height = Math.round(44 * dpr)
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.lineWidth = 1
    const major = STEPS.find(v => v * pps >= 90) ?? STEPS[STEPS.length - 1], minor = major / 5
    const t0 = Math.floor(scroll / pps / minor) * minor, t1 = (scroll + viewport) / pps
    ctx.font = '9px "Segoe UI", sans-serif'; ctx.fillStyle = '#858fa1'
    for (let t = t0; t <= Math.min(duration, t1) + 1e-9; t += minor) {
      const x = Math.round(t * pps - scroll) + 0.5, isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
      ctx.strokeStyle = isMajor ? '#858fa1' : 'rgba(133,143,161,0.4)'
      ctx.beginPath(); ctx.moveTo(x, isMajor ? 19 : 29); ctx.lineTo(x, 40); ctx.stroke()
      if (isMajor) ctx.fillText(M.timecode(t), Math.min(viewport - 44, x + 2), 12)
    }
  }, [W, pps, duration, scroll, viewport])
  const timeAt = (e, el) => { const b = el.getBoundingClientRect(); return Math.min(duration, Math.max(0, (e.clientX - b.left + scroll) / pps)) }
  const seekAt = (e, el) => { s.focusTimeline(); s.seek(s.snap(timeAt(e, el), SNAP_PX / pps)) }
  const down = e => {
    if (e.button !== 0) return
    const el = e.currentTarget; seekAt(e, el)
    const move = ev => seekAt(ev, el)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true })
  }
  const wheel = e => {
    if (e.ctrlKey) return zoomWheel(e)
    e.preventDefault()
    const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    const lines = e.deltaMode === 1 ? raw : raw / 100
    s.focusTimeline(); s.pause(); s.seek(M.timelineWheelDestination(s.playhead, -lines, false, e.shiftKey, duration))
  }
  const handle = isStart => e => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const origin = isStart ? p.exportRange.start : p.exportRange.end, sx = e.clientX
    s.beginTimelineGesture()
    const move = ev => {
      const next = s.snap(origin + (ev.clientX - sx) / pps, SNAP_PX / pps), r = store.project.exportRange
      if (isStart) s.setExportRange(next, r?.end ?? duration); else s.setExportRange(r?.start ?? 0, next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); s.endTimelineGesture() }, { once: true })
  }
  const markerMenu = m => async e => {
    e.preventDefault(); e.stopPropagation()
    const id = await dialogs.contextMenu([{ id: 'go', label: `${m.name} · ${M.timecode(m.time)}로 이동` }, { id: 'delete', label: '마커 삭제' }])
    if (id === 'go') s.seek(m.time); if (id === 'delete') s.deleteMarker(m.id)
  }
  const r = p.exportRange, x = t => t * pps - scroll
  return html`<div class="ruler" style=${`width:${viewport}px`} title="클릭·드래그로 이동 · 휠로 재생 위치 이동 · Shift+휠 미세 이동 · Ctrl+휠 확대/축소" onPointerDown=${down} onWheel=${wheel}>
    <canvas ref=${canvas} style=${`width:${viewport}px;height:44px`} />
    ${(p.markers ?? []).map(m => html`<div key=${m.id} class="marker" title=${`${m.name} · ${M.timecode(m.time)} (우클릭: 삭제)`} style=${`left:${x(m.time)}px;top:17px`}
      onPointerDown=${e => { e.stopPropagation(); s.seek(m.time) }} onContextMenu=${markerMenu(m)} />`)}
    ${r && html`<div class="range-bar" style=${`left:${x(r.start)}px;width:${(r.end - r.start) * pps}px`} />
      <div class="range-handle" style=${`left:${Math.max(4, Math.min(viewport - 4, x(r.start)))}px`} onPointerDown=${handle(true)}>I</div>
      <div class="range-handle" style=${`left:${Math.max(4, Math.min(viewport - 4, x(r.end)))}px`} onPointerDown=${handle(false)}>O</div>`}
  </div>`
}

function Lanes({ rows, W, pps, duration }) {
  const s = store, p = s.project, timeline = M.timeline(p), multi = !!p.media
  const regionItems = M.overlayItems(p, true), captionItems = M.overlayItems(p, false)
  return html`<div class="lanes" style=${`width:${W}px;height:${rows.length * ROW}px`}>
    ${rows.map((row, i) => html`<div key=${row.id} class="lane" data-lane-kind=${row.kind} data-lane=${row.lane} data-duration=${duration} style=${`top:${i * ROW}px`}>
      ${M.linkedToVideo(row.kind) ? html`
        ${M.gaps(p, row.lane).map(gap => html`<div class="gap-hit" style=${`left:${gap.start * pps}px;width:${(gap.end - gap.start) * pps}px`}
          onContextMenu=${async e => { e.preventDefault(); if (await dialogs.contextMenu([{ id: 'close', label: '빈 구간 삭제 후 붙이기' }]) === 'close') s.closeGap(gap, row.lane) }} />`)}
        ${timeline.filter(e => (e.clip.lane ?? 0) === row.lane).map(entry => {
          const w = Math.max(1, M.clipDuration(entry.clip) * pps), style = `left:${entry.start * pps}px;width:${w}px`
          return row.kind === 'video' ? html`<${ClipCell} key=${entry.id} entry=${entry} style=${style} pps=${pps} w=${w} multi=${multi} />`
            : html`<${LinkedCell} key=${entry.id} entry=${entry} kind=${row.kind} style=${style} pxWidth=${w} pps=${pps} />`
        })}` : (row.kind === 'regions' ? regionItems : captionItems).filter(it => it.lane === row.lane).map(item =>
          html`<${OverlayBlock} key=${item.sourceID} item=${item} pps=${pps} style=${`left:${item.start * pps}px;width:${Math.max(22, (item.end - item.start) * pps)}px`} />`)}
    </div>`)}
  </div>`
}

// Pointer drag that becomes a move/reorder after 4px; otherwise it is a click.
function dragBlock(e, id, label, click, pps) {
  if (e.button !== 0) return
  const sx = e.clientX, sy = e.clientY
  let ghost = null, over = null
  const mark = el => { if (over === el) return; over?.classList.remove('drop'); over = el; over?.classList.add('drop') }
  const move = ev => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) { ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = label; document.body.append(ghost) }
    if (!ghost) return
    ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 10}px`
    mark(document.elementsFromPoint(ev.clientX, ev.clientY).find(el => el.dataset?.laneKind) ?? null)
  }
  const up = ev => {
    window.removeEventListener('pointermove', move); mark(null)
    if (!ghost) return click(e)
    ghost.remove()
    const els = document.elementsFromPoint(ev.clientX, ev.clientY)
    const target = els.find(el => el.dataset?.clipCell && el.dataset.clipId !== id)
    if (target && (store.project.videoLaneCount ?? 1) <= 1) {
      const b = target.getBoundingClientRect(), clips = store.project.clips, idx = clips.findIndex(c => c.id === target.dataset.clipId)
      return store.moveClip(id, ev.clientX < b.left + b.width / 2 ? target.dataset.clipId : clips[idx + 1]?.id ?? null)
    }
    const lane = els.find(el => el.dataset?.laneKind)
    if (lane) {
      const b = lane.getBoundingClientRect(), entry = M.timeline(store.project).find(x => x.id === id)
      // Keep the grab offset so the clip lands where it was dropped, then snap its start.
      const grab = entry ? (sx - (b.left + entry.start * pps)) / pps : 0
      const t = (ev.clientX - b.left) / pps - Math.max(0, grab)
      store.moveItem(id, lane.dataset.laneKind, +lane.dataset.lane, store.snap(Math.max(0, t), SNAP_PX / pps, id))
    }
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
}
const laneMenu = (label, prefix, newLabel) => ({ label, submenu: [...Array(store.laneCount('video')).keys()].map(l => ({ id: `lane:${l}`, label: `${prefix} ${l + 1}` })).concat([{ id: 'lane:new', label: newLabel }]) })
function moveToLane(id, choice) {
  if (choice === 'lane:new') { store.addLane('video'); store.moveItem(id, 'video', store.selectedLane) }
  else store.moveItem(id, 'video', +choice.slice(5))
}

function ClipCell({ entry, style, pps, w, multi }) {
  const s = store, sel = M.linkedToVideo(s.selectedTrack) && s.selectedClips.has(entry.id)
  const clip = s.project.clips[entry.index] ?? entry.clip, media = M.mediaById(s.project, clip.media)
  const click = e => { s.selectClip(entry.id, e.ctrlKey || e.metaKey); s.seek(entry.start) }
  const trim = start => e => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const origin = start ? entry.clip.start : entry.clip.end, edge = start ? entry.start : entry.end, sx = e.clientX
    let begun = false
    const move = ev => {
      if (!begun) { if (Math.abs(ev.clientX - sx) < 1) return; begun = true; s.beginTimelineGesture(); s.selectClip(entry.id) }
      const at = s.snap(edge + (ev.clientX - sx) / pps, SNAP_PX / pps, entry.id), time = origin + (at - edge)
      if (start) s.trimClip(entry.id, time, null); else s.trimClip(entry.id, null, time)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); if (begun) s.endTimelineGesture() }, { once: true })
  }
  const menu = async e => {
    e.preventDefault()
    const id = await dialogs.contextMenu([laneMenu('트랙으로 이동', '영상', '새 영상 트랙'), { type: 'separator' },
      { id: 'select', label: '이 컷 선택' }, { id: 'copy', label: '복사' }, { id: 'cut', label: '잘라내기' }, { id: 'delete', label: '삭제 후 붙이기' }, { id: 'lift', label: '빈 구간 남기고 삭제' },
      { id: 'toggle', label: clip.disabled ? '컷 다시 사용' : '컷 사용 안 함' }, { id: 'props', label: '클립 속성…' }, { type: 'separator' },
      { id: 'left', label: '앞으로 이동' }, { id: 'right', label: '뒤로 이동' }, { id: 'export', label: '이 컷만 내보내기' }])
    if (!id) return
    if (id.startsWith('lane:')) return moveToLane(entry.id, id)
    s.selectClip(entry.id)
    ;({ copy: () => s.copyClips(), cut: () => s.cutClips(), delete: () => s.deleteClip(), lift: () => s.liftClips(), toggle: () => s.toggleClipEnabled(), props: () => { s.inspectorView = 'clip'; s.changed() },
      left: () => s.moveSelected(-1), right: () => s.moveSelected(1), export: () => s.exportSelectedClips() })[id]?.()
  }
  const label = multi ? M.mediaName(media) : `컷 ${entry.index + 1}`
  const badges = [(clip.volume ?? 0) !== 0 ? `${clip.volume > 0 ? '+' : ''}${clip.volume.toFixed(1)}dB` : '', clip.muted ? '무음' : '', (clip.brightness || (clip.contrast ?? 1) !== 1 || (clip.saturation ?? 1) !== 1) ? '색' : ''].filter(Boolean).join(' · ')
  return html`<div class=${'block clip-cell' + (sel ? ' sel' : '') + (clip.disabled ? ' off' : '')} style=${style} data-clip-cell="1" data-clip-id=${entry.id}
      title=${`${M.mediaName(media)} · ${M.timecode(entry.clip.start)}–${M.timecode(entry.clip.end)} 원본 구간${clip.disabled ? ' · 사용 안 함' : ''} · 드래그해서 이동`}
      onPointerDown=${e => dragBlock(e, entry.id, label, click, pps)} onContextMenu=${menu}>
    ${clip.fadeIn > 0 && html`<div class="fade-mark" style=${`left:0;width:${clip.fadeIn * pps}px;background:linear-gradient(90deg,rgba(0,0,0,0.55),transparent)`} />`}
    ${clip.fadeOut > 0 && html`<div class="fade-mark" style=${`right:0;width:${clip.fadeOut * pps}px;background:linear-gradient(270deg,rgba(0,0,0,0.55),transparent)`} />`}
    <${Icon} name=${media.isImage ? 'imagePlus' : 'film'} size=${11} /><span class="ellipsis">${label}</span>
    ${w > 130 && html`<span class="muted">${M.timecode(M.clipDuration(entry.clip))}</span>`}
    ${badges && w > 90 && html`<span class="muted ellipsis">${badges}</span>`}
    ${w > 24 && html`<div class="trim" style="left:1px" onPointerDown=${trim(true)} /><div class="trim" style="right:1px" onPointerDown=${trim(false)} />`}
  </div>`
}

function LinkedCell({ entry, kind, style, pxWidth, pps }) {
  const s = store, sel = M.linkedToVideo(s.selectedTrack) && s.selectedClips.has(entry.id), canvas = useRef()
  const clip = entry.clip, muted = s.project.export.muted, mediaId = M.mediaOf(s.project, clip)
  const original = s.project.clips[entry.index] ?? clip, silent = original.muted || original.disabled
  const coverage = s.faceCoverage.get(mediaId), wave = s.waveformFor(mediaId)
  useLayoutEffect(() => {
    // Canvas width is capped; very zoomed-in cells are stretched instead of allocating huge bitmaps.
    const c = canvas.current, dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.min(4096, Math.round(pxWidth)))
    c.width = Math.round(w * dpr); c.height = Math.round(25 * dpr)
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr)
    const d = M.clipDuration(clip)
    if (kind === 'audio') {
      ctx.strokeStyle = 'rgba(50,173,230,0.2)'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(0, 12.5); ctx.lineTo(w, 12.5); ctx.stroke()
      if (!wave?.hasAudio || !(d > 0)) return
      const gain = Math.min(2, Math.pow(10, (original.volume ?? 0) / 20))
      ctx.fillStyle = muted || silent ? 'rgba(133,143,161,0.5)' : 'rgba(50,173,230,0.8)'
      for (let x = 0; x < w; x++) {
        const peak = wave.peak(clip.start + x / w * d, clip.start + (x + 1) / w * d), h = Math.min(23, Math.sqrt(peak * gain) * 23)
        if (h > 0) ctx.fillRect(x, 12.5 - h / 2, 1, h)
      }
    } else {
      ctx.fillStyle = 'rgba(186,235,156,0.5)'
      for (const span of coverage ?? []) {
        if (!(span.end > clip.start && span.start < clip.end)) continue
        const a = Math.max(clip.start, span.start), b = Math.min(clip.end, span.end)
        ctx.fillRect((a - clip.start) / d * w, 0, Math.max(1, (b - a) / d * w), 25)
      }
    }
  }, [pxWidth, clip.start, clip.end, kind, s.waveformRevision, coverage, wave, muted, silent, original.volume])
  const click = e => { s.selectClip(entry.id, e.ctrlKey || e.metaKey); s.selectedTrack = kind; s.seek(entry.start); s.changed() }
  const menu = async e => {
    e.preventDefault()
    const id = await dialogs.contextMenu([laneMenu('연결된 세트 트랙 이동', '영상 세트', '새 영상 세트'), { id: 'delete', label: '연결된 세트 삭제' }, { id: 'mute', label: original.muted ? '음소거 해제' : '이 컷 음소거' }])
    if (!id) return
    if (id === 'delete') { s.selectClip(entry.id); s.deleteClip() }
    else if (id === 'mute') { s.selectClip(entry.id); s.setClipAttrs({ muted: !original.muted }) }
    else moveToLane(entry.id, id)
  }
  return html`<div class=${`block linked ${kind}${sel ? ' sel' : ''}${original.disabled ? ' off' : ''}`} style=${style} title=${kind === 'audio' ? '원본 첫 번째 오디오의 파형 · 영상 컷과 함께 잘리고 이동합니다' : '얼굴 마스크 적용 구간 · 영상 컷과 연결'}
      onPointerDown=${e => dragBlock(e, entry.id, `컷 ${entry.index + 1} 세트`, click, pps)} onContextMenu=${menu}>
    <canvas ref=${canvas} />
    ${kind === 'audio' && s.waveformStatus && !wave && html`<span class="wave-status">${s.waveformStatus}</span>`}
  </div>`
}

function OverlayBlock({ item, pps, style }) {
  const s = store
  const sel = item.region ? s.selectedTrack === 'regions' && s.selectedRegion === item.sourceID : s.selectedTrack === 'captions' && s.selectedCaption === item.sourceID
  const gesture = edge => e => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    s.pause(); s.focusTimeline(); s.beginTimelineGesture(); s.selectOverlay(item.sourceID, item.region)
    const list = item.region ? s.project.regions : s.project.captions, x = list.find(v => v.id === item.sourceID)
    if (!x) return s.endTimelineGesture()
    const original = { start: x.start, end: x.end }, sx = e.clientX, tol = SNAP_PX / pps
    s.seek(item.start)
    const move = ev => {
      let delta = (ev.clientX - sx) / pps
      // Snap the edge being dragged; for a move, whichever edge is closer to an edit point.
      const adj = t => s.snap(t, tol, item.sourceID) - t
      if (edge < 0) delta += adj(original.start + delta)
      else if (edge > 0) delta += adj(original.end + delta)
      else { const a = adj(original.start + delta), b = adj(original.end + delta); delta += a !== 0 && (b === 0 || Math.abs(a) <= Math.abs(b)) ? a : b }
      if (Math.abs(delta) > 0.000001) s.editOverlayTime(item.sourceID, item.region, original, delta, edge)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); s.endTimelineGesture() }, { once: true })
  }
  const menu = async e => {
    e.preventDefault()
    const kind = item.region ? 'regions' : 'captions'
    const id = await dialogs.contextMenu([{ label: '트랙으로 이동', submenu: [...Array(s.laneCount(kind)).keys()].map(l => ({ id: `lane:${l}`, label: `트랙 ${l + 1}` })).concat([{ id: 'lane:new', label: '새 트랙' }]) }])
    if (!id) return
    if (id === 'lane:new') { s.addLane(kind); s.moveItem(item.sourceID, kind, s.selectedLane) } else s.moveItem(item.sourceID, kind, +id.slice(5))
  }
  return html`<div class=${`block overlay-block ${item.region ? 'region' : 'caption'}${sel ? ' sel' : ''}`} style=${style} onContextMenu=${menu} title="가운데: 길이 유지 이동 · 양 끝: 트림 · 선택한 트랙만 편집">
    <div class="edge" onPointerDown=${gesture(-1)} /><div class="mid" onPointerDown=${gesture(0)}>${item.title}</div><div class="edge" onPointerDown=${gesture(1)} />
  </div>`
}
