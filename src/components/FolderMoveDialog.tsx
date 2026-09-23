import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Library } from '../types'
import type { FolderMoveJob, FolderMovePreview, MoveSelection } from '../../shared/folder-moves'
import { folderMoves } from '../lib/folderMoves'
import { useDialogBehavior } from './ui/dialogBehavior'
import Button from './ui/Button'

const phases: Record<string, string> = { pending: '等待', copying: '复制中', verified: '已校验', source_staged: '源已暂存', published: '目标就绪', committed: '已提交', completed: '成功', failed: '失败', skipped: '跳过', cancelled: '已取消', cleanup_pending: '源副本待清理', needs_attention: '需要核对' }
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
export default function FolderMoveDialog({ open, items, libraries, onClose, onResult, triggerRef }: {
  open: boolean; items: MoveSelection[]; libraries: Library[]; onClose: () => void
  onResult?: (job: FolderMoveJob) => void; triggerRef?: RefObject<HTMLElement>
}) {
  const [targetId, setTargetId] = useState(libraries[0]?.id ?? 0)
  const [relative, setRelative] = useState('')
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof folderMoves.directories>>>()
  const [preview, setPreview] = useState<FolderMovePreview>()
  const [job, setJob] = useState<FolderMoveJob>()
  const [jobs, setJobs] = useState<FolderMoveJob[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const requestKey = useRef(crypto.randomUUID())
  const snapshot = useRef(items.map(item => ({ ...item })))
  const report = useRef(onResult); report.current = onResult
  const reported = useRef('')
  const mounted = useRef(true)
  const running = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useDialogBehavior({ open, dialogRef, initialFocusRef: closeRef, triggerRef, onClose })
  useEffect(() => {
    if (!open) return
    let current = true
    void folderMoves.list().then(value => { if (current) setJobs(value) }).catch(e => { if (current) setError(e.message) })
    return () => { current = false }
  }, [open, job?.status])
  useEffect(() => {
    if (!open || !targetId || job) return
    let current = true
    setDirectory(undefined); setDirectoryBusy(true); setPreview(undefined)
    requestKey.current = crypto.randomUUID()
    void folderMoves.directories(targetId, relative).then(value => { if (current) { setDirectory(value); setError('') } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setDirectoryBusy(false) })
    return () => { current = false }
  }, [open, targetId, relative, Boolean(job)])
  useEffect(() => {
    if (!open || !job) return
    const signature = `${job.id}:${job.items.map(item => `${item.id}:${item.phase}`).join(',')}`
    if (signature !== reported.current) { reported.current = signature; report.current?.(job) }
    if (job.status !== 'running') return
    let current = true
    const timer = window.setTimeout(() => { void folderMoves.get(job.id).then(value => { if (current) { setJob(value); setError('') } }).catch(e => { if (current) { setError(`读取进度失败，可重新打开任务：${e.message}`); setJob(value => value ? { ...value } : value) } }) }, 1000)
    return () => { current = false; window.clearTimeout(timer) }
  }, [open, job])
  const run = async (action: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await action() } catch (e: any) { if (mounted.current) setError(e.message) }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const input = { items: snapshot.current, targetLibraryId: targetId, targetRelativePath: relative }
  if (!open) return null
  return createPortal(<div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="移动到媒体库" tabIndex={-1} className="clean-dialog ui-panel-strong flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border shadow-2xl">
      <header className="flex items-center justify-between border-b border-border px-5 py-3"><h2 className="font-semibold">移动到媒体库</h2><button ref={closeRef} type="button" onClick={onClose} aria-label="关闭移动对话框" className="toolbar-trigger px-2">关闭 ×</button></header>
      <div className="min-h-0 space-y-4 overflow-y-auto p-5">
        {!job && snapshot.current.length > 0 && <>
          <p className="text-xs text-text-secondary">将移动 {snapshot.current.length} 个选中目录及其中所有文件；保留元数据与标签。同名不覆盖、不合并。</p>
          <label className="block text-sm">目标媒体库<select aria-label="目标媒体库" className="input mt-1" value={targetId} disabled={busy} onChange={event => { setTargetId(Number(event.target.value)); setRelative(''); setPreview(undefined) }}>{libraries.map(lib => <option key={lib.id} value={lib.id}>{lib.name}</option>)}</select></label>
          <div className="space-y-2"><p className="break-all text-xs text-text-secondary">目标目录：{directory?.path ?? (directoryBusy ? '读取中…' : '不可用')}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !relative} onClick={() => setRelative('')}>库根目录</Button><Button size="sm" disabled={busy || !relative} onClick={() => setRelative(relative.split(/[\\/]/).slice(0, -1).join('/'))}>上一级</Button></div>
            <select aria-label="进入已有子目录" className="input" value="" disabled={busy || !directory || directoryBusy} onChange={event => { if (event.target.value) setRelative(event.target.value) }}><option value="">使用当前目录，或进入已有子目录…</option>{directory?.children.map(child => <option key={child.relativePath} value={child.relativePath}>{child.name}</option>)}</select>
          </div>
          {!preview ? <Button disabled={busy || directoryBusy || !directory} onClick={() => void run(async () => setPreview(await folderMoves.preview(input)))}>检查目标并预览</Button> : <>
            <p className="text-xs text-text-secondary">可移动 {preview.items.filter(item => item.phase === 'pending').length} 项 · {size(preview.bytes)}。原继承标签会保留到条目。</p>
            <ul className="max-h-64 divide-y divide-border overflow-auto text-xs">{preview.items.map(item => <li key={item.id} className="space-y-1 py-2"><strong>{item.name}</strong><p className="break-all text-text-secondary">{item.sourcePath} → {item.targetPath}</p><p className={item.error ? 'text-warning' : ''}>{item.error ?? `${item.crossVolume ? '跨盘复制并校验' : '同盘移动'} · ${size(item.bytes)}`}</p></li>)}</ul>
            <Button variant="primary" disabled={busy || !preview.items.some(item => item.phase === 'pending')} onClick={() => void run(async () => setJob(await folderMoves.create(preview.input, requestKey.current)))}>{busy ? '提交中…' : '确认移动文件'}</Button>
          </>}
        </>}
        {job && <>
          <p role="status" className="text-sm">{job.status === 'running' ? '正在迁移；关闭此窗口不会停止任务。' : job.status === 'completed' ? '任务已结束，请查看逐项结果。' : job.status === 'cancelled' ? '已取消未完成项。' : '任务暂停，等待处理。'}</p>
          <p className="text-xs text-text-secondary">成功 {job.items.filter(item => item.phase === 'completed').length} · 失败 {job.items.filter(item => item.phase === 'failed').length} · 跳过 {job.items.filter(item => item.phase === 'skipped').length}</p>
          <ul className="divide-y divide-border text-xs">{job.items.map(item => <li key={item.id} className="space-y-1 py-2"><div className="flex justify-between gap-3"><strong>{item.name}</strong><span>{phases[item.phase]}</span></div><p className="break-all text-text-secondary">{item.sourcePath} → {item.targetPath}</p>{['copying', 'verified'].includes(item.phase) && <><progress aria-label={`${item.name} 移动进度`} className="w-full" max={item.bytes || 1} value={item.copiedBytes} /><p>{size(item.copiedBytes)} / {size(item.bytes)}</p></>}{item.error && <p className="text-warning">{item.error}</p>}{item.recoveryPaths?.map(value => <p key={value} className="break-all text-text-secondary">恢复暂存路径：{value}</p>)}{Boolean(item.log?.length) && <details><summary className="cursor-pointer text-text-secondary">处理记录</summary><ol className="space-y-1 py-2">{item.log!.map((entry, index) => <li key={index}>{new Date(entry.at).toLocaleTimeString()} · {phases[entry.phase]}{entry.error ? ` · ${entry.error}` : ''}</li>)}</ol></details>}</li>)}</ul>
          {job.error && <p className="text-xs text-warning">{job.error}</p>}
          <div className="flex flex-wrap gap-2">{job.status === 'running' ? <Button disabled={busy || job.cancelRequested} onClick={() => void run(async () => setJob(await folderMoves.action(job.id, 'cancel')))}>{job.cancelRequested ? '正在安全停止…' : '取消未完成项'}</Button> : <>
            {job.items.some(item => item.phase === 'needs_attention') ? <Button disabled={busy} onClick={() => void run(async () => setJob(await folderMoves.action(job.id, 'reconcile')))}>重新检查并恢复原位置</Button> : <>
              {job.items.some(item => ['pending', 'cancelled', 'cleanup_pending'].includes(item.phase)) && <Button disabled={busy} onClick={() => void run(async () => setJob(await folderMoves.action(job.id, 'resume')))}>继续任务</Button>}
              {job.items.some(item => item.phase === 'failed') && <Button disabled={busy} onClick={() => void run(async () => setJob(await folderMoves.action(job.id, 'retry')))}>重试失败项</Button>}
            </>}
          </>}<Button variant="ghost" disabled={busy} onClick={() => { setJob(undefined); setPreview(undefined) }}>返回任务列表</Button></div>
        </>}
        {error && <p role="alert" className="text-sm text-warning">{error}</p>}
        {!job && <section className="border-t border-border pt-3"><h3 className="mb-2 text-sm font-medium">最近移动任务</h3>{jobs.length ? <ul className="space-y-1">{jobs.map(value => <li key={value.id}><button type="button" className="flex w-full justify-between gap-2 rounded px-2 py-2 text-left text-xs hover:bg-surface-hover" onClick={() => void run(async () => setJob(await folderMoves.get(value.id)))}><span>{new Date(value.createdAt).toLocaleString()} · {value.items.length} 项</span><span>{value.status === 'running' ? '进行中' : value.status === 'completed' ? '已结束' : value.status === 'paused' ? '待处理' : '已取消'}</span></button></li>)}</ul> : <p className="text-xs text-text-secondary">暂无任务</p>}</section>}
      </div>
    </div>
  </div>, document.body)
}
