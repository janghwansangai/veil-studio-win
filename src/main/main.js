// Electron main process: window, native menus/dialogs and the unsaved-changes close guard.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const selftest = process.argv.includes('--selftest')
const screenshotArg = process.argv.find(a => a.startsWith('--screenshot='))
const openArg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile())
const root = path.join(__dirname, '..', '..')

let win = null
let allowClose = false
let closeAcked = true

// Errors are appended to %APPDATA%Veil Studiologseil.log (rotated at 1 MB) for diagnosis.
function logFile() { return path.join(app.getPath('userData'), 'logs', 'veil.log') }
function writeLog(level, message) {
  try {
    const file = logFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.1')
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}
`)
  } catch {}
}
process.on('uncaughtException', e => { writeLog('main', e.stack ?? String(e)) })
process.on('unhandledRejection', e => { writeLog('main', e?.stack ?? String(e)) })

function resolvePaths() {
  const unpack = p => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  const ffmpeg = unpack(require('ffmpeg-static'))
  const speech = app.isPackaged ? path.join(process.resourcesPath, 'speech') : path.join(root, 'resources', 'speech')
  return {
    ffmpeg, speech,
    whisper: path.join(speech, 'bin', 'whisper-cli.exe'),
    whisperModels: path.join(speech, 'models'),
    whisperVad: path.join(speech, 'models', 'ggml-silero-v5.1.2.bin'),
    separationModels: app.isPackaged ? path.join(process.resourcesPath, 'separation') : path.join(root, 'resources', 'separation'),
    faceModels: app.isPackaged ? path.join(process.resourcesPath, 'face') : path.join(root, 'resources', 'face'),
    userData: app.getPath('userData'),
    recovery: path.join(app.getPath('appData'), 'VeilStudio', 'Recovery.veilproject'),
    temp: app.getPath('temp'),
    videos: app.getPath('videos'),
    documents: app.getPath('documents'),
    root,
    version: app.getVersion(),
    packaged: app.isPackaged
  }
}

function send(channel, ...args) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args) }
const cmd = command => () => send('menu:command', command)

function buildMenu() {
  // Edit/timeline shortcuts are handled in the renderer so text fields keep their native behaviour.
  const r = (label, id, accelerator) => ({ label, id, accelerator, registerAccelerator: false, click: cmd(id) })
  const template = [
    { label: '파일', submenu: [
      { label: '새 프로젝트', id: 'newProject', accelerator: 'Ctrl+N', click: cmd('newProject') },
      { label: '미디어 열기…', id: 'openMedia', accelerator: 'Ctrl+O', click: cmd('openMedia') },
      { label: '미디어 가져오기(프로젝트에 추가)…', id: 'importMedia', accelerator: 'Ctrl+I', click: cmd('importMedia') },
      { label: '프로젝트 열기…', id: 'openProject', accelerator: 'Ctrl+Shift+O', click: cmd('openProject') },
      { label: '프로젝트 저장', id: 'saveProject', accelerator: 'Ctrl+S', click: cmd('saveProject') },
      { label: '다른 이름으로 프로젝트 저장…', id: 'saveProjectAs', accelerator: 'Ctrl+Shift+S', click: cmd('saveProjectAs') },
      { label: '최근 자동 저장 복구', id: 'recover', click: cmd('recover') },
      { type: 'separator' },
      { label: '내보내기…', id: 'export', accelerator: 'Ctrl+E', click: cmd('export') },
      { type: 'separator' },
      { label: '종료', role: 'quit' }
    ] },
    { label: '편집', submenu: [
      r('실행 취소', 'undo', 'Ctrl+Z'), r('다시 실행', 'redo', 'Ctrl+Y'),
      { type: 'separator' },
      r('잘라내기', 'cut', 'Ctrl+X'), r('복사', 'copy', 'Ctrl+C'), r('붙여넣기', 'paste', 'Ctrl+V'),
      r('삭제 후 붙이기', 'delete', 'Delete'), r('빈 구간 남기고 삭제', 'liftClip', 'Shift+Delete'), r('전체 선택', 'selectAll', 'Ctrl+A'),
      { type: 'separator' },
      r('컷 사용 / 사용 안 함', 'toggleClip', 'V'), r('컷 시작을 재생 위치로 자르기', 'trimStart', 'Alt+['), r('컷 끝을 재생 위치로 자르기', 'trimEnd', 'Alt+]'),
      { type: 'separator' },
      r('선택 미디어 끝에 추가', 'append', 'E'), r('선택 미디어 재생 위치에 삽입', 'insert', 'W'), r('선택 미디어 위 트랙에 연결', 'connect', 'Q')
    ] },
    { label: '타임라인', submenu: [
      r('재생 / 일시정지', 'togglePlay', 'Space'), r('뒤로 재생', 'shuttleBack', 'J'), r('정지', 'shuttleStop', 'K'), r('앞으로 재생 (반복 시 빠르게)', 'shuttleForward', 'L'),
      r('이전 프레임', 'prevFrame', 'Left'), r('다음 프레임', 'nextFrame', 'Right'), r('이전 편집점', 'prevEdit', 'Up'), r('다음 편집점', 'nextEdit', 'Down'),
      { type: 'separator' },
      r('재생 위치에서 분할', 'split', 'Ctrl+B'), r('마커 추가', 'addMarker', 'M'),
      r('컷 앞으로 이동', 'moveLeft', 'Ctrl+Alt+Left'), r('컷 뒤로 이동', 'moveRight', 'Ctrl+Alt+Right'),
      { type: 'separator' },
      r('내보내기 시작 지정', 'markIn', 'I'), r('내보내기 종료 지정', 'markOut', 'O'),
      { label: '선택한 컷 범위 내보내기', id: 'exportSelected', click: cmd('exportSelected') },
      { label: '내보내기 범위 해제', id: 'clearRange', click: cmd('clearRange') },
      { label: '지정 범위 삭제 후 붙이기', id: 'deleteRange', click: cmd('deleteRange') },
      { type: 'separator' },
      r('타임라인 확대', 'zoomIn', 'Ctrl+='), r('타임라인 축소', 'zoomOut', 'Ctrl+-'), r('타임라인 전체 보기', 'zoomFit', 'Shift+Z'),
      { label: '스냅', id: 'toggleSnapping', type: 'checkbox', checked: true, accelerator: 'N', registerAccelerator: false, click: cmd('toggleSnapping') }
    ] },
    { label: '보기', submenu: [
      { role: 'zoomIn', label: '화면 확대', accelerator: 'Ctrl+Shift+=' }, { role: 'zoomOut', label: '화면 축소', accelerator: 'Ctrl+Shift+-' }, { role: 'resetZoom', label: '화면 실제 크기', accelerator: 'Ctrl+0' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '개발자 도구' }])
    ] },
    { label: '도움말', submenu: [
      { label: '지원 형식과 처리 용량', click: cmd('help') },
      { label: 'Veil Studio 정보', click: cmd('help') }
    ] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  nativeTheme.themeSource = 'dark'
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1180, minHeight: 740, show: false,
    backgroundColor: '#0e1014', title: 'Veil Studio',
    icon: path.join(root, 'build', 'icon.ico'),
    webPreferences: {
      // Local-only app: the renderer drives ffmpeg/whisper processes directly and never loads remote content.
      nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false, spellcheck: false, backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.once('ready-to-show', () => { if (!selftest) win.show() })
  win.on('close', e => {
    if (allowClose || selftest) return
    e.preventDefault()
    // The editor acknowledges at once (before any save prompt); silence means it is hung.
    closeAcked = false; send('app:request-close')
    setTimeout(async () => {
      if (closeAcked || !win || win.isDestroyed()) return
      const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Veil Studio', message: '편집 화면이 응답하지 않아 종료 확인을 할 수 없습니다.', detail: '강제로 종료하면 저장하지 않은 변경은 잃을 수 있습니다(자동 복구 파일은 유지됩니다).', buttons: ['기다리기', '강제 종료'], defaultId: 0, noLink: true })
      if (response === 1) { allowClose = true; win?.destroy(); app.quit() }
    }, 4000)
  })
  win.on('closed', () => { win = null })
  // The editor process can die (driver fault, out of memory). Offer a reload; autosave keeps the work.
  win.webContents.on('render-process-gone', async (_e, details) => {
    writeLog('renderer-gone', JSON.stringify(details))
    if (selftest || details.reason === 'clean-exit') return
    const { response } = await dialog.showMessageBox(win, { type: 'error', title: 'Veil Studio', message: '편집 화면이 예기치 않게 종료되었습니다.', detail: `원인: ${details.reason}
다시 열면 파일 메뉴 → "최근 자동 저장 복구"로 마지막 작업을 되살릴 수 있습니다.`, buttons: ['다시 열기', '종료'], defaultId: 0, noLink: true })
    if (response === 0) win.webContents.reload(); else { allowClose = true; app.quit() }
  })
  win.on('unresponsive', async () => {
    writeLog('renderer', 'unresponsive')
    if (selftest) return
    const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Veil Studio', message: '편집 화면이 응답하지 않습니다.', detail: '긴 작업이 진행 중일 수 있습니다. 기다리거나 화면을 다시 불러올 수 있습니다(저장하지 않은 변경은 자동 복구 파일에서 되살릴 수 있습니다).', buttons: ['기다리기', '다시 불러오기'], defaultId: 0, noLink: true })
    if (response === 1) win.webContents.reload()
  })
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 3) return
    writeLog('console', `${message} (${source}:${line})`)
    // A module that fails to load leaves the self-test waiting forever.
    if (selftest && /SyntaxError|does not provide an export|Failed to fetch dynamically/.test(message)) { console.error(message, source, line); app.exit(3) }
  })
  const query = { }
  if (selftest) query.selftest = '1'
  if (screenshotArg) query.screenshot = '1'
  if (openArg) query.open = path.resolve(openArg)
  win.loadFile(path.join(root, 'src', 'renderer', 'index.html'), { query })
}

ipcMain.handle('app:paths', () => resolvePaths())
ipcMain.handle('dialog:open', (_e, options) => dialog.showOpenDialog(win, options))
ipcMain.handle('dialog:save', (_e, options) => dialog.showSaveDialog(win, options))
ipcMain.handle('dialog:message', (_e, options) => dialog.showMessageBox(win, options))
ipcMain.handle('shell:show', (_e, file) => shell.showItemInFolder(file))
ipcMain.handle('menu:context', (_e, items) => new Promise(resolve => {
  let chosen = null
  const build = list => list.map(item => item.type === 'separator' ? { type: 'separator' }
    : item.submenu ? { label: item.label, enabled: item.enabled !== false, submenu: build(item.submenu) }
    : { label: item.label, enabled: item.enabled !== false, click: () => { chosen = item.id } })
  Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => resolve(chosen), 0) })
}))
ipcMain.on('menu:state', (_e, state) => {
  const menu = Menu.getApplicationMenu()
  for (const [id, enabled] of Object.entries(state)) { const item = menu?.getMenuItemById(id); if (item && typeof enabled === 'boolean') item.enabled = enabled }
  const snap = menu?.getMenuItemById('toggleSnapping'); if (snap && typeof state.snappingChecked === 'boolean') snap.checked = state.snappingChecked
})
ipcMain.on('app:title', (_e, { title, edited }) => { if (win) { win.setTitle(title); win.setDocumentEdited?.(edited) } })
ipcMain.on('app:close-approved', () => { allowClose = true; win?.close() })
ipcMain.on('app:close-ack', () => { closeAcked = true })
ipcMain.handle('app:capture', async (_e, file) => {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(file, image.toPNG()); return file
})
ipcMain.on('selftest:done', (_e, code) => { allowClose = true; app.exit(code) })
ipcMain.on('app:show', () => win?.showInactive())
ipcMain.on('app:log', (_e, message) => writeLog('renderer', message))
app.on('child-process-gone', (_e, details) => writeLog('child-gone', JSON.stringify(details)))

const single = selftest || app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore(); win.focus()
    const file = argv.slice(1).find(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile())
    if (file) send('menu:open-file', path.resolve(file))
  })
  app.whenReady().then(() => { buildMenu(); createWindow() })
  app.on('window-all-closed', () => app.quit())
}
