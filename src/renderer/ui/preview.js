// Preview canvas with crop, region, caption and draw overlays (PreviewTimeline.swift).
import { html, useLayoutEffect, useRef, useState } from '../vendor.js'
import { store } from '../state.js'
import * as M from '../lib/model.js'
import { captionBox } from '../lib/render.js'
import { Icon } from './icons.js'
import { useTimeKey } from './common.js'

export function PreviewPane() {
  const s = store, p = s.project
  const host = useRef(), canvas = useRef()
  const [avail, setAvail] = useState({ w: 800, h: 500 })
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setAvail({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(host.current); return () => ro.disconnect()
  }, [])
  const pad = 24, aw = Math.max(1, avail.w - pad * 2), ah = Math.max(1, avail.h - 72)
  const ratio = s.loaded ? p.width / Math.max(1, p.height) : 16 / 9
  const width = Math.floor(Math.min(aw, ah * ratio)), height = Math.floor(width / ratio)
  useLayoutEffect(() => {
    const c = canvas.current
    if (!c) return
    // Render at display resolution, never above the source resolution.
    const dpr = window.devicePixelRatio || 1
    const pw = Math.max(1, Math.round(Math.min(width * dpr, p.width || width * dpr))), ph = Math.max(1, Math.round(pw * height / Math.max(1, width)))
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph }
    s.attachCanvas(c); s.drawPreview()
  })
  return html`<div class="preview" ref=${host}>
    ${s.loaded ? html`<div class="preview-inner">
      <div class="row tiny" style=${`width:${width}px;font-weight:500`}>
        <span class=${'row gap4 ' + (p.maskApplied ? 'mint' : 'muted')}><${Icon} name=${p.maskApplied ? 'shieldCheck' : 'eye'} size=${12} />${p.maskApplied ? '마스킹 적용됨' : '원본 미리보기'}</span>
        <span class="grow" /><span class="muted">${p.isImage ? 'IMAGE' : `${Math.round(p.fps)} FPS`}</span>
      </div>
      <div class="preview-box" style=${`width:${width}px;height:${height}px`}>
        <canvas ref=${canvas} />
        <${PreviewOverlays} width=${width} height=${height} />
      </div>
      <div class=${'tiny ' + (s.drawMode ? 'accentc' : 'muted')}>${s.drawMode ? '미리보기 위를 드래그해 가릴 영역을 지정하세요'
        : p.export.ratio === '원본' ? `${p.width} × ${p.height}  ·  원본 좌표로 편집` : '점선 안쪽이 내보내기 영역입니다 · 크롭 위치는 내보내기 설정에서 변경'}</div>
    </div>` : html`<div class="preview-inner"><${Welcome} /></div>`}
  </div>`
}

function PreviewOverlays({ width, height }) {
  const s = store, p = s.project
  useTimeKey(() => {
    const t = s.overlayTime
    const r = p.regions.find(r => r.id === s.selectedRegion)
    const c = p.captions.find(c => c.id === s.selectedCaption)
    return `${r && (p.isImage || (t >= r.start && t < r.end)) ? JSON.stringify(M.regionRectAt(r, t)) : ''}|${c && t >= c.start && t < c.end}`
  })
  const t = s.overlayTime
  const region = p.regions.find(r => r.id === s.selectedRegion)
  const caption = p.captions.find(c => c.id === s.selectedCaption)
  let crop = null
  if (p.export.ratio !== '원본') {
    const r = M.cropRect(p.export, width, height), top = height - r.y - r.height
    crop = html`<svg class="overlay-abs" style="inset:0;pointer-events:none" width=${width} height=${height}>
      <path d=${`M0 0H${width}V${height}H0Z M${r.x} ${top}H${r.x + r.width}V${top + r.height}H${r.x}Z`} fill="rgba(0,0,0,0.6)" fill-rule="evenodd" />
      <rect x=${r.x + 0.5} y=${top + 0.5} width=${Math.max(0, r.width - 1)} height=${Math.max(0, r.height - 1)} fill="none" stroke="rgba(255,255,255,0.75)" stroke-dasharray="5 4" />
    </svg>`
  }
  let guide = null
  if (s.tab === 'captions' && caption && t >= caption.start && t < caption.end) {
    const b = captionBox(caption, width, height, p.export.captionSize)
    guide = html`<div class="caption-guide" style=${`left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px`} />`
  }
  const showRegion = s.tab === 'regions' && !s.drawMode && region && region.enabled && (p.isImage || (t >= region.start && t < region.end))
  return html`${crop}
    ${showRegion && html`<${RegionTransformOverlay} region=${region} width=${width} height=${height} />`}
    ${guide}
    ${s.drawMode && html`<${DrawSurface} width=${width} height=${height} />`}`
}

function RegionTransformOverlay({ region, width, height }) {
  const s = store
  const rect = M.regionRectAt(region, s.overlayTime)
  const drag = resize => e => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    s.pause(); const origin = M.regionRectAt(region, s.overlayTime); s.beginTimelineGesture()
    const sx = e.clientX, sy = e.clientY
    const move = ev => {
      const dx = (ev.clientX - sx) / width, dy = (ev.clientY - sy) / height, r = { ...origin }
      if (resize) {
        r.width = Math.max(0.01, Math.min(1 - r.x, origin.width + dx))
        const top = origin.y + origin.height
        r.height = Math.max(0.01, Math.min(top, origin.height + dy)); r.y = top - r.height
      } else { r.x = Math.max(0, Math.min(1 - r.width, origin.x + dx)); r.y = Math.max(0, Math.min(1 - r.height, origin.y - dy)) }
      s.editRegionRect(region.id, r)
    }
    const up = () => { window.removeEventListener('pointermove', move); s.endTimelineGesture() }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
  return html`<div class="region-box" title="드래그: 영역 이동 · 오른쪽 아래 손잡이: 크기 조절 · 키프레임이 있으면 현재 위치에 기록"
    style=${`left:${rect.x * width}px;top:${(1 - rect.y - rect.height) * height}px;width:${rect.width * width}px;height:${rect.height * height}px`}
    onPointerDown=${drag(false)}><div class="region-handle" onPointerDown=${drag(true)} /></div>`
}

function DrawSurface({ width, height }) {
  const [box, setBox] = useState(null)
  const clamp = (e, el) => { const b = el.getBoundingClientRect(); return { x: Math.min(width, Math.max(0, e.clientX - b.left)), y: Math.min(height, Math.max(0, e.clientY - b.top)) } }
  const down = e => {
    if (e.button !== 0) return
    const el = e.currentTarget, a = clamp(e, el)
    let b = a
    const move = ev => { b = clamp(ev, el); setBox({ a, b }) }
    const up = () => {
      window.removeEventListener('pointermove', move); setBox(null)
      store.addRegion({ x: Math.min(a.x, b.x) / width, y: 1 - Math.max(a.y, b.y) / height, width: Math.abs(a.x - b.x) / width, height: Math.abs(a.y - b.y) / height })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
  }
  return html`<div class="draw-surface" onPointerDown=${down}>
    ${box && html`<div class="draw-rect" style=${`left:${Math.min(box.a.x, box.b.x)}px;top:${Math.min(box.a.y, box.b.y)}px;width:${Math.abs(box.a.x - box.b.x)}px;height:${Math.abs(box.a.y - box.b.y)}px`} />`}
  </div>`
}

function Welcome() {
  const mini = (icon, title, n) => html`<div class="col gap6" style="align-items:center;color:var(--muted)"><${Icon} name=${icon} size=${16} /><span class="tiny">${title}</span><span class="xs mono" style="opacity:0.5">${n}</span></div>`
  return html`<div class="welcome">
    <div class="welcome-art"><${Icon} name="imagePlus" size=${36} /></div>
    <div class="col gap10" style="align-items:center"><h1>기억은 선명하게,<br />얼굴은 안전하게.</h1><span class="muted" style="font-size:12px">영상과 사진을 이곳에 놓아주세요.</span></div>
    <button class="btn primary" onClick=${() => store.openMedia()}><${Icon} name="plus" /> 미디어 불러오기</button>
    <div class="small muted" style="line-height:1.7">MP4 · MOV · MKV · JPEG · PNG 외<br />파일 크기 제한 없이, 내장 ffmpeg 코덱으로</div>
    <div class="row" style="gap:24px;padding-top:16px">${mini('scan', '얼굴 찾기', '01')}${mini('shieldCheck', '선택해 가리기', '02')}${mini('exportArrow', '안전하게 내보내기', '03')}</div>
  </div>`
}

export function Transport() {
  const s = store, p = s.project
  const label = useTimeKey(() => `${M.timecode(s.playhead)} / ${M.timecode(M.editedDuration(s.project))}`)
  const off = !s.loaded || p.isImage
  return html`<div class="transport" style=${off ? 'opacity:0.4;pointer-events:none' : ''}>
    <span class="xs mono muted" style="letter-spacing:1px;font-weight:600">${p.isImage ? 'STILL IMAGE' : 'EDITED PREVIEW'}</span>
    <span class="grow" />
    ${!p.isImage && html`
      <button class="plain" title="5초 뒤로" onClick=${() => s.seek(Math.max(0, s.playhead - 5))}><${Icon} name="back" size=${16} /><span class="xs">5</span></button>
      <button class="round-btn" title="재생 / 일시정지 (Space)" onClick=${() => s.togglePlay()}><${Icon} name=${s.playing ? 'pause' : 'play'} size=${14} /></button>
      <button class="plain" title="5초 앞으로" onClick=${() => s.seek(Math.min(s.editedDuration, s.playhead + 5))}><span class="xs">5</span><${Icon} name="forward" size=${16} /></button>`}
    <span class="grow" />
    <span class="small mono muted">${label}</span>
  </div>`
}
