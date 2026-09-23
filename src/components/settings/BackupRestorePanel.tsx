import { useEffect, useRef, useState } from 'react'
import { api, request } from '../../api'
import Button from '../ui/Button'
import type { RestoreEntry as Entry, RestorePreview as Preview } from '../../../shared/restore'
type Backup = Awaited<ReturnType<typeof api.settings.listBackups>>['backups'][number]
const headers = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

export default function BackupRestorePanel({ onRestored, onBusyChange }: { onRestored?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [backups, setBackups] = useState<Backup[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [paths, setPaths] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [done, setDone] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const active = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const run = async (action: () => Promise<void>) => {
    if (active.current) return
    active.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage('')
    try { await action() } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { active.current = false; if (mounted.current) { setBusy(false); onBusyChange?.(false) } }
  }
  const inspect = async (body: unknown) => {
    const next = await request<Preview>('/api/settings/backups/inspect', { method: 'POST', headers, body: JSON.stringify(body) })
    if (!mounted.current) return
    setPreview(next); setDone(false); setPaths({})
  }
  const resolve = (entry: Entry, keepMissing = false) => run(() => inspect({ previewId: preview!.previewId, resolutions: [{ folderId: entry.folderId, ...(keepMissing ? { keepMissing: true } : { path: paths[entry.folderId]?.trim() }) }] }))
  const visibleEntries = preview?.entries.filter(entry => {
    if (expanded) return true
    if (entry.status !== 'unresolved') return false
    // Resolve the highest missing ancestor first; its selection applies to descendants.
    let parent = preview.entries.find(item => item.folderId === entry.parentId)
    while (parent) {
      if (parent.status === 'unresolved') return false
      parent = preview.entries.find(item => item.folderId === parent!.parentId)
    }
    return true
  }) ?? []

  return <div className="space-y-3 border-t border-border/60 pt-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-medium">恢复备份</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async () => {
        const result = await api.settings.listBackups(); setBackups(result.backups)
        if (!result.backups.length) setMessage('暂无可用备份')
      }) }}>查看可用备份</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => uploadRef.current?.click()}>选择 .db 文件…</Button>
      <input ref={uploadRef} type="file" accept=".db,.sqlite,.sqlite3" className="hidden" aria-label="选择数据库备份" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file) return
        void run(async () => {
          if (file.size > 35 * 1024 * 1024) throw new Error('上传备份请小于35 MB；更大的备份请放入备份目录后从列表选择')
          const data = await new Promise<string>((resolveData, reject) => {
            const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取备份'))
            reader.onload = () => resolveData(String(reader.result).split(',')[1]); reader.readAsDataURL(file)
          })
          await inspect({ name: file.name, data })
        })
      }} />
    </div>
    <p className="text-xs text-text-secondary">先预检并确认位置，再恢复数据库；保留当前磁盘名称。</p>
    {backups.length > 0 && <div className="max-h-44 divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/50">
      {backups.map(backup => <div key={`${backup.dir}:${backup.name}`} className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate" title={backup.path}>{backup.name}</span>
        <span className="text-text-secondary">{backup.dir === 'auto' ? '自动' : '手动'}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => inspect({ file: backup.name, dir: backup.dir })) }}>预检</Button>
      </div>)}
    </div>}
    {preview && <section aria-label="恢复路径预览" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">路径预览 · {preview.entries.length} 个目录</span>
        <button className="text-xs text-accent" onClick={() => setExpanded(value => !value)}>{expanded ? '只看待处理' : '查看全部路径'}</button>
      </div>
      <div role="status" className="text-xs text-text-secondary">
        直接恢复 {preview.entries.filter(entry => entry.status === 'direct').length} · 路径协调 {preview.entries.filter(entry => entry.status === 'coordinated').length} · 保留缺失 {preview.entries.filter(entry => entry.status === 'missing').length} · 待处理 {preview.unresolved}
      </div>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {visibleEntries.map(entry => <div key={entry.folderId} className="space-y-2 border-t border-border/50 pt-3 text-xs">
          <div className="font-medium text-text-primary">{entry.name}</div>
          <div className="break-all text-text-secondary">{entry.fromPath}{entry.toPath !== entry.fromPath && <> → {entry.toPath}</>}</div>
          {entry.status === 'unresolved' ? <>
            <p className="text-amber-200">{entry.reason}</p>
            {entry.candidates.length > 0 && <select aria-label={`为 ${entry.name} 选择候选位置`} value="" disabled={busy} onChange={event => setPaths(value => ({ ...value, [entry.folderId]: event.target.value }))} className="w-full rounded border border-border bg-bg p-2">
              <option value="">内容匹配的候选目录（需确认）</option>
              {entry.candidates.map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>}
            <input aria-label={`为 ${entry.name} 指定位置`} className="w-full rounded border border-border bg-bg p-2" placeholder="输入正确目录的绝对路径" disabled={busy} value={paths[entry.folderId] ?? ''} onChange={event => setPaths(value => ({ ...value, [entry.folderId]: event.target.value }))} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy || !paths[entry.folderId]?.trim()} onClick={() => { void resolve(entry) }}>确认关联此目录及下级</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void resolve(entry, true) }}>保留为缺失条目</Button>
            </div>
          </> : <span className="text-text-secondary">{entry.status === 'missing' ? '保留资料和标签，扫描不会删除' : entry.status === 'coordinated' ? '使用当前磁盘位置' : '位置已核对'}</span>}
        </div>)}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>取消</Button>
        <Button size="sm" variant="primary" disabled={busy || preview.unresolved > 0} onClick={() => {
          if (!confirm('确认按预览恢复数据库？恢复前会保留当前数据库备份，磁盘名称不会改变。')) return
          void run(async () => {
            const result = await api.settings.restoreBackup(preview.previewId)
            setMessage(`已恢复 ${result.tables} 张表、${result.rows} 行数据${result.warning ? `。${result.warning}` : ''}`); setPreview(null); setBackups([]); setDone(true); onRestored?.()
          })
        }}>{busy ? '处理中…' : '确认应用恢复'}</Button>
      </div>
    </section>}
    {busy && <p role="status" className="text-xs text-accent">正在处理，请稍候…</p>}
    {error && <p role="alert" className="break-all text-xs text-red-300">{error}</p>}
    {message && <p role="status" className="text-xs text-text-secondary">{message}</p>}
    {done && <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>刷新页面查看</Button>}
  </div>
}
