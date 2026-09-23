import type { SourceId } from '../shared/types'

const NYAA_INTERVAL_MS = 5_000
interface WaitingRequest { start: () => void }

/** Pace actual HTTP attempts, not queries: redirects and RSS use the same gate. */
export class DownloadRequestPacer {
  private nextNyaaAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly waiting: WaitingRequest[] = []

  constructor(private readonly now: () => number = () => performance.now()) {}

  send<T>(source: SourceId, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (source !== 'nyaa') return send()
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
        this.drain()
      }
      const waiter: WaitingRequest = { start: () => {
        signal.removeEventListener('abort', cancel)
        try { signal.throwIfAborted(); resolve(send()) } catch (error) { reject(error) }
      } }
      signal.addEventListener('abort', cancel, { once: true })
      this.waiting.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.waiting.length) return
    const delay = this.nextNyaaAt - this.now()
    if (delay > 0) {
      this.timer = setTimeout(() => this.drain(), delay)
      return
    }
    const waiter = this.waiting.shift()!
    this.nextNyaaAt = this.now() + NYAA_INTERVAL_MS
    waiter.start()
    // Include synchronous request setup; a failed attempt still consumes a slot.
    this.nextNyaaAt = Math.max(this.nextNyaaAt, this.now() + NYAA_INTERVAL_MS)
    this.drain()
  }
}

// Shared by transport/service instances until the backend process exits.
export const downloadRequestPacer = new DownloadRequestPacer()
