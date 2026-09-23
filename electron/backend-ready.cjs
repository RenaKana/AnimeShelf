// Each probe and the entire readiness loop have deadlines.
async function waitReady(port, timeoutMs = 15000, signal) {
  const deadline = Date.now() + timeoutMs
  while (!signal?.aborted && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, remaining))]) : AbortSignal.timeout(Math.min(1000, remaining)),
      })
      if (response.ok) return true
    } catch { /* The backend may still be starting. */ }
    if (signal?.aborted) break
    const pause = Math.min(250, deadline - Date.now())
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause))
  }
  return false
}

module.exports = { waitReady }
