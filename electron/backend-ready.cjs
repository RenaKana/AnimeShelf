const { Agent, fetch } = require('undici')

// Local health probes always bypass proxy environment/global dispatcher settings.
async function waitReady(port, timeoutMs = 15000, signal) {
  const dispatcher = new Agent()
  const deadline = Date.now() + timeoutMs
  try {
    while (!signal?.aborted && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          dispatcher,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, remaining))]) : AbortSignal.timeout(Math.min(1000, remaining)),
        })
        await response.body?.cancel()
        if (response.ok) return true
      } catch { /* The backend may still be starting. */ }
      if (signal?.aborted) break
      const pause = Math.min(250, deadline - Date.now())
      if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause))
    }
    return false
  } finally {
    await dispatcher.destroy()
  }
}

module.exports = { waitReady }
