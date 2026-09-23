import { useState } from 'react'
import { Link } from 'react-router-dom'
import Button from '../../../src/components/ui/Button'
import { usePosterRepair } from './usePosterRepair'
import type { PosterRepairMode } from './api'

export function PosterRepairFeedback({ task, scopeLabel }: { task: ReturnType<typeof usePosterRepair>; scopeLabel?: string }) {
  const { job, active, pending, statusError, message, retry, reloadStatus } = task
  if (!message && !job) return null
  return <div className="poster-task-feedback text-xs text-text-secondary" aria-label="海报任务反馈">
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
    {message && <p role="status" title={scopeLabel} className={job?.failed ? 'text-warning' : undefined}>{message}</p>}
    {job && active && <div className="flex min-w-0 items-center gap-2">
      {active && job.total > 0 && <progress aria-label="海报任务进度" value={job.processed} max={job.total} className="h-1.5 w-28 accent-accent" />}
      {job.current && active && <span className="max-w-64 truncate" title={job.current}>{job.current}</span>}
    </div>}
    </div>
    {job && job.failures.length > 0 && <details>
      <summary className="cursor-pointer text-warning">查看未完成项（{job.failures.length} 项）</summary>
      {scopeLabel && <p className="mt-1 text-text-secondary">{scopeLabel}</p>}
      <ul className="my-2 max-h-40 overflow-y-auto space-y-2">{job.failures.map(failure => <li key={failure.key}>
        {failure.name}：{failure.reason}
        {failure.code === 'SOURCE_CONFIRMATION_REQUIRED' && failure.folderIds?.map(id => <Link key={id} className="ml-2 text-accent underline underline-offset-2" to={`/folder/${id}?metadata=match`}>确认来源{failure.folderIds.length > 1 ? ` #${id}` : ''}</Link>)}
      </li>)}</ul>
      {!active && job.failures.some(failure => failure.retryable) && <Button size="sm" variant="secondary" onClick={() => { void retry() }}>重试可恢复的失败项</Button>}
    </details>}
    {statusError && <Button size="sm" variant="secondary" disabled={pending} onClick={() => { void reloadStatus() }}>重新读取海报任务状态</Button>}
  </div>
}

export default function PosterRepairControls({ libraryId, includeFavorites = false, missingOnly = false, onRefresh, onStatus }: {
  libraryId?: number; includeFavorites?: boolean; missingOnly?: boolean
  onRefresh?: () => Promise<void> | void; onStatus?: (message: string) => void
}) {
  const task = usePosterRepair({ scope: { libraryId, includeFavorites }, onRefresh, onStatus })
  const [lastMode, setLastMode] = useState<PosterRepairMode>('missing')
  const start = (mode: PosterRepairMode) => { setLastMode(mode); void task.start(mode) }
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button size="sm" variant="secondary" disabled={task.active} onClick={() => start('missing')}>{task.active && lastMode === 'missing' ? '处理中…' : '补齐缺失海报'}</Button>
      {!missingOnly && <Button size="sm" variant="secondary" disabled={task.active} onClick={() => start('refresh')}>强制刷新海报</Button>}
    </div>
    <PosterRepairFeedback task={task} />
  </div>
}
