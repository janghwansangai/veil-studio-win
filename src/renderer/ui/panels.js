// Left-hand libraries: faces, manual regions and captions (EditorView.swift).
import { html, useEffect, useRef, useState } from '../vendor.js'
import { store } from '../state.js'
import * as M from '../lib/model.js'
import { nodePath, run as ffmpegRun, fileURL, stillFramePath, nodeFs } from '../lib/media.js'
import { SpeechModels } from '../lib/speech.js'
import { FaceModes } from '../lib/faces.js'
import { dialogs } from '../lib/store.js'
import { Icon } from './icons.js'
import { SectionLabel, EmptyHint, Slider, TimeField, TextInput, Select, useTimeKey } from './common.js'

export function FaceLibrary() {
  const s = store, p = s.project, selected = p.faces.filter(f => f.selected).length
  const multi = !!p.media
  const seekFace = face => { const id = M.mediaOf(p, face), t = face.samples.find(x => M.timelineTime(p, x.time, null, id) != null)?.time; if (t != null) s.seekSource(t, id) }
  return html`<div class="library">
    <${SectionLabel} title="감지된 인물 후보" detail=${p.faces.length} />
    <details class="small"><summary style="font-size:11px">얼굴 분석 설정</summary>
      <div class="col gap8" style="padding-top:8px">
        <div class="row gap8"><span style="width:44px">정밀도</span><${Select} class="field grow" value=${s.faceOptions.mode} options=${Object.entries(FaceModes)} onChange=${mode => { s.faceOptions = { ...s.faceOptions, mode }; s.changed() }} /></div>
        <${Slider} label="검출 민감도" value=${1 - s.faceOptions.threshold} min=${0.1} max=${0.6} step=${0.05} suffix=${s.faceOptions.threshold <= 0.5 ? '높음' : s.faceOptions.threshold <= 0.7 ? '보통' : '낮음'} onInput=${v => { s.faceOptions = { ...s.faceOptions, threshold: Math.round((1 - v) * 100) / 100 }; s.changed() }} />
        <div class="row gap8"><span style="width:44px">장치</span><${Select} class="field grow" value=${s.faceOptions.device} options=${[['cpu', 'CPU (권장)'], ['gpu', 'GPU (DirectML · CPU가 약한 PC용)']]} onChange=${device => { s.faceOptions = { ...s.faceOptions, device }; s.changed() }} /></div>
        <div class="note">민감도를 높이면 작은·흐린 얼굴도 찾지만 얼굴이 아닌 곳이 후보로 나올 수 있습니다.</div>
      </div>
    </details>
    ${!p.faces.length ? html`<${EmptyHint} icon="face" title=${p.analysisComplete ? '검출된 얼굴이 없어요' : '어떤 얼굴을 가릴까요?'}
        text=${p.analysisComplete ? '작거나 가려진 얼굴은 영역 마스크로 보완하세요.' : '미디어를 불러오고 얼굴 분석을\n누르면 인물 썸네일이 표시됩니다.'} />` : html`
      <div class="row small muted">
        <button class="plain" onClick=${() => s.setAllFaces(true)}>전체 선택</button><span class="grow" />
        <button class="plain" onClick=${() => s.setAllFaces(false)}>선택 해제</button>
      </div>
      <div class="scroll grow col gap6">
        ${p.faces.map(face => html`<div key=${face.id} class=${'card face-row' + (face.selected ? ' sel' : '')} onClick=${() => seekFace(face)} title="클릭하면 이 후보가 처음 보이는 위치로 이동">
          <input type="checkbox" checked=${face.selected} onClick=${e => e.stopPropagation()} onChange=${e => s.toggleFace(face.id, e.target.checked)} />
          ${face.thumbnail ? html`<img class="thumb" src=${'data:image/jpeg;base64,' + face.thumbnail} />` : html`<div class="thumb" />`}
          <div class="col gap4 grow"><div class="bold" style="font-size:11px;overflow-wrap:anywhere">${face.name}</div><div class="tiny muted">${face.samples.length} 프레임${multi ? ` · ${M.mediaName(M.mediaById(p, face.media))}` : ''}</div></div>
        </div>`)}
      </div>
      <button class="link small" disabled=${selected < 2} onClick=${() => s.mergeSelected()}><${Icon} name="users" size=${13} /> 선택 후보를 같은 인물로 묶기</button>
      <div class="note">자동 분류는 인물 후보입니다. 재등장·옆얼굴·가림 장면은 직접 검토하세요.</div>
      <button class="btn primary wide" onClick=${() => s.applyMasks()}><${Icon} name="shieldCheck" /> 마스킹 적용<span style="margin-left:auto">${selected}</span></button>`}
  </div>`
}

export function RegionLibrary() {
  const s = store, p = s.project
  const details = useRef()
  useEffect(() => { if (s.selectedRegion) details.current?.scrollIntoView({ block: 'nearest' }) }, [s.selectedRegion])
  const region = p.regions.find(r => r.id === s.selectedRegion)
  return html`<div class="library">
    <${SectionLabel} title="직접 지정한 영역" detail=${p.regions.length} />
    ${!p.regions.length ? html`<${EmptyHint} icon="region" title="범위를 직접 그리세요" text=${'영역 그리기를 누른 뒤 미리보기에서\n드래그하세요. 얼굴·이름·번호판 등\n원하는 곳을 가릴 수 있습니다.'} />` : html`
      <div class="scroll grow col gap8">
        ${p.regions.map(r => html`<div key=${r.id} class=${'item-row' + (s.selectedRegion === r.id ? ' sel' : '')}>
          <input type="checkbox" title="사용" checked=${r.enabled} onChange=${e => s.updateItem('regions', r.id, { enabled: e.target.checked })} />
          <button class="grow ellipsis" style="text-align:left" onClick=${() => s.selectOverlay(r.id, true)}>${r.name}</button>
          <button class="plain muted" title="삭제" onClick=${() => s.edit(p => { p.regions = p.regions.filter(x => x.id !== r.id) })}><${Icon} name="trash" size=${13} /></button>
        </div>`)}
        ${region && html`<div ref=${details}><${RegionControls} key=${region.id} region=${region} /></div>`}
      </div>`}
    <div class="note">영역 모양과 효과는 오른쪽에서 조정합니다. 키프레임 사이의 위치·크기는 부드럽게 연결됩니다.</div>
  </div>`
}

function RegionControls({ region }) {
  const s = store
  useTimeKey(() => region.keyframes.length ? JSON.stringify(M.regionRectAt(region, s.overlayTime)) : '')
  const t = s.overlayTime, rect = M.regionRectAt(region, t)
  const set = (key, value) => s.updateItem('regions', region.id, r => {
    const time = s.overlayTime, next = { ...M.regionRectAt(r, time), [key]: value }
    next.width = Math.min(next.width, 1 - next.x); next.height = Math.min(next.height, 1 - next.y)
    const out = { rect: next }
    if (r.keyframes.length) out.keyframes = [...r.keyframes.filter(k => Math.abs(k.time - time) >= 0.02), { id: M.uuid(), time, rect: next }]
    return out
  })
  const number = (label, edge) => html`<div class="row gap8 small"><span class="grow">${label}</span>
    <${TimeField} title=${label} value=${edge < 0 ? region.start : region.end} onCommit=${v => s.editOverlayTime(region.id, true, { start: region.start, end: region.end }, v - (edge < 0 ? region.start : region.end), edge)} /></div>`
  return html`<div class="col gap12" style="padding-top:8px;border-top:1px solid var(--line);margin-top:4px">
    <${TextInput} value=${region.name} placeholder="영역 이름" onInput=${v => s.updateItem('regions', region.id, { name: v })} />
    <${Slider} label="가로 위치" value=${rect.x} max=${0.95} onInput=${v => set('x', v)} />
    <${Slider} label="세로 위치 (아래 기준)" value=${rect.y} max=${0.95} onInput=${v => set('y', v)} />
    <${Slider} label="너비" value=${rect.width} min=${0.01} max=${Math.max(0.01, 1 - rect.x)} onInput=${v => set('width', v)} />
    <${Slider} label="높이" value=${rect.height} min=${0.01} max=${Math.max(0.01, 1 - rect.y)} onInput=${v => set('height', v)} />
    ${!s.project.isImage && html`
      ${number('시작 (초)', -1)}${number('종료 (초)', 1)}
      <button class="btn" onClick=${() => s.addKeyframe()}><${Icon} name="diamond" size=${12} /> 현재 위치에 키프레임 저장</button>
      <div class="tiny muted">첫 키프레임을 저장한 후, 다른 시간에서 위치·크기를 바꾸면 키프레임이 자동 추가됩니다.</div>
      ${[...region.keyframes].sort((a, b) => a.time - b.time).map(k => html`<div key=${k.id} class="row small">
        <button class="plain mono" onClick=${() => s.seek(k.time)}>${M.timecode(k.time)}</button><span class="grow" />
        <button class="plain muted" onClick=${() => s.updateItem('regions', region.id, r => ({ keyframes: r.keyframes.filter(x => x.id !== k.id) }))}><${Icon} name="x" size=${11} /></button>
      </div>`)}`}
  </div>`
}

export function CaptionLibrary() {
  const s = store, p = s.project, o = s.speechOptions
  const setOption = patch => { s.speechOptions = { ...o, ...patch }; s.changed() }
  const rows = useRef({})
  useEffect(() => { rows.current[s.selectedCaption]?.scrollIntoView({ block: 'nearest' }) }, [s.selectedCaption])
  const active = useTimeKey(() => p.captions.filter(c => s.overlayTime >= c.start && s.overlayTime < c.end).map(c => c.id).join())
  const chooseModel = async () => {
    const file = await dialogs.open({ title: 'whisper.cpp 다국어 ggml 모델 선택', properties: ['openFile'], filters: [{ name: 'ggml 모델', extensions: ['bin'] }, { name: '모든 파일', extensions: ['*'] }] })
    if (file) setOption({ whisperModelPath: file })
  }
  const disabled = !s.loaded || p.isImage
  return html`<div class="library">
    <${SectionLabel} title="수정 가능한 자막" detail=${p.captions.length} />
    ${s.speechNotes.length > 0 && html`<details class="orange small"><summary>인식 결과 · 검토할 구간 ${s.speechNotes.length}개</summary>
      <div class="scroll col gap8" style="max-height:130px;padding-top:6px;user-select:text">${s.speechNotes.map((n, i) => html`<div key=${i}>${n}</div>`)}</div></details>`}
    <div class="col gap6 small">
      <div class="row gap8"><span style="width:52px">인식 언어</span><${Select} class="field grow" value=${s.language} options=${[['ko-KR', '한국어'], ['en-US', 'English'], ['ja-JP', '日本語']]} onChange=${v => { s.language = v; s.changed() }} /></div>
      <div class="row gap8"><span style="width:52px">인식 모델</span>${o.whisperModelPath
        ? html`<span class="grow ellipsis mint" title=${o.whisperModelPath}>${nodePath.basename(o.whisperModelPath)}</span><button class="plain tiny" onClick=${() => setOption({ whisperModelPath: '' })}>기본</button>`
        : html`<${Select} class="field grow" value=${o.model} options=${Object.entries(SpeechModels).map(([k, v]) => [k, v.label])} onChange=${model => setOption({ model })} />`}</div>
      <div class="row gap8"><span style="width:52px">처리 장치</span><${Select} class="field grow" value=${o.device} options=${[['auto', '자동 · NVIDIA GPU 우선'], ['cpu', 'CPU만 사용']]} onChange=${device => setOption({ device })} /></div>
      <div class="row gap8"><span style="width:52px">배경음악</span><${Select} class="field grow" value=${o.separate} options=${[['auto', '자동 제거 · GPU 있을 때'], ['on', '항상 제거 (CPU에서는 느림)'], ['off', '제거하지 않음']]} onChange=${separate => setOption({ separate })} /></div>
      <label class="row gap6"><input type="checkbox" checked=${o.vad} onChange=${e => setOption({ vad: e.target.checked })} /><span>음성 구간만 인식 (음악·무음 헛인식 방지)</span></label>
    </div>
    <details class="small" disabled=${s.busy}><summary style="font-size:11px">음성 인식 미세 조정</summary>
      <div class="col gap8" style="padding-top:8px">
        <div class="row gap8"><span>음성 증폭</span><input type="range" class="grow" min="0.25" max="4" step="0.25" value=${o.gain} onInput=${e => setOption({ gain: +e.target.value })} /><span class="mono">${o.gain.toFixed(2)}×</span></div>
        <div class="row gap8"><span class="grow">오디오 트랙 ${o.audioTrack + 1}</span>
          <button class="btn" style="padding:2px 8px" onClick=${() => setOption({ audioTrack: Math.max(0, o.audioTrack - 1) })}>−</button>
          <button class="btn" style="padding:2px 8px" onClick=${() => setOption({ audioTrack: Math.min(15, o.audioTrack + 1) })}>+</button></div>
        <button class="btn" onClick=${chooseModel}>다른 whisper.cpp 모델 파일 선택…</button>
        <input class="field" placeholder="고유명사·전문용어 (쉼표로 구분)" value=${o.hints} onInput=${e => setOption({ hints: e.target.value })} onKeyDown=${e => e.stopPropagation()} />
        <button class="btn" disabled=${!s.canEditTimeline} onClick=${() => s.transcribe(true)}>현재 위치부터 최대 15초 시험 인식</button>
        <div class="muted" style="line-height:1.5">정확도 우선 모델은 한국어·배경음에 강하고, NVIDIA GPU가 있으면 자동으로 GPU를 씁니다. 작은 목소리는 1.5–2×로 시험하세요. 증폭은 분석에만 적용되며 과증폭이 높으면 배율을 낮추세요. 시험 결과는 기존 자막을 바꾸지 않습니다.</div>
      </div>
    </details>
    ${!p.captions.length ? html`<${EmptyHint} icon="caption" title="말을 담는 또 하나의 방법" text=${'자동 자막을 생성하거나 SRT 파일을\n가져오세요. 문장과 표시 시간을\n직접 바꿀 수 있습니다.'} />`
      : html`<div class="scroll grow col gap10">${p.captions.map(c => html`<div key=${c.id} ref=${el => { rows.current[c.id] = el }}>
          <${CaptionRow} caption=${c} highlighted=${s.selectedCaption === c.id || active.includes(c.id)} /></div>`)}</div>`}
    <div class="row small">
      <button class="plain" disabled=${disabled} onClick=${() => s.addCaption()}><${Icon} name="plus" size=${12} /> 추가</button><span class="grow" />
      <button class="plain" disabled=${disabled || !p.captions.length} onClick=${() => s.exportSRT()}>SRT 저장</button>
    </div>
  </div>`
}

function CaptionRow({ caption: c, highlighted }) {
  const s = store
  const update = patch => s.updateItem('captions', c.id, patch)
  const time = edge => v => s.editOverlayTime(c.id, false, { start: c.start, end: c.end }, v - (edge < 0 ? c.start : c.end), edge)
  return html`<div class=${'caption-card' + (highlighted ? ' sel' : '')}>
    <div class="row small mono">
      <button class="plain accentc" onClick=${() => { s.selectOverlay(c.id, false); s.seek(c.start) }}>${M.timecode(c.start)}</button><span class="grow" />
      <button class="plain muted" title="삭제" onClick=${() => s.edit(p => { p.captions = p.captions.filter(x => x.id !== c.id) })}><${Icon} name="x" size=${11} /></button>
    </div>
    <${TextInput} multiline class="caption-text" value=${c.text} placeholder="자막 내용" onInput=${v => update({ text: v })} />
    <details class="small"><summary>화면 위치 · 자막 폭</summary>
      <div class="col gap6 tiny" style="padding-top:6px">
        <div class="row gap6"><span style="width:22px">가로</span><div class="grow"><${Slider} value=${c.horizontal ?? 0.5} onInput=${v => update({ horizontal: v })} /></div></div>
        <div class="row gap6"><span style="width:22px">세로</span><div class="grow"><${Slider} value=${c.vertical ?? 0.055} onInput=${v => update({ vertical: v })} /></div></div>
        <div class="row gap6"><span style="width:22px">폭</span><div class="grow"><${Slider} value=${c.boxWidth ?? 0.86} min=${0.1} onInput=${v => update({ boxWidth: v })} /></div></div>
        <button class="plain" onClick=${() => update({ horizontal: undefined, vertical: undefined, boxWidth: undefined })}>기본 위치</button>
      </div>
    </details>
    <div class="row gap6 tiny"><${TimeField} title="시작 (초)" value=${c.start} onCommit=${time(-1)} /><span>→</span><${TimeField} title="종료 (초)" value=${c.end} onCommit=${time(1)} /></div>
  </div>`
}

// ---------- Media library (several files per project) ----------
const thumbs = new Map()
function useThumb(m, onReady) {
  if (thumbs.has(m.id)) return thumbs.get(m.id)
  thumbs.set(m.id, null)
  if (m.isImage) { thumbs.set(m.id, fileURL(m.path)); return thumbs.get(m.id) }
  const target = stillFramePath(m).replace(/\.png$/, '_thumb.jpg')
  if (nodeFs.existsSync(target)) { thumbs.set(m.id, fileURL(target)); return thumbs.get(m.id) }
  nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true })
  ffmpegRun(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.min(1, m.duration / 3)), '-i', m.path, '-frames:v', '1', '-vf', 'scale=320:-2', target], { allowFailure: true })
    .then(() => { if (nodeFs.existsSync(target)) { thumbs.set(m.id, fileURL(target)); onReady() } })
  return null
}
function dragMedia(e, m, click) {
  if (e.button !== 0) return
  const sx = e.clientX, sy = e.clientY
  let ghost = null, over = null
  const laneAt = (x, y) => document.elementsFromPoint(x, y).find(el => el.dataset?.laneKind && M.linkedToVideo(el.dataset.laneKind)) ?? null
  const mark = el => { if (over === el) return; over?.classList.remove('drop'); over = el; over?.classList.add('drop') }
  const move = ev => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) { ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = M.mediaName(m); document.body.append(ghost) }
    if (!ghost) return
    ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 10}px`
    mark(laneAt(ev.clientX, ev.clientY))
  }
  const up = ev => {
    window.removeEventListener('pointermove', move); mark(null)
    if (!ghost) return click()
    ghost.remove()
    const lane = laneAt(ev.clientX, ev.clientY)
    if (lane) { const b = lane.getBoundingClientRect(); store.dropMedia(m.id, +lane.dataset.lane, (ev.clientX - b.left) / b.width * Math.max(0.01, +lane.dataset.duration || store.editedDuration)) }
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true })
}
export function MediaLibrary() {
  const s = store, p = s.project, media = s.media
  const [, force] = useState(0)
  const uses = id => p.clips.filter(c => M.mediaOf(p, c) === id).length
  const place = (id, how) => s.placeMedia(id, how)
  const body = !s.loaded
    ? html`<${EmptyHint} icon="film" title="영상·사진을 불러오세요" text=${'여러 파일을 한 번에 선택하거나\n창에 끌어다 놓으면 순서대로\n타임라인에 이어 붙입니다.'} />`
    : p.isImage
      ? html`<${EmptyHint} icon="imagePlus" title="사진 편집 프로젝트" text=${'사진 한 장을 편집하는 중입니다.\n여러 파일을 이어 붙이려면\n파일 → 새 프로젝트에서 영상으로 시작하세요.'} />`
      : html`<div class="scroll grow col gap8">${media.map((m, i) => {
          const thumb = useThumb(m, () => force(x => x + 1)), sel = s.selectedMedia === m.id
          return html`<div key=${m.id} class=${'media-row' + (sel ? ' sel' : '')} title="타임라인으로 끌어다 놓아 배치 · E 끝에 추가 · W 삽입 · Q 위 트랙에 연결"
            onPointerDown=${e => dragMedia(e, m, () => { s.selectedMedia = m.id; s.changed() })}>
            ${thumb ? html`<img class="media-thumb" src=${thumb} draggable="false" />` : html`<div class="media-thumb" />`}
            <div class="row gap6"><span class="bold ellipsis grow">${i === 0 ? '★ ' : ''}${M.mediaName(m)}</span><span class="tiny muted">${m.isImage ? '사진' : M.timecode(m.duration)}</span></div>
            <div class="tiny muted">${Math.round(m.width)}×${Math.round(m.height)}${m.isImage ? '' : ` · ${Math.round(m.fps)}fps · 오디오 ${m.audioCount ?? 0}`} · 타임라인 ${uses(m.id)}곳</div>
            ${sel && html`<div class="row gap4 tiny" onPointerDown=${e => e.stopPropagation()}>
              <button class="plain" title="타임라인 끝에 추가 (E)" onClick=${() => place(m.id, 'append')}>끝에 추가</button>
              <button class="plain" title="재생 위치에 삽입 (W)" onClick=${() => place(m.id, 'insert')}>삽입</button>
              <button class="plain" title="재생 위치 위 트랙에 연결 (Q)" onClick=${() => place(m.id, 'connect')}>연결</button>
              <span class="grow" />${i > 0 && html`<button class="plain muted" title="프로젝트에서 빼기" onClick=${() => s.removeMedia(m.id)}><${Icon} name="trash" size=${12} /></button>`}
            </div>`}
          </div>`
        })}</div>
        <button class="btn wide" onClick=${() => s.importMedia()}><${Icon} name="folderPlus" /> 미디어 가져오기…</button>`
  return html`<div class="library">
    <${SectionLabel} title="프로젝트 미디어" detail=${media.length} />
    ${body}
    <div class="note">★ 표시 파일이 프로젝트의 기준 해상도·프레임률입니다. 크기가 다른 파일은 화면에 맞춰(레터박스) 들어갑니다.</div>
  </div>`
}
