import { useEffect, useRef, useState } from 'react'
import type { FolderView, Library, Tag } from '../types'
import type { MediaDomain } from '../../shared/media-domain'
import { api } from '../api'
import { ToolbarPopover } from './FilterBar'
import TagPicker from './TagPicker'
import FolderMoveDialog from './FolderMoveDialog'
import './selection-actions.css'

export type BatchMediaDomain = MediaDomain | 'auto'

/** Keep all bulk-classification choices in one place for the select-all action. */
export const BATCH_MEDIA_DOMAIN_OPTIONS: ReadonlyArray<{ value: BatchMediaDomain; label: string }> = [
  { value: 'anime', label: '动漫' },
  { value: 'live_action', label: '真人影视' },
  { value: 'unknown', label: '待确认' },
  { value: 'auto', label: '恢复自动判断' },
]

export default function LibrarySelectionActions({ items, selected, libraries, tags, disabled, onSelectAll, onClear, onBusy, onCompleted }: {
  items: FolderView[]; selected: Set<number>; libraries: Library[]; tags: Tag[]; disabled: boolean
  onSelectAll: () => void; onClear: () => void; onBusy: (busy: boolean) => void
  onCompleted: (ids: number[]) => void
}) {
  const [panel, setPanel] = useState<'actions' | 'domain' | 'tags' | null>(null)
  const [snapshot, setSnapshot] = useState<FolderView[]>([])
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [domain, setDomain] = useState<BatchMediaDomain>('anime')
  const checkbox = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  const moveSuccesses = useRef(new Set<string>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusy(false) } }, [])
  const count = items.filter(item => selected.has(item.id)).length
  const all = items.length > 0 && count === items.length
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = count > 0 && !all }, [count, all])
  const close = () => { if (!running.current) { setPanel(null); button.current?.focus() } }
  const execute = async (action: () => Promise<Array<{ id: number; ok: boolean; error?: string }>>) => {
    if (running.current || !snapshot.length) return
    running.current = true; setBusy(true); onBusy(true); setError('')
    try {
      const result = await action()
      if (!mounted.current) return
      const completed = result.filter(item => item.ok).map(item => item.id)
      if (completed.length) onCompleted(completed)
      const failures = result.filter(item => !item.ok)
      setSnapshot(current => current.filter(item => failures.some(failure => failure.id === item.id)))
      if (failures.length) setError(failures.map(item => `${items.find(row => row.id === item.id)?.name ?? item.id}：${item.error}`).join('；'))
      else { setPanel(null); button.current?.focus() }
    } catch (e: any) { if (mounted.current) setError(e.message) }
    finally { running.current = false; if (mounted.current) { setBusy(false); onBusy(false) } }
  }
  return <>
    <div className="library-selection-controls">
      <label className="library-select-toggle"><input ref={checkbox} type="checkbox" className="accent-accent" aria-label="全选结果" aria-checked={count > 0 && !all ? 'mixed' : all} checked={all} disabled={disabled || busy || !items.length} onChange={onSelectAll} /><span>全选</span></label>
      <span className="library-selection-count" aria-live="polite">已选 {count} / {items.length} 项结果</span>
      <button ref={button} type="button" className="toolbar-trigger px-2" disabled={disabled || busy || !count} aria-haspopup="dialog" aria-expanded={Boolean(panel)} onClick={() => { setSnapshot(items.filter(item => selected.has(item.id))); setError(''); setPanel(current => current ? null : 'actions') }}>操作 ▾</button>
      <button type="button" className="toolbar-trigger px-2" disabled={!count || busy} onClick={() => { setPanel(null); onClear() }}>清除选择</button>
    </div>
    <ToolbarPopover label="所选条目操作" open={Boolean(panel)} anchorRef={button} onClose={close}>
      <div className="mb-3 flex justify-between text-sm"><strong>{snapshot.length} 个选中条目</strong><button type="button" disabled={busy} onClick={close} aria-label="关闭所选条目操作">×</button></div>
      {panel === 'actions' && <div className="grid gap-1">
        <button type="button" className="rounded px-3 py-2 text-left text-sm hover:bg-surface-hover" onClick={() => setPanel('domain')}>
          <span className="block">修改媒体分类</span>
          <span className="mt-0.5 block text-[11px] text-text-secondary">动漫 / 真人影视</span>
        </button>
        <button type="button" className="rounded px-3 py-2 text-left text-sm hover:bg-surface-hover" onClick={() => setPanel('tags')}>批量打标签</button>
        <button type="button" className="rounded px-3 py-2 text-left text-sm hover:bg-surface-hover" onClick={() => { setPanel(null); setMoveOpen(true) }}>移动到媒体库…</button>
      </div>}
      {panel === 'domain' && <div className="space-y-3">
        <p className="text-xs text-text-secondary">只修改所选条目的分类，不移动文件，也不覆盖子项分类。</p>
        <label className="block text-xs text-text-secondary" htmlFor="batch-media-domain">目标媒体分类</label>
        <select id="batch-media-domain" aria-label="批量媒体分类" className="input" value={domain} disabled={busy} onChange={e => setDomain(e.target.value as BatchMediaDomain)}>
          {BATCH_MEDIA_DOMAIN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button type="button" className="toolbar-trigger px-3" disabled={busy} onClick={() => void execute(async () => (await api.folders.setBatchMediaDomain(snapshot.map(item => item.id), domain === 'auto' ? null : domain)).results)}>{busy ? '正在修改…' : '应用分类'}</button>
      </div>}
      {panel === 'tags' && <fieldset disabled={busy}><TagPicker tags={tags} picked={new Set()} allowCreate={false} onCreate={async () => {}} onUnpick={() => {}} onPick={tag => void execute(async () => {
        const results: Array<{ id: number; ok: boolean; error?: string }> = []
        for (const item of snapshot) {
          try { await api.tags.link(tag.id, 'folder', item.id); results.push({ id: item.id, ok: true }) }
          catch (e: any) { results.push({ id: item.id, ok: false, error: e.message }) }
        }
        return results
      })} /></fieldset>}
      {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
    </ToolbarPopover>
    {moveOpen && <FolderMoveDialog open items={snapshot.map(item => ({ id: item.id, expectedPath: item.path }))} libraries={libraries} triggerRef={button} onClose={() => setMoveOpen(false)} onResult={job => {
      const done = new Set(job.items.filter(item => item.phase === 'completed' || item.phase === 'cleanup_pending').map(item => item.id))
      const ids = job.items.filter(item => (done.has(item.id) || item.coveredBy && done.has(item.coveredBy)) && !moveSuccesses.current.has(`${job.id}:${item.id}`)).map(item => item.id)
      for (const id of ids) moveSuccesses.current.add(`${job.id}:${id}`)
      if (ids.length) onCompleted(ids)
    }} />}
  </>
}
