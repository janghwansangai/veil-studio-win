// Window layout (EditorView.swift): header, workspace navigation, libraries, preview, inspector, timeline.
import { html, useRef, useState, useErrorBoundary } from '../vendor.js'
import { store } from '../state.js'
import { EditorTab } from '../lib/store.js'
import { Icon, Logo } from './icons.js'
import { useStore, Check } from './common.js'
import { FaceLibrary, RegionLibrary, CaptionLibrary, MediaLibrary } from './panels.js'
import { SideInspector, ExportSheet, HelpSheet, ErrorAlert } from './inspector.js'
import { PreviewPane, Transport } from './preview.js'
import { TimelineView } from './timeline.js'

const bytes = n => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1000 && i < u.length - 1) { n /= 1000; i++ } return `${n.toFixed(i ? 1 : 0)} ${u[i]}` }
const readHeight = () => { try { return +localStorage.getItem('timelineHeight') || 310 } catch { return 310 } }

// A rendering bug in one panel must not blank the whole window; the store (and the project) survive.
export function SafeApp() {
  const [error, reset] = useErrorBoundary(e => window.require('electron').ipcRenderer.send('app:log', 'render: ' + (e?.stack ?? e)))
  if (error) return html`<div class="backdrop"><div class="sheet alert">
    <div style="font-size:15px;font-weight:600">화면을 그리는 중 오류가 발생했습니다</div>
    <div class="small muted" style="white-space:pre-wrap;user-select:text">${String(error?.message ?? error)}</div>
    <div class="row gap8"><span class="grow" /><button class="btn" onClick=${() => store.saveProjectIfPossible(true)}>프로젝트 다른 이름으로 저장</button><button class="btn primary" onClick=${reset}>화면 다시 표시</button></div>
  </div></div>`
  return html`<${App} />`
}

export function App() {
  const s = useStore(), p = s.project
  const [timelineHeight, setTimelineHeight] = useState(readHeight)
  const resize = e => {
    const start = timelineHeight, sy = e.clientY
    let latest = start
    const move = ev => { latest = Math.min(Math.max(240, window.innerHeight - 290), Math.max(200, start - (ev.clientY - sy))); setTimelineHeight(latest) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', () => { window.removeEventListener('pointermove', move); try { localStorage.setItem('timelineHeight', String(latest)) } catch {} }, { once: true })
  }
  const tabs = [['media', 'film'], ['faces', 'face'], ['regions', 'region'], ['captions', 'caption']]
  return html`<div class="shell">
    <div class="header">
      <div class="brand"><${Logo} /><span class="brand-name">veil</span><span class="brand-sub">STUDIO</span></div>
      <span class="vdivider" style="height:22px;align-self:center" />
      <div class="col gap4 grow" style="min-width:0">
        <span class="ellipsis" style="font-size:12px;font-weight:500">${s.fileName}</span>
        <span class="small muted ellipsis">${s.loaded ? `${p.width} × ${p.height}  ·  ${bytes(p.fileSize)}  ·  원본 보호` : '프라이버시를 위한 영상 · 이미지 편집기'}</span>
      </div>
      <span class="badge"><${Icon} name="lock" size=${11} />기기 내 처리</span>
      <button class="btn" title="프로젝트 저장 Ctrl+S" disabled=${!s.loaded || s.busy} onClick=${() => s.saveProject()}><${Icon} name="save" /></button>
      <button class="btn primary" disabled=${!s.loaded || s.busy} onClick=${() => { s.exportSheet = true; s.changed() }}><${Icon} name="exportArrow" /> 내보내기</button>
    </div>
    <div class="hdivider" />
    <div class=${'body' + (s.busy ? ' busy-lock' : '')}>
      <div class="nav">
        <div class="nav-title">WORKSPACE</div>
        ${tabs.map(([tab, icon]) => html`<button class=${'nav-item' + (s.tab === tab ? ' active' : '')} onClick=${() => { s.tab = tab; s.drawMode = false; s.changed() }}>
          <${Icon} name=${icon} size=${16} /><span>${EditorTab[tab]}</span>${s.tab === tab && html`<span class="nav-dot" />`}</button>`)}
        <div class="hdivider" style="margin:12px 0" />
        <button class="nav-link" onClick=${() => s.openMedia()}><${Icon} name="folderPlus" />${s.loaded && !p.isImage ? '미디어 추가' : '미디어 불러오기'}</button>
        <button class="nav-link" onClick=${() => s.openProject()}><${Icon} name="layers" />프로젝트 열기</button>
        <span class="grow" />
        <div class="promise">
          <${Icon} name="shield" size=${20} style="color:var(--mint)" />
          <span class="bold" style="font-size:11px">안심하고, 표현하세요.</span>
          <span class="small muted" style="line-height:1.6">사진과 영상은 이 PC에서<br />처리됩니다. 원본은 그대로.</span>
        </div>
        <button class="nav-link small muted" style="font-size:10px" onClick=${() => { s.helpSheet = true; s.changed() }}><${Icon} name="help" size=${13} />지원 형식 · 용량 안내</button>
        <span class="small mint" style="padding:0 10px;font-weight:500">제작자 다있쌤 로디</span>
        <span class="xs mono muted" style="padding:6px 10px 12px;opacity:0.65">VEIL STUDIO / ${window.veilEnv?.version ?? ''} · WINDOWS</span>
      </div>
      <span class="vdivider" />
      <div class="main">
        <${Toolbar} />
        <div class="hdivider" />
        <div class="workspace">
          ${s.tab === 'media' ? html`<${MediaLibrary} />` : s.tab === 'faces' ? html`<${FaceLibrary} />` : s.tab === 'regions' ? html`<${RegionLibrary} />` : html`<${CaptionLibrary} />`}
          <span class="vdivider" />
          <div class="center"><${PreviewPane} /><${Transport} /></div>
          <span class="vdivider" />
          <${SideInspector} />
        </div>
        <div class="resizer" title="위아래로 드래그하여 타임라인 높이 조절" onPointerDown=${resize} />
        <div style=${`height:${timelineHeight}px;flex:none;min-height:0`}><${TimelineView} /></div>
      </div>
    </div>
    <div class="statusbar">
      <span class="status-dot" style=${`background:${s.busy ? 'var(--accent)' : 'var(--mint)'}`} />
      <span class="ellipsis" style="max-width:40%">${s.runningJobs.length === 1 ? s.runningJobs[0].status : s.status}</span>
      <span class="grow" />
      ${s.runningJobs.map(j => html`<span key=${j.id} class="job" title=${j.status}><span class="ellipsis" style="max-width:150px">${j.label}</span><progress max="1" value=${j.progress} /><span class="mono">${Math.round(j.progress * 100)}%</span><button class="plain accentc" title="이 작업 취소" onClick=${() => j.cancel()}>✕</button></span>`)}
      ${s.lastExport && html`<button class="plain mint" onClick=${() => s.showLastExport()}>탐색기에서 보기</button>`}
      <span class="tiny muted">Ctrl+O 열기   ·   Ctrl+S 저장   ·   Ctrl+B 분할</span>
    </div>
    ${s.exportSheet && html`<${ExportSheet} />`}
    ${s.helpSheet && html`<${HelpSheet} />`}
    ${s.error && html`<${ErrorAlert} />`}
  </div>`
}

function Toolbar() {
  const s = store, p = s.project
  const subtitle = { media: '여러 영상·사진을 불러와 이어 붙이세요.', faces: '선택한 얼굴에만, 모든 장면에서.', regions: '가리고 싶은 부분을 직접 지정하세요.', captions: '말을 자막으로. 원하는 문장으로.' }[s.tab]
  return html`<div class="toolbar">
    <span style="font-size:14px;font-weight:600">${EditorTab[s.tab]}</span>
    <span class="small muted">${subtitle}</span>
    <span class="grow" />
    ${s.tab === 'media' ? html`<button class="btn" disabled=${s.busy} onClick=${() => s.loaded && !p.isImage ? s.importMedia() : s.openMedia()}><${Icon} name="folderPlus" /> 미디어 가져오기</button>`
    : s.tab === 'faces' ? html`
      ${!p.isImage && html`<${Check} checked=${s.autoCaptions} label="분석 후 자동 자막" onChange=${v => { s.autoCaptions = v; s.changed() }} />`}
      <button class="btn" disabled=${!s.loaded || s.jobs.running('faces').length > 0} onClick=${() => s.analyze()}><${Icon} name="scan" /> ${s.jobs.running('faces').length ? '분석 중…' : p.analysisComplete ? '다시 분석' : '얼굴 분석'}</button>`
    : s.tab === 'regions' ? html`<button class=${'btn' + (s.drawMode ? ' primary' : '')} disabled=${!s.loaded} onClick=${() => { s.drawMode = !s.drawMode; s.changed() }}><${Icon} name="region" /> ${s.drawMode ? '그리기 취소' : '영역 그리기'}</button>`
    : html`<button class="btn" disabled=${!s.loaded || p.isImage} onClick=${() => s.importSRT()}>SRT 가져오기</button>
      <button class="btn" disabled=${!s.loaded || p.isImage || s.jobs.running('speech').length > 0} onClick=${() => s.transcribe()}><${Icon} name="waveform" /> ${s.jobs.running('speech').length ? '인식 중…' : '자동 자막'}</button>`}
  </div>`
}
