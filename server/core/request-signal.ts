import type { Database } from 'node-sqlite3-wasm'
import { moduleRuntime } from './extensions'

export function requestSignal(db: Database, signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const signals = [moduleRuntime(db)?.signal, signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter((item): item is AbortSignal => Boolean(item))
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0]
}
