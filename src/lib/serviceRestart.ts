import { request } from '../api'
import type { ServiceHealth } from '../../shared/service'

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function restartService({ signal, onAccepted }: { signal: AbortSignal; onAccepted?: () => void }): Promise<void> {
  const readHealth = () => request<ServiceHealth>('/api/health', {
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
  })
  const before = await readHealth()
  if (!before.ok || !before.instanceId || !before.restartSupported) {
    throw new Error('当前服务尚不支持界面重启，请先手动重启一次 AnimeShelf，再使用此按钮。')
  }
  try {
    await request('/api/service/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
  } catch (error) {
    signal.throwIfAborted()
    // The server may have accepted the request before the connection was lost.
    // An explicit HTTP error is different: do not hide rejection or retry the POST.
    if (error instanceof Error && 'status' in error) throw error
  }
  onAccepted?.()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await pause(signal)
    try {
      const current = await readHealth()
      if (current.ok && current.instanceId && current.instanceId !== before.instanceId) return
    } catch { signal.throwIfAborted() }
  }
  throw new Error('未能确认服务重启完成。请稍后刷新页面；若仍无法连接，请查看服务日志或手动启动 AnimeShelf。')
}
