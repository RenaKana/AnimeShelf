import { useEffect, useRef, useState } from 'react'
import { metadataApi, type PosterRepairJob, type PosterRepairMode, type PosterRepairScope } from './api'

const running = (job: PosterRepairJob | null) => job?.status === 'queued' || job?.status === 'running'
export function posterRepairSummary(job: PosterRepairJob): string {
  const confirmation = job.failures.filter(failure => failure.code === 'SOURCE_CONFIRMATION_REQUIRED').length
  const counts = `更新 ${job.repaired}，已有 ${job.skipped}，待确认 ${confirmation}，失败 ${job.failed - confirmation}`
  if (running(job)) return `海报任务进行中：${job.processed}/${job.total}，${counts}`
  if (job.status === 'failed') return `海报任务失败：${job.error ?? '未知错误'}`
  if (job.status === 'cancelled') return '海报任务已取消'
  return `海报任务${job.failed ? '有未完成项' : '完成'}：${counts}`
}

/** One controller for settings and library actions. Poll only the returned task ID. */
export function usePosterRepair(options: {
  scope?: PosterRepairScope; restore?: boolean; onRefresh?: () => Promise<void> | void; onStatus?: (message: string) => void
} = {}) {
  const { scope = {}, restore = true } = options
  const [job, setJob] = useState<PosterRepairJob | null>(null)
  const [pending, setPending] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [message, setMessage] = useState('')
  const generation = useRef(0), busy = useRef(false)
  const jobRef = useRef<PosterRepairJob | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacks = useRef(options); callbacks.current = options
  const completion = useRef(options.onRefresh)
  const completed = useRef(new Set<string>())
  const scopeKey = JSON.stringify(scope)
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const report = (value: string) => { setMessage(value); callbacks.current.onStatus?.(value) }
  const accept = async (next: PosterRepairJob, current: number) => {
    if (generation.current !== current) return
    jobRef.current = next; setJob(next); setStatusError(''); report(posterRepairSummary(next))
    if (running(next)) timer.current = setTimeout(() => { void poll(next.jobId, current) }, 900)
    else {
      busy.current = false
      if (!completed.current.has(next.jobId)) {
        completed.current.add(next.jobId)
        await completion.current?.()
      }
    }
  }
  const poll = async (jobId: string, current: number) => {
    try {
      const next = await metadataApi.posterRepairStatus(jobId)
      if (next.jobId !== jobId) throw new Error('返回的海报任务标识不一致，请重新读取')
      await accept(next, current)
    }
    catch (error) {
      if (generation.current !== current) return
      const reason = `海报任务状态读取失败：${error instanceof Error ? error.message : String(error)}`
      setStatusError(reason); report(reason)
      // Unknown is not completion. Retain identity, scope, and the busy guard.
    }
  }
  useEffect(() => {
    const current = ++generation.current
    stop(); busy.current = false; jobRef.current = null; setJob(null); setPending(false); setMessage(''); setStatusError('')
    completion.current = callbacks.current.onRefresh
    if (restore) {
      busy.current = true; setPending(true)
      metadataApi.latestPosterRepair(scope.libraryId, scope.includeFavorites, scope.folderIds).then(async latest => {
        if (generation.current !== current) return
        if (latest) await accept(latest, current)
        else busy.current = false
      }).catch(error => {
        if (generation.current !== current) return
        busy.current = false
        const reason = `海报任务状态读取失败：${error instanceof Error ? error.message : String(error)}`
        setStatusError(reason); report(reason)
      }).finally(() => { if (generation.current === current) setPending(false) })
    }
    return () => { generation.current++; stop() }
  }, [scopeKey, restore])
  const launch = async (request: () => ReturnType<typeof metadataApi.repairPosters>, refresh?: () => Promise<void> | void) => {
    if (busy.current) return
    busy.current = true; setPending(true); setStatusError(''); stop()
    const current = ++generation.current
    completion.current = refresh ?? callbacks.current.onRefresh
    try {
      const result = await request()
      if (result.jobId !== result.job.jobId) throw new Error('返回的海报任务标识不一致，请重新读取')
      await accept(result.job, current)
    } catch (error) {
      if (generation.current === current) { busy.current = false; report(`海报任务启动失败：${error instanceof Error ? error.message : String(error)}`) }
    } finally { if (generation.current === current) setPending(false) }
  }
  const start = (mode: PosterRepairMode, target = scope, refresh?: () => Promise<void> | void) => launch(() => metadataApi.repairPosters({ ...target, mode }), refresh)
  const retry = () => jobRef.current ? launch(() => metadataApi.retryPosterRepair(jobRef.current!.jobId), completion.current) : Promise.resolve()
  const reloadStatus = async () => {
    if (pending) return
    const current = ++generation.current
    stop(); setPending(true)
    try {
      const next = jobRef.current ? await metadataApi.posterRepairStatus(jobRef.current.jobId) : await metadataApi.latestPosterRepair(scope.libraryId, scope.includeFavorites, scope.folderIds)
      if (generation.current !== current) return
      if (next && jobRef.current && next.jobId !== jobRef.current.jobId) throw new Error('返回的海报任务标识不一致，请重新读取')
      setStatusError('')
      if (next) await accept(next, current)
      else { busy.current = false; setMessage('没有此范围的海报任务') }
    } catch (error) {
      if (generation.current === current) { const reason = `海报任务状态读取失败：${error instanceof Error ? error.message : String(error)}`; setStatusError(reason); report(reason) }
    } finally { if (generation.current === current) setPending(false) }
  }
  return { job, pending, active: pending || running(job), statusError, message, start, retry, reloadStatus }
}
