import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { api } from '../api'
import type { LibraryScanResult, LibraryScanStatus } from '../../shared/library-scan'

export function scanResultMessage(result: LibraryScanResult): string {
  if (result.code === 'LIBRARY_BUSY') return '等待当前维护任务完成后扫描'
  if (result.code === 'SCAN_CANCELLED') return '扫描快照已更新，等待重新扫描'
  if (result.errors.length) return `扫描未完成：${result.errors.join('；')}`
  return `扫描完成：新增 ${result.added}，更新 ${result.updated}${result.moved ? `，移动 ${result.moved}` : ''}${result.missing ? `，缺失 ${result.missing}` : ''}${result.restored ? `，恢复 ${result.restored}` : ''}${result.warnings?.length ? `；${result.warnings.join('；')}` : ''}`
}

export function libraryScanMessage(statuses: LibraryScanStatus[]): string {
  const failed = statuses.find(status => status.status === 'error')
  if (failed?.error) return `扫描未完成：${failed.error}`
  const waiting = statuses.find(status => status.status === 'waiting' || ((status.status === 'scanning' || status.status === 'queued') && status.waitingReason))
  if (waiting) {
    const detail = waiting.status === 'scanning' ? '正在重新扫描' : waiting.status === 'queued' ? '等待重新扫描'
      : waiting.waitingReason === 'maintenance' ? '等待当前维护任务完成后扫描'
      : waiting.waitingReason === 'retry' ? '稍后自动重试' : '等待目录稳定后扫描'
    return waiting.error ? `扫描暂未完成：${waiting.error}；${detail}` : detail
  }
  const warning = statuses.find(status => status.watchError)
  if (warning?.watchError) return warning.watchError
  const complete = statuses.find(status => status.status === 'complete' && (status.result?.changed || status.result?.warnings?.length))
  return complete?.result ? scanResultMessage(complete.result) : ''
}

export function retainResultSelection(selected: Set<number>, ids: number[]): Set<number> {
  const available = new Set(ids)
  const retained = new Set([...selected].filter(id => available.has(id)))
  return retained.size === selected.size ? selected : retained
}

/** Only the visible route subscribes. Refresh reads never replace the visible
 * tree with a spinner, so background scans preserve scroll and open editors. */
export function useLibraryScanRefresh(onRefresh: () => void, onStatus?: Dispatch<SetStateAction<string>>, libraryIds?: number[], scopeKey = ''): void {
  const route = `${scopeKey}:${[...(libraryIds ?? [])].sort((a, b) => a - b).join(',')}`
  const latest = useRef({ onRefresh, onStatus, libraryIds })
  latest.current = { onRefresh, onStatus, libraryIds }
  const currentRoute = useRef(route); currentRoute.current = route
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let revision: string | undefined
    let notice = ''
    let publishedMessage = ''
    let instanceId: string | undefined
    const retiredInstances = new Set<string>()
    const lastStatuses = new Map<number, LibraryScanStatus>()
    const publish = (message: string) => {
      if (message === publishedMessage) return
      const previousMessage = publishedMessage
      publishedMessage = message
      if (message) latest.current.onStatus?.(message)
      else if (previousMessage) latest.current.onStatus?.(current => current === previousMessage ? '' : current)
    }
    let disposed = false
    let controller: AbortController | undefined
    const poll = async () => {
      if (disposed || document.visibilityState === 'hidden' || controller) return
      const pending = new AbortController()
      controller = pending
      try {
        const snapshot = await api.libraries.scanStatus(pending.signal)
        if (disposed || pending.signal.aborted || currentRoute.current !== route || retiredInstances.has(snapshot.instanceId)) return
        if (instanceId !== snapshot.instanceId) {
          if (instanceId) retiredInstances.add(instanceId)
          instanceId = snapshot.instanceId
          lastStatuses.clear()
        }
        const visible = snapshot.libraries.filter(status => !latest.current.libraryIds?.length || latest.current.libraryIds.includes(status.libraryId))
        const relevant = visible.map(status => {
          const previous = lastStatuses.get(status.libraryId)
          if (previous && (status.sequence ?? status.revision) < (previous.sequence ?? previous.revision)) return previous
          lastStatuses.set(status.libraryId, status)
          return status
        })
        const nextRevision = `${snapshot.instanceId}:${relevant.map(status => `${status.libraryId}:${status.revision}`).join(',')}`
        if ((revision !== undefined && revision !== nextRevision) || (revision === undefined && relevant.some(status => status.revision > 0))) latest.current.onRefresh()
        revision = nextRevision
        const message = libraryScanMessage(relevant)
        const signature = `${snapshot.instanceId}:${message}`
        if (signature !== notice || message !== publishedMessage) { notice = signature; publish(message) }
      } catch (error) {
        if (!disposed && !pending.signal.aborted && currentRoute.current === route) publish(`自动更新状态读取失败：${error instanceof Error ? error.message : String(error)}`)
      } finally { if (controller === pending) controller = undefined }
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') controller?.abort()
      else void poll()
    }
    const timer = window.setInterval(() => { void poll() }, 2000)
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer)
      // The new route owns its own notice, including when its first poll has
      // no message. Do not leave the previous library's failure on screen.
      if (publishedMessage) onStatus?.(current => current === publishedMessage ? '' : current)
      window.removeEventListener('focus', poll)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [route])
}
