// Renderer bootstrap: environment paths, keyboard shortcuts, file drop and menu commands.
import { html, render } from './vendor.js'
import { env } from './lib/media.js'
import { store } from './state.js'
import { SafeApp } from './ui/app.js'

const { ipcRenderer, webUtils } = window.require('electron')

const isTextTarget = t => !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)) || t.tagName === 'SELECT')
const modalOpen = () => store.exportSheet || store.helpSheet || !!store.error

function command(id) {
  const s = store
  switch (id) {
    case 'openMedia': return s.openMedia()
    case 'importMedia': return s.loaded && !s.project.isImage ? s.importMedia() : s.openMedia()
    case 'newProject': return s.newProject()
    case 'openProject': return s.openProject()
    case 'saveProject': return s.saveProject()
    case 'saveProjectAs': return s.saveProjectIfPossible(true)
    case 'recover': return s.openProject(true)
    case 'export': if (s.loaded && !s.busy) { s.focusTimeline(); s.exportSheet = true; s.changed() } return
    case 'help': s.helpSheet = true; return s.changed()
    case 'undo': case 'redo': case 'cut': case 'copy': case 'paste': case 'delete': case 'selectAll': return s.editCommand(id)
    case 'togglePlay': return s.togglePlay()
    case 'split': return s.split()
    case 'moveLeft': return s.moveSelected(-1)
    case 'moveRight': return s.moveSelected(1)
    case 'markIn': return s.markIn()
    case 'markOut': return s.markOut()
    case 'exportSelected': return s.exportSelectedClips()
    case 'clearRange': return s.clearExportRange()
    case 'deleteRange': return s.deleteMarkedRange()
    case 'addMarker': return s.addMarker()
    case 'toggleClip': return s.toggleClipEnabled()
    case 'liftClip': return s.liftClips()
    case 'zoomIn': return s.setZoom(s.timelineZoom * 1.5)
    case 'zoomOut': return s.setZoom(s.timelineZoom / 1.5)
    case 'zoomFit': return s.setZoom(1)
    case 'toggleSnapping': return s.toggleSnapping()
    case 'trimStart': return s.trimToPlayhead(-1)
    case 'trimEnd': return s.trimToPlayhead(1)
    case 'append': case 'insert': case 'connect': if (s.selectedMedia) s.placeMedia(s.selectedMedia, id); return
    case 'shuttleBack': return s.shuttle(-1)
    case 'shuttleStop': return s.shuttle(0)
    case 'shuttleForward': return s.shuttle(1)
    case 'prevFrame': return s.step(-1)
    case 'nextFrame': return s.step(1)
    case 'prevEdit': return s.jumpEdit(-1)
    case 'nextEdit': return s.jumpEdit(1)
    case 'goStart': return s.seek(0)
    case 'goEnd': return s.seek(s.editedDuration)
  }
}
const REPEATABLE = new Set(['prevFrame', 'nextFrame', 'prevEdit', 'nextEdit', 'undo', 'redo', 'zoomIn', 'zoomOut', 'moveLeft', 'moveRight'])
function shortcut(e) {
  if (e.key === 'Escape') {
    if (store.error) { store.error = null; return store.changed() }
    if (store.exportSheet || store.helpSheet) { store.exportSheet = false; store.helpSheet = false; return store.changed() }
    if (store.drawMode) { store.drawMode = false; return store.changed() }
  }
  if (modalOpen() || isTextTarget(e.target) || store.busy) return
  // Arrow keys keep adjusting a focused slider instead of moving the playhead.
  if (e.target?.type === 'range' && e.key.startsWith('Arrow')) return
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase()
  let id = null
  if (ctrl && e.altKey && e.key === 'ArrowLeft') id = 'moveLeft'
  else if (ctrl && e.altKey && e.key === 'ArrowRight') id = 'moveRight'
  else if (ctrl && !e.altKey) id = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', x: 'cut', c: 'copy', v: 'paste', a: 'selectAll', b: 'split', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut' }[k] ?? null
  else if (e.altKey && !ctrl) id = { '[': 'trimStart', ']': 'trimEnd' }[e.key] ?? null
  else if (e.shiftKey) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); return store.step(-10) }
    if (e.key === 'ArrowRight') { e.preventDefault(); return store.step(10) }
    id = { delete: 'liftClip', backspace: 'liftClip', z: 'zoomFit' }[k] ?? null
  } else id = {
    ' ': 'togglePlay', delete: 'delete', backspace: 'delete', i: 'markIn', o: 'markOut', m: 'addMarker', v: 'toggleClip', n: 'toggleSnapping',
    j: 'shuttleBack', k: 'shuttleStop', l: 'shuttleForward', e: 'append', w: 'insert', q: 'connect',
    arrowleft: 'prevFrame', arrowright: 'nextFrame', arrowup: 'prevEdit', arrowdown: 'nextEdit', home: 'goStart', end: 'goEnd'
  }[k] ?? null
  // Holding a key repeats only navigation, undo and zoom; toggles such as V/M/N fire once.
  if (id && e.repeat && !REPEATABLE.has(id)) { e.preventDefault(); return }
  if (id) { e.preventDefault(); command(id) }
}

// Last-resort guards: log, surface the message, keep the editor alive.
function report(error) {
  const text = error?.stack ?? error?.message ?? String(error)
  ipcRenderer.send('app:log', text)
  if (store.busy || /ResizeObserver loop/.test(text)) return
  store.error = `예기치 않은 오류가 발생했지만 편집은 계속할 수 있습니다. 문제가 반복되면 프로젝트를 저장한 뒤 앱을 다시 시작하세요.

${error?.message ?? error}`
  store.changed()
}
window.addEventListener('error', e => report(e.error ?? e.message))
window.addEventListener('unhandledrejection', e => { e.preventDefault(); report(e.reason) })
// A drag released outside the window never delivers pointerup; end every pending drag when focus is lost.
const endDrags = () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
window.addEventListener('blur', endDrags)
window.addEventListener('pointercancel', endDrags)

async function start() {
  Object.assign(env, await ipcRenderer.invoke('app:paths'))
  window.veilEnv = env
  render(html`<${SafeApp} />`, document.getElementById('app'))
  window.addEventListener('keydown', shortcut)
  // Buttons must not steal Space/Enter from the timeline after being clicked.
  document.addEventListener('mouseup', e => { if (e.target.closest?.('button')) requestAnimationFrame(() => { if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur() }) })
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    if (store.busy) return
    // Several files at once: a video project appends them; otherwise the first opens a new project.
    const paths = [...(e.dataTransfer?.files ?? [])].map(f => webUtils.getPathForFile(f)).filter(Boolean)
    if (paths.length) store.openFiles(paths)
  })
  ipcRenderer.on('menu:command', (_e, id) => command(id))
  ipcRenderer.on('menu:open-file', (_e, file) => { if (!store.busy) store.openFiles([file]) })
  ipcRenderer.on('app:request-close', async () => {
    ipcRenderer.send('app:close-ack')
    let ok = true
    try { ok = await store.confirmLeaving() } catch (e) { ipcRenderer.send('app:log', e?.stack ?? String(e)) }
    if (ok) ipcRenderer.send('app:close-approved')
  })
  window.addEventListener('resize', () => store.requestDraw())
  // Edit menu items follow text focus like the macOS responder chain.
  document.addEventListener('focusin', () => store.syncChrome())
  document.addEventListener('focusout', () => setTimeout(() => store.syncChrome(), 0))
  const query = new URLSearchParams(location.search)
  if (query.get('selftest')) (await import('./selftest.js')).run()
  else if (query.get('open')) store.load(query.get('open'))
}
start().catch(e => { document.body.textContent = `시작 오류: ${e.stack ?? e}`; console.error(e) })
