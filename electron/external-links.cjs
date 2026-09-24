const { isIP } = require('node:net')

// Only ordinary HTTPS web links may be handed to the OS. Internal navigation
// remains in Electron; custom protocols, credentials and local addresses do not.
function externalHttpsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw)) return null
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/\.$/, '')
    if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host) || host.includes(':')) return null
    if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null
    return url.href
  } catch { return null }
}

function installExternalLinks(webContents, internalUrl, openExternal, externalProxySession, canOpenExternal = () => true) {
  const origin = new URL(internalUrl).origin
  const internal = raw => {
    try { const url = new URL(raw); return url.origin === origin && !url.username && !url.password } catch { return false }
  }
  const open = raw => {
    const url = externalHttpsUrl(raw)
    if (url) Promise.resolve(openExternal(url)).catch(() => { /* OS browser errors must not tear down the media window. */ })
  }
  const existingHttpLink = raw => {
    if (typeof raw !== 'string' || /[\x00-\x20\x7f\\]/.test(raw)) return false
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:') return false
      url.protocol = 'https:'
      return Boolean(externalHttpsUrl(url.href))
    } catch { return false }
  }
  webContents.setWindowOpenHandler(({ url }) => {
    if (internal(url)) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } }
    if (existingHttpLink(url)) {
      if (!canOpenExternal()) return { action: 'deny' }
      const webPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true }
      if (externalProxySession) webPreferences.session = externalProxySession
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences } }
    }
    open(url)
    return { action: 'deny' }
  })
  const navigate = (event, url) => {
    if (internal(url)) return
    event.preventDefault()
    open(url)
  }
  webContents.on('will-navigate', navigate)
  webContents.on('will-redirect', navigate)
  webContents.on('did-create-window', (child, details) => installExternalLinks(child.webContents, details?.url ?? internalUrl, openExternal, externalProxySession, canOpenExternal))
}

module.exports = { externalHttpsUrl, installExternalLinks }
