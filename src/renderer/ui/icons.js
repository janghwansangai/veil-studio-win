// Line icons (feather-style) standing in for the SF Symbols used by the macOS app.
import { html } from '../vendor.js'

const I = {
  play: [{ f: 'M6 4l14 8-14 8z' }], pause: [{ f: 'M6 4h4v16H6zM14 4h4v16h-4z' }],
  undo: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'], redo: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
  scissors: [{ c: [6, 6, 3] }, { c: [6, 18, 3] }, 'M20 4L8.12 15.88', 'M14.47 14.48L20 20', 'M8.12 8.12L12 12'],
  cut: [{ c: [6, 6, 3] }, { c: [6, 18, 3] }, 'M20 4L8.12 15.88', 'M14.47 14.48L20 20', 'M8.12 8.12L12 12', 'M17 2v4', 'M15 4h4'],
  copy: [{ r: [9, 9, 13, 13, 2] }, 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  paste: ['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', { r: [8, 2, 8, 4, 1] }],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  toStart: ['M4 5v14', 'M20 12H8', 'M13 17l-5-5 5-5'], toEnd: ['M20 5v14', 'M4 12h12', 'M11 7l5 5-5 5'],
  folderPlus: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', 'M12 11v6', 'M9 14h6'],
  layers: ['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
  save: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  exportArrow: ['M7 17L17 7', 'M7 7h10v10'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  shieldCheck: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  lock: [{ r: [3, 11, 18, 11, 2] }, 'M7 11V7a5 5 0 0 1 10 0v4'],
  face: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', { c: [12, 10, 3] }, 'M7 18a5 5 0 0 1 10 0'],
  region: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', { r: [8, 8, 8, 8, 1] }],
  caption: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M7 8h10', 'M7 12h6'],
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M12 7l1.3 3.7L17 12l-3.7 1.3L12 17l-1.3-3.7L7 12l3.7-1.3z'],
  plus: ['M12 5v14', 'M5 12h14'], x: ['M18 6L6 18', 'M6 6l12 12'],
  waveform: ['M3 12h1', 'M7 8v8', 'M11 4v16', 'M15 7v10', 'M19 10v4'],
  help: [{ c: [12, 12, 10] }, 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  diamond: ['M12 3l9 9-9 9-9-9z'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', { c: [12, 12, 3] }],
  film: [{ r: [2, 3, 20, 18, 2] }, 'M7 3v18', 'M17 3v18', 'M2 12h20', 'M2 7.5h5', 'M2 16.5h5', 'M17 7.5h5', 'M17 16.5h5'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', { c: [9, 7, 4] }, 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  check: ['M20 6L9 17l-5-5'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  crop: ['M6 2v14a2 2 0 0 0 2 2h14', 'M18 22V8a2 2 0 0 0-2-2H2'],
  back: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'], forward: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'],
  imagePlus: [{ r: [3, 3, 18, 18, 2] }, { c: [8.5, 8.5, 1.5] }, 'M21 15l-5-5L5 21'],
  smile: [{ c: [12, 12, 10] }, 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  drop: ['M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z'], circle: [{ cf: [12, 12, 8] }]
}

export function Icon({ name, size = 14, class: cls = '', style = '' }) {
  const items = I[name] ?? []
  return html`<svg class=${'icon ' + cls} style=${style} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${items.map(it => typeof it === 'string' ? html`<path d=${it} />`
      : it.f ? html`<path d=${it.f} fill="currentColor" stroke="none" />`
      : it.c ? html`<circle cx=${it.c[0]} cy=${it.c[1]} r=${it.c[2]} />`
      : it.cf ? html`<circle cx=${it.cf[0]} cy=${it.cf[1]} r=${it.cf[2]} fill="currentColor" stroke="none" />`
      : html`<rect x=${it.r[0]} y=${it.r[1]} width=${it.r[2]} height=${it.r[3]} rx=${it.r[4]} />`)}
  </svg>`
}

export function Logo({ size = 25 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 1.5l9.1 5.25v10.5L12 22.5l-9.1-5.25V6.75z" fill="var(--mint)" />
    ${[[12, 7], [8, 9.5], [16, 9.5], [12, 12], [8, 14.5], [16, 14.5], [12, 17]].map(([x, y]) => html`<circle cx=${x} cy=${y} r="1.55" fill="var(--base)" />`)}
  </svg>`
}
