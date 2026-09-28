import { html, useEffect, useReducer, useRef, useState } from '../vendor.js'
import { store } from '../state.js'
import { Icon } from './icons.js'

export function useStore() {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => store.on('change', force), [])
  return store
}
// Re-renders only when the derived key changes, so playback does not re-render whole panels.
export function useTimeKey(compute) {
  const [, force] = useReducer(x => x + 1, 0)
  const last = useRef(), fn = useRef(compute)
  fn.current = compute
  last.current = compute()
  useEffect(() => store.on('time', () => { const k = fn.current(); if (k !== last.current) { last.current = k; force() } }), [])
  return last.current
}

export const SectionLabel = ({ title, detail = '' }) => html`<div class="section-label"><span>${title}</span><span>${detail}</span></div>`
export const EmptyHint = ({ icon, title, text }) => html`<div class="empty"><${Icon} name=${icon} size=${29} style="color:var(--accent)" /><div class="empty-title">${title}</div><div class="empty-text">${text}</div></div>`

function endGestureOnRelease() {
  store.beginTimelineGesture()
  window.addEventListener('pointerup', () => store.endTimelineGesture(), { once: true })
}
// One drag of a slider becomes one undo step, like one SwiftUI gesture in the macOS app.
export function Slider({ label, value, min = 0, max = 1, step = 0.001, onInput, suffix, disabled = false }) {
  const shown = suffix ?? `${Math.round(value * 100)}%`
  return html`<div class="slider-row">
    ${label && html`<div class="slider-head"><span>${label}</span><span>${shown}</span></div>`}
    <input type="range" min=${min} max=${max} step=${step} value=${value} disabled=${disabled}
      onPointerDown=${endGestureOnRelease} onInput=${e => onInput(+e.target.value)} />
  </div>`
}

// Seconds field: Enter/blur commits, wheel adds 0.1 s (Shift: 1 s).
export function TimeField({ value, onCommit, title = '', class: cls = '' }) {
  const [text, setText] = useState(null)
  const shown = text ?? (Number.isFinite(value) ? value.toFixed(2) : '')
  return html`<input class=${'field num ' + cls} title=${title ? `${title} · 스크롤: 0.1초 · Shift+스크롤: 1초` : '스크롤: 0.1초 · Shift+스크롤: 1초'} placeholder=${title} value=${shown}
    onFocus=${e => { setText(value.toFixed(3)); requestAnimationFrame(() => e.target.select()) }}
    onInput=${e => setText(e.target.value)}
    onKeyDown=${e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setText(null); requestAnimationFrame(() => e.target.blur()) } e.stopPropagation() }}
    onBlur=${() => { if (text != null) { const n = parseFloat(text); if (Number.isFinite(n)) onCommit(Math.max(0, n)) } setText(null) }}
    onWheel=${e => { if (!e.deltaY) return; e.preventDefault(); if (document.activeElement === e.target) e.target.blur(); onCommit(Math.max(0, value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 1 : 0.1))) }} />`
}
export function NumberField({ value, onCommit, digits = 2, title = '' }) {
  const [text, setText] = useState(null)
  return html`<input class="field num" title=${title} value=${text ?? (Number.isFinite(value) ? value.toFixed(digits) : '')}
    onFocus=${e => { setText(value.toFixed(digits)); requestAnimationFrame(() => e.target.select()) }}
    onInput=${e => setText(e.target.value)}
    onKeyDown=${e => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation() }}
    onBlur=${() => { if (text != null) { const n = parseFloat(text); if (Number.isFinite(n)) onCommit(n) } setText(null) }} />`
}
// Typing inside one field is grouped into a single undo step.
export function TextInput({ value, onInput, placeholder = '', multiline = false, class: cls = 'field', rows = 2 }) {
  const common = {
    class: cls, placeholder, value,
    onFocus: () => store.beginTimelineGesture(), onBlur: () => store.endTimelineGesture(),
    onInput: e => onInput(e.target.value), onKeyDown: e => e.stopPropagation()
  }
  return multiline ? html`<textarea ...${common} rows=${rows} />` : html`<input ...${common} />`
}
export function Select({ value, options, onChange, class: cls = 'field', title = '' }) {
  return html`<select class=${cls} title=${title} value=${String(value)} onChange=${e => { const o = options.find(o => String(o[0]) === e.target.value); onChange(o ? o[0] : e.target.value) }}>
    ${options.map(([v, label]) => html`<option value=${String(v)}>${label}</option>`)}
  </select>`
}
export const Check = ({ checked, onChange, label, class: cls = 'row gap6 small' }) =>
  html`<label class=${cls}><input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} /><span>${label}</span></label>`
export const graphemes = s => Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s), x => x.segment)
