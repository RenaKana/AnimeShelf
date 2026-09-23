// Recovery is opt-in for local data reads; mutations must never be replayed.
const recovering = new Set<symbol>()
const listeners = new Set<() => void>()
export const getRecoveringReadCount = () => recovering.size
export const subscribeToReadRecovery = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notify = () => { for (const listener of listeners) listener() }

function retryable(error: unknown): boolean {
  if (error instanceof TypeError) return true // fetch connection/body transport failure
  if (!(error instanceof Error)) return false
  return 'retryable' in error && error.retryable === true
}

function waitToRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const browser = typeof window === 'undefined' ? undefined : window
    const page = typeof document === 'undefined' ? undefined : document
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      browser?.removeEventListener('online', resume)
      browser?.removeEventListener('focus', resume)
      browser?.removeEventListener('pageshow', resume)
      page?.removeEventListener('visibilitychange', resume)
    }
    const resume = () => {
      if (page?.visibilityState === 'hidden') return
      cleanup()
      resolve()
    }
    const abort = () => { cleanup(); reject(signal?.reason) }
    // A background tab waits for visibility instead of repeatedly polling.
    const timer = setTimeout(resume, delay)
    signal?.addEventListener('abort', abort, { once: true })
    browser?.addEventListener('online', resume)
    browser?.addEventListener('focus', resume)
    browser?.addEventListener('pageshow', resume)
    page?.addEventListener('visibilitychange', resume)
  })
}

export async function recoverRead<T>(load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const id = Symbol()
  let failures = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const timeout = new AbortController()
      const attemptSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
      const timer = setTimeout(() => timeout.abort(new DOMException('Read timed out', 'TimeoutError')), 10_000)
      try {
        const value = await load(attemptSignal)
        signal?.throwIfAborted()
        return value
      } catch (error) {
        signal?.throwIfAborted()
        if (!timeout.signal.aborted && !retryable(error)) throw error
      } finally {
        clearTimeout(timer)
      }
      if (!recovering.has(id)) { recovering.add(id); notify() }
      await waitToRetry(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), signal)
    }
  } finally {
    if (recovering.delete(id)) notify()
  }
}
