import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModuleLibraryActionsProps } from '../../../src/modules/contracts'
import { groupLibraryActionTargets } from '../../../src/lib/libraryActionScope'
import Button from '../../../src/components/ui/Button'
import SelectMenu from '../../../src/components/ui/SelectMenu'
import OverlayPresence from '../../../src/components/ui/OverlayPresence'
import { useDialogBehavior } from '../../../src/components/ui/dialogBehavior'
import { metadataApi, type MetadataMatchProgress, type MetadataSource, type PosterRepairMode } from './api'
import { usePosterRepair } from './usePosterRepair'
import { PosterRepairFeedback } from './PosterRepairControls'

type Scope = { key: string; label: string; ids: number[]; groups: Map<number, number[]>; refresh: () => Promise<void> | void }
type Group = { libraryId: number; ids: number[]; jobId?: string; progress?: MetadataMatchProgress; state: 'starting' | 'running' | 'complete' | 'error' | 'unknown'; error?: string }
type Task = { kind: 'match' | 'clear'; scope: Scope; source: MetadataSource; groups: Group[] }
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const unfinished = (group: Group) => group.state === 'starting' || group.state === 'running' || group.state === 'unknown'
const describeScope = (scope: Scope) => `${scope.label} · ${scope.ids.length} 部作品及其后代目录`

export default function MetadataLibraryActions(props: ModuleLibraryActionsProps) {
  const [dialog, setDialog] = useState<{ kind: 'match' | 'clear'; scope: Scope } | null>(null)
  const [source, setSource] = useState<MetadataSource>('auto')
  const [task, setTask] = useState<Task | null>(null)
  const taskRef = useRef<Task | null>(null)
  const [posterScope, setPosterScope] = useState('')
  const [notice, setNotice] = useState('')
  const poster = usePosterRepair({ restore: false })
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null), closeRef = useRef<HTMLButtonElement>(null)
  const close = () => setDialog(null)
  useDialogBehavior({ open: Boolean(dialog), dialogRef, initialFocusRef: closeRef, onClose: close })
  useEffect(() => () => { generation.current++; if (timer.current) clearTimeout(timer.current) }, [])
  const publish = (next: Task) => { taskRef.current = next; setTask({ ...next, groups: [...next.groups] }) }
  const busy = Boolean(task?.groups.some(unfinished)) || poster.active
  const freeze = (): Scope => ({
    key: props.scopeKey, label: props.scopeLabel,
    ids: [...props.folderIds], groups: groupLibraryActionTargets(props.items, props.folderIds), refresh: props.onRefresh,
  })
  const prepare = (kind: 'match' | 'clear') => {
    if (!props.scopeReady || busy) return
    try { setDialog({ kind, scope: freeze() }); setNotice(''); props.closeMenu() }
    catch (error) { setNotice(reason(error)); props.closeMenu() }
  }
  const startPoster = (mode: PosterRepairMode) => {
    if (!props.scopeReady || busy) return
    try {
      const scope = freeze()
      setPosterScope(describeScope(scope)); setNotice(''); props.closeMenu()
      void poster.start(mode, { folderIds: scope.ids, includeFavorites: false }, scope.refresh)
    } catch (error) { setNotice(reason(error)); props.closeMenu() }
  }
  const poll = async (target: Task, current: number, includeUnknown = false) => {
    const groups = await Promise.all(target.groups.map(async group => {
      if (!group.jobId || (group.state !== 'running' && !(includeUnknown && group.state === 'unknown'))) return group
      try {
        const progress = await metadataApi.libraryMatchStatus(group.libraryId, group.jobId)
        if (progress.jobId !== group.jobId) throw new Error('返回的任务标识不一致，请重新读取')
        const failed = progress.error || progress.failed > 0 || progress.status === 'failed' || progress.status === 'cancelled'
        return { ...group, progress, state: progress.running ? 'running' : failed ? 'error' : 'complete', error: progress.error || (progress.failed ? `匹配失败 ${progress.failed} 项` : progress.status === 'cancelled' ? '任务已取消' : undefined) } as Group
      } catch (error) { return { ...group, state: 'unknown', error: `状态读取失败：${reason(error)}` } as Group }
    }))
    if (generation.current !== current) return
    const next = { ...target, groups }; publish(next)
    if (groups.some(group => group.state === 'running')) timer.current = setTimeout(() => { void poll(next, current) }, 1000)
    if (groups.some((group, i) => !unfinished(group) && unfinished(target.groups[i]))) await target.scope.refresh()
  }
  const run = async (kind: Task['kind'], scope: Scope, runSource: MetadataSource, only?: Group[]) => {
    if (taskRef.current?.groups.some(unfinished) || poster.active) return
    const current = ++generation.current
    if (timer.current) clearTimeout(timer.current)
    const groups = only ?? [...scope.groups].map(([libraryId, ids]) => ({ libraryId, ids, state: 'starting' as const }))
    const pending: Task = { kind, scope, source: runSource, groups: groups.map(group => ({ libraryId: group.libraryId, ids: group.ids, state: 'starting' })) }
    publish(pending); setDialog(null); setNotice('')
    const started = await Promise.all(pending.groups.map(async group => {
      try {
        if (kind === 'clear') { await metadataApi.clearLibrary(group.libraryId, group.ids); return { ...group, state: 'complete' } as Group }
        const result = await metadataApi.matchLibrary(group.libraryId, runSource, group.ids)
        if (!result.jobId) throw new Error('服务器未返回任务标识，不能安全跟踪任务')
        return { ...group, jobId: result.jobId, state: 'running' } as Group
      } catch (error) { return { ...group, state: 'error', error: reason(error) } as Group }
    }))
    if (generation.current !== current) return
    const next = { ...pending, groups: started }; publish(next)
    if (kind === 'match' && started.some(group => group.state === 'running')) void poll(next, current)
    if (kind === 'clear' && started.some(group => group.state === 'complete')) await scope.refresh()
  }
  const failed = task?.groups.filter(group => group.state === 'error') ?? []
  const unknown = task?.groups.some(group => group.state === 'unknown') ?? false
  const active = task?.groups.some(unfinished) ?? false
  const actionClass = 'flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:cursor-not-allowed'
  return <>
    {props.menuContainer && createPortal(<>
      <p className="px-3 pb-2 text-[11px] text-text-secondary">{props.scopeLabel} · {props.folderIds.length} 部作品</p>
      <button type="button" role="menuitem" className={actionClass} disabled={!props.scopeReady || busy} onClick={() => startPoster('missing')}>补齐缺失海报</button>
      <button type="button" role="menuitem" className={actionClass} disabled={!props.scopeReady || busy} onClick={() => startPoster('refresh')}>强制刷新海报</button>
      <button type="button" role="menuitem" className={actionClass} disabled={!props.scopeReady || busy} onClick={() => prepare('match')}>匹配元数据</button>
      <div className="my-1 border-t border-border/60" />
      <button type="button" role="menuitem" className={`${actionClass} text-red-400`} disabled={!props.scopeReady || busy} onClick={() => prepare('clear')}>清除元数据</button>
    </>, props.menuContainer)}
    {(task || poster.message || notice) && <section className="library-task-feedback space-y-1 pt-1 text-xs text-text-secondary" aria-label="管理任务反馈">
      {notice && <p role="alert">{notice}</p>}
      {poster.message && <PosterRepairFeedback task={poster} scopeLabel={posterScope} />}
      {task && <div className="space-y-1.5">
        <p role="status" className={failed.length || unknown ? 'text-warning' : undefined}>{task.kind === 'match' ? '匹配元数据' : '清除元数据'} · {task.scope.ids.length} 部作品 · {active ? unknown ? '部分任务状态待确认，请重新读取；不会重复启动。' : '任务进行中…' : failed.length ? `任务部分或全部失败（${failed.length}/${task.groups.length} 个媒体库），请查看详情。` : '范围内任务已完成'}</p>
        <details><summary className="cursor-pointer">查看媒体库任务详情</summary><p className="py-1">{describeScope(task.scope)}</p>
        <ul className="max-h-32 overflow-y-auto space-y-1">{task.groups.map(group => <li key={group.libraryId}>
          媒体库 {group.libraryId} · {group.ids.length} 部作品：{group.error || (group.state === 'complete' ? '完成' : '处理中…')}
          {group.progress && <span>（{group.progress.done}/{group.progress.total}，匹配 {group.progress.matched}，失败 {group.progress.failed}）{group.progress.current}</span>}
          {group.progress?.reasons && Object.entries(group.progress.reasons).length > 0 && <span className="ml-2">{Object.entries(group.progress.reasons).map(([key, count]) => `${key}: ${count}`).join('；')}</span>}
        </li>)}</ul></details>
        {unknown && <Button size="sm" variant="secondary" onClick={() => { if (timer.current) clearTimeout(timer.current); void poll(task, ++generation.current, true) }}>重新读取匹配任务状态</Button>}
        {!active && failed.length > 0 && <Button size="sm" variant="secondary" disabled={poster.active} onClick={() => {
          if (task.kind === 'clear') setDialog({ kind: 'clear', scope: { ...task.scope, ids: failed.flatMap(group => group.ids), groups: new Map(failed.map(group => [group.libraryId, group.ids])) } })
          else void run(task.kind, task.scope, task.source, failed)
        }}>重试失败媒体库</Button>}
      </div>}
    </section>}
    {typeof document !== 'undefined' && createPortal(<OverlayPresence open={Boolean(dialog)}>
      {dialog && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="metadata-scope-title" tabIndex={-1} className="clean-dialog ui-panel-strong w-full max-w-lg rounded-xl border border-border p-5 shadow-xl">
          <div className="flex items-center justify-between gap-3"><h2 id="metadata-scope-title" className="font-semibold">{dialog.kind === 'match' ? '匹配元数据' : '清除元数据'}</h2><button ref={closeRef} type="button" aria-label="关闭" onClick={close}>×</button></div>
          <p className="mt-3 text-sm text-text-secondary">已冻结范围：{describeScope(dialog.scope)}</p>
          {dialog.kind === 'match' ? <div className="my-4"><SelectMenu value={source} onChange={setSource} ariaLabel="匹配数据源" menuPosition="fixed" options={[{ value: 'auto', label: '自动（按媒体类型）' }, { value: 'anilist', label: 'AniList' }, { value: 'bangumi', label: 'Bangumi' }, { value: 'tmdb', label: 'TMDB' }]} /></div> : <p className="my-4 text-sm text-red-400">将清除以上作品及其后代目录的评分、简介、海报和绑定；目录结构与标签保留。此操作不可撤销。</p>}
          <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={close}>取消</Button><Button variant={dialog.kind === 'clear' ? 'danger' : 'primary'} disabled={busy} onClick={() => { void run(dialog.kind, dialog.scope, source) }}>{dialog.kind === 'match' ? '开始匹配' : '确认清除'}</Button></div>
        </div>
      </div>}
    </OverlayPresence>, document.body)}
  </>
}
