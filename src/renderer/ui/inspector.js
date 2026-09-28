// Right-hand design inspector plus the export and help sheets (Inspector.swift).
import { html } from '../vendor.js'
import { store } from '../state.js'
import * as M from '../lib/model.js'
import { Icon } from './icons.js'
import { SectionLabel, Slider, Select, Check, graphemes } from './common.js'

const hex = d => '#' + [d.red, d.green, d.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
const setExport = patch => store.edit(p => { p.export = { ...p.export, ...patch } })

export function DesignInspector({ embedded = false }) {
  const s = store, p = s.project, regions = s.tab === 'regions'
  const design = regions ? M.regionDesign(p) : M.faceDesign(p)
  const set = patch => s.edit(q => { const d = { ...(regions ? M.regionDesign(q) : M.faceDesign(q)), ...patch }; if (regions) q.regionDesign = d; else q.faceDesign = d })
  const swatch = effect => effect === '모자이크'
    ? html`<div class="pix">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => html`<i style=${`opacity:${((i % 4 + (i >> 2)) % 3 + 1) * 0.3}`} />`)}</div>`
    : html`<${Icon} name=${effect === '블러' ? 'drop' : effect === '단색' ? 'circle' : 'smile'} size=${24} style=${effect === '블러' ? 'filter:blur(1.5px)' : ''} />`
  return html`<div class=${embedded ? '' : 'inspector'} style=${s.loaded || embedded ? '' : 'pointer-events:none;opacity:0.5'}>
    <div class="col gap14" style="padding:16px">
      <${SectionLabel} title=${regions ? '영역 마스크 디자인' : '얼굴 마스크 디자인'} detail=${regions ? '영역에만 적용' : '얼굴에만 적용'} />
      <div class="note">${regions ? '직접 지정한 영역의 효과와 모양입니다. 얼굴 마스크 설정은 유지됩니다.' : '선택한 얼굴의 효과와 모양입니다. 영역 마스크 설정은 유지됩니다.'}</div>
      <div class="col gap8"><span class="small muted">효과</span>
        <div class="seg">${Object.values(M.MaskEffect).map(effect => html`<button class=${'effect-btn' + (design.effect === effect ? ' sel' : '')} onClick=${() => set({ effect })}>
          <div class="effect-swatch">${swatch(effect)}</div>${effect}</button>`)}</div>
      </div>
      <div class="col gap8"><span class="small muted">영역 모양</span>
        <${Select} value=${design.shape} options=${Object.values(M.MaskShape).map(v => [v, v])} onChange=${shape => set({ shape })} />
        ${(design.shape === '하트' || design.shape === '별') && html`<div class="tiny orange" style="line-height:1.5">하트·별의 가장자리는 비어 있습니다. 가릴 부분을 충분히 덮도록 크기를 조절하세요.</div>`}
      </div>
      <${Slider} label="효과 강도" value=${design.strength} onInput=${strength => set({ strength })} />
      ${!regions && html`<${Slider} label="얼굴 여백" value=${design.margin} max=${1.5} onInput=${margin => set({ margin })} />`}
      ${(design.effect === '단색' || design.effect === '스티커') && html`<label class="row gap8 small"><span class="grow">마스크 색상</span>
        <input type="color" value=${hex(design)} onInput=${e => { const v = e.target.value; set({ red: parseInt(v.slice(1, 3), 16) / 255, green: parseInt(v.slice(3, 5), 16) / 255, blue: parseInt(v.slice(5, 7), 16) / 255 }) }} /></label>`}
      ${design.effect === '스티커' && html`<input class="field" placeholder="스티커 문자 / 이모지" value=${design.sticker} onKeyDown=${e => e.stopPropagation()}
        onInput=${e => { const v = graphemes(e.target.value).slice(0, 4).join(''); if (v !== e.target.value) e.target.value = v; set({ sticker: v }) }} />`}
      <div class="hdivider" />
      <${SectionLabel} title="화면 비율" detail="크롭 미리보기" />
      <${Select} value=${p.export.ratio} options=${M.CropRatios.map(([v]) => [v, v])} onChange=${ratio => setExport({ ratio })} />
      ${p.export.ratio !== '원본' && html`<${Slider} label="크롭 가로 위치" value=${p.export.cropX} onInput=${cropX => setExport({ cropX })} /><${Slider} label="크롭 세로 위치" value=${p.export.cropY} onInput=${cropY => setExport({ cropY })} />`}
      ${s.tab === 'captions' && html`<div class="hdivider" />
        <${Check} class="row gap6" checked=${p.export.burnCaptions} label="영상에 자막 입히기" onChange=${burnCaptions => setExport({ burnCaptions })} />
        <${Slider} label="자막 크기 (짧은 변 기준)" value=${p.export.captionSize} min=${0.025} max=${0.09} onInput=${captionSize => setExport({ captionSize })} />`}
      <div class="hdivider" />
      <div class="col gap8">
        <div class="row gap6 mint bold" style="font-size:11px"><${Icon} name="shieldCheck" /> 내보내기 전 검토</div>
        <div class="note" style="line-height:1.6">작은 얼굴, 옆얼굴, 가려진 얼굴은 놓칠 수 있습니다. 전체 영상을 확인하고 부족한 곳은 영역 마스크로 보완하세요.</div>
        ${p.analysisComplete && html`<div class="tiny mono accentc">${p.faces.length}개 후보  ·  남은 컷 분석</div>`}
      </div>
    </div>
  </div>`
}

export function ExportSheet() {
  const s = store, p = s.project, e = p.export
  const size = M.outputSize(e, p.width, p.height, !p.isImage)
  const close = () => { s.exportSheet = false; s.changed() }
  return html`<div class="backdrop" onMouseDown=${ev => { if (ev.target === ev.currentTarget) close() }}>
    <div class="sheet" style="width:650px">
      <div class="row"><div class="col gap6 grow"><h2>마무리도, 원하는 대로.</h2><span class="muted" style="font-size:12px">편집 결과를 새 파일로 저장합니다.</span></div><${Icon} name="exportArrow" size=${30} style="color:var(--mint)" /></div>
      <div class="hdivider" />
      <div class="row gap14" style="align-items:flex-start;gap:30px">
        <div class="col gap14" style="width:300px">
          <div class="form-row"><span>화면 비율</span><${Select} value=${e.ratio} options=${M.CropRatios.map(([v]) => [v, v])} onChange=${ratio => setExport({ ratio })} /></div>
          <div class="form-row"><span>해상도</span><${Select} value=${e.resolution} options=${M.Resolutions.map(([v]) => [v, v])} onChange=${resolution => setExport({ resolution })} /></div>
          ${p.isImage ? html`<div class="form-row"><span>이미지 형식</span><${Select} value=${M.resolvedImageFormat(e)} options=${M.ImageOutputs.map(v => [v, v.toUpperCase()])} onChange=${imageFormat => setExport({ imageFormat })} /></div>`
            : html`<div class="form-row"><span>영상 형식</span><${Select} value=${e.videoFormat ?? 'mp4'} options=${M.VideoOutputs.map(v => [v, v.toUpperCase()])} onChange=${videoFormat => setExport({ videoFormat })} /></div>
              <div class="form-row"><span>영상 코덱</span><${Select} value=${e.hevc} options=${[[false, 'H.264 · 높은 호환성'], [true, 'HEVC · 효율적인 용량']]} onChange=${hevc => setExport({ hevc })} /></div>
              <${Check} checked=${e.muted} label="오디오 제외" onChange=${muted => setExport({ muted })} />
              <${Check} checked=${e.burnCaptions} label="자막을 영상에 입히기" onChange=${burnCaptions => setExport({ burnCaptions })} />`}
          ${e.ratio !== '원본' && html`<${Slider} label="크롭 가로 위치" value=${e.cropX} onInput=${cropX => setExport({ cropX })} /><${Slider} label="크롭 세로 위치" value=${e.cropY} onInput=${cropY => setExport({ cropY })} />`}
        </div>
        <div class="summary">
          <span class="tiny muted bold" style="letter-spacing:2px">${p.exportRange ? 'OUTPUT · 지정 구간' : 'OUTPUT · 전체 타임라인'}</span>
          <span style="font-size:24px;font-weight:500;color:var(--ink)">${size.width} × ${size.height}</span>
          <span class="muted" style="font-size:11px">${p.isImage ? `${M.resolvedImageFormat(e).toUpperCase()} 이미지` : `${M.videoExtension(e).toUpperCase()} · ${M.timecode(M.exportDuration(p))} · 최대 ${Math.floor(Math.min(120, p.fps))} fps`}</span>
          <div class="hdivider" />
          <span class="row gap6"><${Icon} name="check" size=${12} /> 원본 덮어쓰기 방지</span>
          <span class="row gap6"><${Icon} name="check" size=${12} /> GPS·원본 메타데이터 제외</span>
          <span class="row gap6"><${Icon} name="check" size=${12} /> 서버 업로드 없음</span>
          <span class="muted" style="line-height:1.6">영상은 고품질 설정(ffmpeg x264/x265)으로 다시 인코딩됩니다. HDR은 SDR로 변환되며, 출력 용량은 영상 내용과 코덱에 따라 달라집니다.</span>
        </div>
      </div>
      ${!p.maskApplied && p.faces.some(f => f.selected) && html`<div class="row gap10">
        <span class="row gap6 orange" style="font-size:11px"><${Icon} name="alert" /> 선택한 얼굴의 마스킹이 아직 적용되지 않았습니다.</span>
        <button class="btn" onClick=${() => s.applyMasks()}>선택한 얼굴 마스킹 적용</button></div>`}
      <div class="row gap10"><span class="small muted grow">얼굴 누락과 자막 내용을 최종 확인해 주세요.</span>
        <button class="btn" onClick=${close}>닫기</button>
        <button class="btn primary" onClick=${() => s.exportMedia()}><${Icon} name="exportArrow" /> 저장 위치 선택</button></div>
    </div>
  </div>`
}

const HELP = [
  ['파일 크기', '파일당 GB 제한은 두지 않았습니다. 영상은 ffmpeg가 프레임을 순차적으로 읽으므로 파일 전체를 메모리에 올리지 않습니다. 최대 처리 용량을 실기기 벤치마크로 인증한 상태는 아닙니다. 긴 영상일수록 분석 데이터·처리 시간·디스크 사용량이 늘어납니다.'],
  ['영상', '앱에 포함된 ffmpeg가 읽을 수 있는 MP4, MOV, M4V, MKV, WebM, AVI 등과 H.264, HEVC, ProRes, VP9, AV1 등의 코덱을 분석·내보내기에 사용합니다. 미리보기 재생이 지원되지 않는 코덱은 로컬 H.264 미리보기 사본을 자동으로 만듭니다(원본·출력에는 영향 없음). 출력은 MP4 또는 MOV(H.264/HEVC), 원본/4K/1080p/720p, 최대 120fps입니다. 해상도는 긴 변 기준이며 원본보다 확대하지 않습니다. HDR 출력은 현재 지원하지 않습니다.'],
  ['이미지', 'JPEG, PNG, BMP, WebP, GIF(단일 프레임), TIFF 등을 지원합니다. HEIC는 이 PC에서 디코딩 가능한 경우에만 열립니다. 애니메이션 GIF는 받지 않습니다. 단일 이미지는 최대 1억 2천만 화소입니다. 결과는 PNG, JPEG, TIFF로 저장하며 원본 EXIF/GPS를 복사하지 않습니다. (Windows 버전은 HEIC 출력을 지원하지 않습니다.)'],
  ['메모리·디스크', '4K 3840×2160의 8비트 RGBA 프레임은 약 31.6MiB, 8K는 약 126.6MiB입니다. 렌더링에는 여러 버퍼가 필요하므로 실제 메모리는 더 큽니다. 1억 2천만 화소 이미지는 버퍼 하나만 약 458MiB입니다. 출력과 임시 파일(편집 오디오 PCM 포함)을 위한 여유 디스크가 필요합니다.'],
  ['얼굴 분석', '영상은 남은 컷의 모든 프레임을 긴 변 최대 960px, 이미지는 최대 2400px로 축소하고 겹치는 9개 영역도 추가 검출합니다. 얼굴 검출은 SSD MobileNet(face-api) 모델을 GPU로 실행하며, 위치 연속성과 얼굴 특징 벡터로 인물 후보를 묶습니다. 신원 인식 제품이 아니므로 재등장 인물이 나뉘거나 유사한 얼굴이 잘못 묶일 수 있습니다. 분석 누락은 영역 마스크·키프레임으로 보완하세요.'],
  ['자동 자막', '앱에 포함된 Whisper(whisper.cpp, 다국어 base 모델)로 이 PC에서만 인식합니다. 음성을 네트워크로 전송하지 않습니다. 설정한 길이 단위로 처리하므로 경계에서 단어가 누락될 수 있습니다. 배경음악·겹친 대화에서는 잘못 인식할 수 있으니 결과를 검토하세요. SRT 가져오기·직접 입력·수정·SRT 내보내기를 지원합니다.'],
  ['컷 편집·범위', '타임라인은 편집 결과 시간입니다. 삭제하면 뒤 컷이 앞으로 붙습니다. 컷을 클릭해 선택하고 Ctrl+X/C/V로 잘라내기·복사·붙여넣기를 하세요. 여러 컷은 Ctrl+클릭 또는 Ctrl+A로 선택합니다. 컷을 드래그해 다른 컷 앞에 놓거나 화살표 버튼으로 이동합니다. I/O 또는 범위 손잡이로 내보내기 시작·끝을 정합니다. 지정 범위는 영상과 SRT 모두에 적용됩니다.'],
  ['프로젝트·복구', '프로젝트는 원본 경로와 편집 데이터·얼굴 썸네일을 저장합니다(macOS 버전과 같은 .veilproject 형식). 미디어가 포함되지 않으므로 원본 파일을 이동하지 마세요. 원본이 없으면 같은 파일을 직접 찾아 다시 연결할 수 있습니다. 마지막 작업은 %APPDATA%\\VeilStudio에 자동 저장되며, 파일 메뉴에서 복구할 수 있습니다. 자동 저장과 프로젝트 파일에도 얼굴 정보가 포함됩니다.']
]
export function HelpSheet() {
  const close = () => { store.helpSheet = false; store.changed() }
  return html`<div class="backdrop" onMouseDown=${ev => { if (ev.target === ev.currentTarget) close() }}>
    <div class="sheet" style="width:650px;height:660px">
      <h2>지원 형식과 처리 용량</h2>
      <div class="scroll grow col" style="gap:19px;padding-right:8px;user-select:text">${HELP.map(([t, x]) => html`<div class="help-item"><h3>${t}</h3><p>${x}</p></div>`)}</div>
      <div class="row"><span class="small muted grow">Veil Studio ${window.veilEnv?.version ?? ''} (Windows) · 제작자 다있쌤 로디</span><button class="btn primary" onClick=${close}>확인</button></div>
    </div>
  </div>`
}

export function ErrorAlert() {
  const close = () => { store.error = null; store.changed() }
  return html`<div class="backdrop"><div class="sheet alert">
    <div class="row gap10"><${Icon} name="alert" size=${22} style="color:var(--orange)" /><span style="font-size:15px;font-weight:600">작업 안내</span></div>
    <div style="white-space:pre-wrap;line-height:1.6;font-size:12px;user-select:text;max-height:50vh;overflow:auto">${store.error}</div>
    <div class="row"><span class="grow" /><button class="btn primary" autofocus onClick=${close}>확인</button></div>
  </div></div>`
}

// Right panel: mask design or the selected clip's properties (Final Cut Pro style inspector).
export function SideInspector() {
  const s = store
  const clipView = s.inspectorView === 'clip' || (s.inspectorView == null && s.tab === 'media')
  const setView = v => { s.inspectorView = v; s.changed() }
  return html`<div class="inspector" style=${s.loaded ? '' : 'pointer-events:none;opacity:0.5'}>
    <div style="padding:12px 16px 0"><div class="seg-tabs">
      <button class=${clipView ? '' : 'on'} onClick=${() => setView('design')}>마스크 디자인</button>
      <button class=${clipView ? 'on' : ''} onClick=${() => setView('clip')}>클립 속성</button>
    </div></div>
    ${clipView ? html`<${ClipInspector} />` : html`<${DesignInspector} embedded />`}
  </div>`
}

function ClipInspector() {
  const s = store, p = s.project, clips = s.selectedClipObjects
  if (!s.loaded || p.isImage) return html`<div class="note" style="padding:16px">영상 프로젝트에서 타임라인의 컷을 선택하면 볼륨·페이드·색 보정을 조절할 수 있습니다.</div>`
  if (!clips.length) return html`<div class="note" style="padding:16px;line-height:1.7">타임라인에서 컷을 선택하세요.<br />여러 컷을 Ctrl+클릭으로 선택하면 한 번에 바뀝니다.</div>`
  const c = clips[0], m = M.mediaById(p, c.media), n = clips.length
  const set = patch => s.setClipAttrs(patch)
  const db = c.volume ?? 0
  return html`<div class="col gap14" style="padding:16px">
    <${SectionLabel} title=${n > 1 ? `컷 ${n}개` : '선택한 컷'} detail=${M.mediaName(m)} />
    <div class="tiny muted" style="line-height:1.6">원본 ${M.timecode(c.start)}–${M.timecode(c.end)} · 길이 ${M.timecode(M.clipDuration(c))}<br />${Math.round(m.width)}×${Math.round(m.height)}${m.isImage ? ' 사진' : ` · ${Math.round(m.fps)}fps`}</div>
    <${Check} class="row gap6" checked=${!c.disabled} label="컷 사용 (V로 전환)" onChange=${v => set({ disabled: !v })} />
    <div class="hdivider" />
    <span class="small bold">오디오</span>
    <${Slider} label="볼륨" value=${db} min=${-30} max=${12} step=${0.5} suffix=${`${db > 0 ? '+' : ''}${db.toFixed(1)} dB`} onInput=${v => set({ volume: Math.abs(v) < 0.25 ? null : v })} />
    <${Check} class="row gap6" checked=${!!c.muted} label="이 컷 음소거" onChange=${v => set({ muted: v })} />
    <div class="hdivider" />
    <span class="small bold">페이드 (영상·오디오)</span>
    <${Slider} label="페이드 인" value=${c.fadeIn ?? 0} min=${0} max=${Math.min(5, M.clipDuration(c) / 2)} step=${0.05} suffix=${`${(c.fadeIn ?? 0).toFixed(2)}초`} onInput=${v => set({ fadeIn: v > 0.001 ? v : null })} />
    <${Slider} label="페이드 아웃" value=${c.fadeOut ?? 0} min=${0} max=${Math.min(5, M.clipDuration(c) / 2)} step=${0.05} suffix=${`${(c.fadeOut ?? 0).toFixed(2)}초`} onInput=${v => set({ fadeOut: v > 0.001 ? v : null })} />
    <div class="hdivider" />
    <span class="small bold">색 보정</span>
    <${Slider} label="밝기" value=${c.brightness ?? 0} min=${-0.5} max=${0.5} step=${0.01} suffix=${`${Math.round((c.brightness ?? 0) * 100)}`} onInput=${v => set({ brightness: Math.abs(v) < 0.005 ? null : v })} />
    <${Slider} label="대비" value=${c.contrast ?? 1} min=${0.5} max=${2} step=${0.01} suffix=${`${Math.round((c.contrast ?? 1) * 100)}%`} onInput=${v => set({ contrast: Math.abs(v - 1) < 0.005 ? null : v })} />
    <${Slider} label="채도" value=${c.saturation ?? 1} min=${0} max=${2} step=${0.01} suffix=${`${Math.round((c.saturation ?? 1) * 100)}%`} onInput=${v => set({ saturation: Math.abs(v - 1) < 0.005 ? null : v })} />
    <button class="btn" onClick=${() => set({ volume: null, muted: null, fadeIn: null, fadeOut: null, brightness: null, contrast: null, saturation: null, disabled: null })}>속성 초기화</button>
  </div>`
}
