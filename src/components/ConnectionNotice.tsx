import { useSyncExternalStore } from 'react'
import { getRecoveringReadCount, subscribeToReadRecovery } from '../lib/readRecovery'

export default function ConnectionNotice() {
  const pending = useSyncExternalStore(subscribeToReadRecovery, getRecoveringReadCount, () => 0)
  if (!pending) return null
  return (
    <div role="status" className="connection-notice clean-notice fixed bottom-4 left-1/2 z-[80] -translate-x-1/2 rounded-xl border border-amber-300/20 bg-[#282014]/95 px-4 py-3 text-sm text-amber-100 shadow-xl">
      暂时无法连接服务，正在自动重试…
    </div>
  )
}
