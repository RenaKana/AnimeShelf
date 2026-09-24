// AnimeShelf Electron 主进程：
// 1) 同进程内启动后端（编译产物 dist-electron/server.cjs，动态端口）
// 2) 独立窗口加载 http://127.0.0.1:<port>（后端同时服务 API 与前端 dist）
// 3) 数据目录：exe 同目录 data/（portable 模式用 PORTABLE_EXECUTABLE_DIR 定位）
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron')
const fs = require('fs')
const path = require('path')
const net = require('net')
const { waitReady } = require('./backend-ready.cjs')
const { installExternalLinks } = require('./external-links.cjs')
const { startExternalProxySync } = require('./proxy-session.cjs')

let win = null
let zoom = 1
let backend = null
let externalProxySync = null
let shuttingDown = false
let shutdownComplete = false
const startupController = new AbortController()

// 数据目录：exe 同目录 data/（electron-builder portable 提供 PORTABLE_EXECUTABLE_DIR 指向用户双击的 exe 位置）
function dataDir() {
  if (process.env.ANIMESHELF_DATA_DIR) return path.resolve(process.env.ANIMESHELF_DATA_DIR)
  // electron:dev 的 exe 位于 node_modules/electron/dist；开发时必须与 npm run dev 共用项目 data/。
  if (process.env.ANIMESHELF_DEV) return path.join(process.cwd(), 'data')
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'))
  return path.join(exeDir, 'data')
}

// 界面缩放：Ctrl +/-/0 或 Ctrl+滚轮；倍数持久化到 data/zoom.json
function loadZoom() {
  try { zoom = Math.min(3, Math.max(0.5, JSON.parse(fs.readFileSync(path.join(dataDir(), 'zoom.json'), 'utf8')))) } catch { zoom = 1 }
}
function applyZoom(z) {
  zoom = Math.min(3, Math.max(0.5, z))
  if (win) win.webContents.setZoomFactor(zoom)
  try { fs.writeFileSync(path.join(dataDir(), 'zoom.json'), JSON.stringify(zoom)) } catch { /* 忽略 */ }
}
function buildMenu() {
  const template = [
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => applyZoom(zoom + 0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => applyZoom(zoom - 0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => applyZoom(1) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 找空闲端口（避免与已在运行的 3001 服务冲突）
function findPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

app.whenReady().then(async () => {
  const port = await findPort()
  // 同进程启动后端（server.cjs 为 esbuild 编译产物，依赖从 app.asar/node_modules 加载）
  process.env.PORT = String(port)
  process.env.ANIMESHELF_DATA_DIR = dataDir()
  process.env.LISTEN_HOST = '127.0.0.1' // 桌面应用只监听本机回环（不暴露到局域网）
  process.env.ANIMESHELF_DIST_DIR = path.join(__dirname, '..', 'dist') // 前端构建产物（dev: 项目 dist/；打包: app.asar/dist）
  backend = require(path.join(__dirname, '..', 'dist-electron', 'server.cjs'))
  const devClientPort = process.env.ANIMESHELF_DEV_CLIENT_PORT ?? '5173'
  const devUrl = process.env.ANIMESHELF_DEV ? `http://127.0.0.1:${devClientPort}` : `http://127.0.0.1:${port}`
  const projectDir = process.env.ANIMESHELF_PROJECT_DIR
    ?? (app.isPackaged ? path.dirname(process.env.PORTABLE_EXECUTABLE_FILE ?? app.getPath('exe')) : process.cwd())
  await backend.startServiceRegistration?.({
    kind: 'electron',
    projectDir,
    dataDir: dataDir(),
    apiPort: port,
    webUrl: devUrl,
    logPath: process.env.ANIMESHELF_SERVICE_LOG ?? null,
    onStop: () => app.quit(),
  })
  if (!await waitReady(port, 15000, startupController.signal)) throw new Error('本地服务未能在 15 秒内就绪，请检查数据目录和启动日志。')
  if (shuttingDown || shutdownComplete) return
  backend.updateServiceRegistration?.({ state: 'running', apiPort: port, webUrl: devUrl })
  externalProxySync = startExternalProxySync(
    session.fromPartition('animeshelf-external-windows'),
    'http://127.0.0.1:' + port + '/api/settings/proxy-status',
  )
  await externalProxySync.ready
  if (shuttingDown || shutdownComplete) return

  // 调试模式：加载 Vite dev server（npm run electron:dev 时设置 ANIMESHELF_DEV=1）
  loadZoom()
  buildMenu()
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'AnimeShelf',
    autoHideMenuBar: true,
    backgroundColor: '#0e1116',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setZoomFactor(zoom)
  installExternalLinks(win.webContents, devUrl, url => shell.openExternal(url), externalProxySync.session, () => externalProxySync.canOpenExternal)
  // Ctrl+滚轮缩放（与浏览器习惯一致）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.type === 'mouseWheel') {
      event.preventDefault()
      applyZoom(zoom + (input.wheelDeltaY > 0 ? 0.1 : -0.1))
    }
  })
  await win.loadURL(devUrl)
  win.on('closed', () => { win = null })
}).catch(error => {
  if (shuttingDown || shutdownComplete) return
  console.error('AnimeShelf 启动失败:', error)
  backend?.updateServiceRegistration?.({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
  dialog.showErrorBox('AnimeShelf 启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', event => {
  if (shutdownComplete || !backend?.shutdownServer) return
  event.preventDefault()
  if (shuttingDown) return
  shuttingDown = true
  startupController.abort()
  externalProxySync?.stop()
  Promise.resolve(backend.shutdownServer()).then(() => {
    shutdownComplete = true
    app.quit()
  }).catch(error => {
    shuttingDown = false
    console.error('后端关闭失败:', error)
    backend?.updateServiceRegistration?.({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
    dialog.showErrorBox('AnimeShelf 无法安全退出', error instanceof Error ? error.message : String(error))
  })
})
