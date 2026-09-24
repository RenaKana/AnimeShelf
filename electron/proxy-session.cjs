const http = require('node:http')

const BLOCKED_EXTERNAL_PROXY = Object.freeze({
  mode: 'fixed_servers',
  proxyRules: 'http://127.0.0.1:1',
  proxyBypassRules: 'localhost;127.0.0.1;[::1]',
})

function externalProxyConfig(status) {
  if (!status || status.error || !status.electron) return { config: BLOCKED_EXTERNAL_PROXY, allowed: false }
  const electron = status.electron
  if (electron.mode === 'direct') return { config: { mode: 'direct' }, allowed: true }
  if (electron.mode !== 'fixed_servers'
    || typeof electron.proxyRules !== 'string'
    || !electron.proxyRules
    || electron.proxyRules.length > 2048
    || /[\x00-\x20\x7f]/.test(electron.proxyRules)) {
    return { config: BLOCKED_EXTERNAL_PROXY, allowed: false }
  }
  const bypass = typeof electron.proxyBypassRules === 'string' ? electron.proxyBypassRules : ''
  if (bypass.length > 2048 || /[\x00-\x1f\x7f]/.test(bypass)) {
    return { config: BLOCKED_EXTERNAL_PROXY, allowed: false }
  }
  return {
    config: { mode: 'fixed_servers', proxyRules: electron.proxyRules, proxyBypassRules: bypass },
    allowed: true,
  }
}

function fetchProxyStatus(statusUrl) {
  let target
  try {
    target = new URL(statusUrl)
  } catch {
    return Promise.reject(new Error('Proxy status URL is invalid'))
  }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) {
    return Promise.reject(new Error('Proxy status must use the local HTTP service'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const request = http.get(target, { timeout: 1800, agent: false }, response => {
      response.once('aborted', () => finish(new Error('Proxy status response was interrupted')))
      response.once('error', error => finish(error))
      response.once('close', () => {
        if (!response.complete) finish(new Error('Proxy status response was interrupted'))
      })
      if (response.statusCode !== 200) {
        response.resume()
        finish(new Error('Proxy status is unavailable'))
        return
      }
      const chunks = []
      let length = 0
      response.on('data', chunk => {
        if (settled) return
        length += chunk.length
        if (length > 8192) {
          const error = new Error('Proxy status response is too large')
          finish(error)
          request.destroy(error)
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          finish(new Error('Proxy status response is invalid'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('Proxy status timed out')))
    request.on('error', error => finish(error))
  })
}

function startExternalProxySync(proxySession, statusUrl, options = {}) {
  const readStatus = options.fetchStatus || fetchProxyStatus
  const intervalMs = options.intervalMs ?? 5000
  const requestTimeoutMs = options.requestTimeoutMs ?? 3000
  let stopped = false
  let pending = null
  let lastConfig = ''
  let allowed = false
  /** @type {Set<number>} */
  const activeRequests = new Set()
  const pendingGates = new Set()
  const idleWaiters = new Set()

  const releaseIdleWaiters = value => {
    if (value && activeRequests.size) return
    for (const resolve of idleWaiters) resolve(value)
    idleWaiters.clear()
  }

  const waitForIdle = () => {
    if (stopped) return Promise.resolve(false)
    if (!activeRequests.size) return Promise.resolve(true)
    return new Promise(resolve => idleWaiters.add(resolve))
  }

  const finishRequest = details => {
    if (!Number.isInteger(details?.id)) return
    if (activeRequests.delete(details.id) && !activeRequests.size) releaseIdleWaiters(true)
  }

  const refresh = (force = false) => {
    if (stopped) return Promise.resolve(false)
    if (pending) return force ? pending.then(() => refresh(true)) : pending
    pending = Promise.resolve()
      .then(() => stopped ? null : readStatus(statusUrl))
      .then(async status => {
        if (stopped) return false
        const resolved = externalProxyConfig(status)
        const fingerprint = JSON.stringify([status?.mode, status?.source, status?.revision, resolved.config])
        if (fingerprint !== lastConfig) {
          allowed = false
          if (lastConfig) {
            const idle = await waitForIdle()
            if (!idle || stopped) return false
          }
          if (stopped) return false
          await proxySession.setProxy(resolved.config)
          if (stopped) return false
          await proxySession.closeAllConnections()
          if (stopped) return false
          lastConfig = fingerprint
        }
        allowed = resolved.allowed
        return allowed
      })
      .catch(async () => {
        allowed = false
        if (stopped) return false
        if (lastConfig !== 'blocked') {
          try {
            const idle = await waitForIdle()
            if (!idle || stopped) return false
            await proxySession.setProxy(BLOCKED_EXTERNAL_PROXY)
            if (stopped) return false
            await proxySession.closeAllConnections()
            if (stopped) return false
            lastConfig = 'blocked'
          } catch {
            return false
          }
        }
        return false
      })
      .finally(() => { pending = null })
    return pending
  }

  const beforeRequest = (details, callback) => {
    let completed = false
    const requestId = details?.id
    let timeout
    const complete = cancel => {
      if (completed) return
      completed = true
      clearTimeout(timeout)
      pendingGates.delete(cancelGate)
      const shouldCancel = cancel || stopped || !Number.isInteger(requestId)
      if (!shouldCancel) activeRequests.add(requestId)
      try {
        callback({ cancel: shouldCancel })
      } catch (error) {
        if (!shouldCancel) finishRequest({ id: requestId })
        throw error
      }
    }
    const cancelGate = () => complete(true)
    pendingGates.add(cancelGate)
    timeout = setTimeout(cancelGate, requestTimeoutMs)
    timeout.unref?.()
    // Status is fetched with node:http, outside this Electron session, so this
    // request gate cannot recursively intercept its own status refresh.
    void refresh(true).then(result => complete(!result), () => complete(true))
  }

  const ready = refresh()
  const timer = intervalMs > 0 ? setInterval(() => { void refresh() }, intervalMs) : null
  timer?.unref?.()
  const webRequest = proxySession.webRequest
  webRequest?.onBeforeRequest?.({ urls: ['http://*/*', 'https://*/*'] }, beforeRequest)
  webRequest?.onCompleted?.(finishRequest)
  webRequest?.onErrorOccurred?.(finishRequest)
  webRequest?.onBeforeRedirect?.(finishRequest)
  return {
    session: proxySession,
    ready,
    refresh: () => refresh(true),
    get canOpenExternal() { return allowed },
    stop: () => {
      stopped = true
      allowed = false
      if (timer) clearInterval(timer)
      releaseIdleWaiters(false)
      for (const cancel of [...pendingGates]) cancel()
    },
  }
}

module.exports = { BLOCKED_EXTERNAL_PROXY, externalProxyConfig, fetchProxyStatus, startExternalProxySync }
