import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { FileItem, Tag } from '../types'
import { api } from '../api'
import TagPicker from '../components/TagPicker'
import Button from '../components/ui/Button'
import { FileIcon, FolderIcon, PlayIcon } from '../components/ui/Icons'
import { revealFileLocation } from '../lib/libraryActions'
import { useLibraryScanRefresh } from '../lib/libraryScan'

export default function FileDetail({ fileId }: { fileId: number }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [item, setItem] = useState<FileItem | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [error, setError] = useState('')
  const [locationBusy, setLocationBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [scanNotice, setScanNotice] = useState('')
  const requestSeq = useRef(0)
  const currentFileId = useRef(fileId)
  currentFileId.current = fileId
  const collectionContext = useMemo(() => {
    const rootId = Number(searchParams.get('collection'))
    const entryId = searchParams.get('entry')?.trim() ?? ''
    const view = searchParams.get('view')
    return Number.isSafeInteger(rootId) && rootId > 0 && entryId && (view === 'watch' || view === 'structure') ? { rootId, entryId, view } : null
  }, [searchParams])
  const load = useCallback(async (background = false) => {
    const seq = ++requestSeq.current
    setError('')
    try {
      const [f, t] = await Promise.all([api.files.get(fileId), api.tags.list()])
      if (seq === requestSeq.current && currentFileId.current === fileId) { setItem(f); setTags(t) }
    } catch (e: any) {
      if (seq === requestSeq.current && currentFileId.current === fileId) {
        if (background) setNotice(`媒体库刷新失败：${e.message ?? String(e)}`)
        else setError(e.message ?? String(e))
      }
    }
  }, [fileId])
  useEffect(() => { void load(); return () => { requestSeq.current++ } }, [load])
  useLibraryScanRefresh(() => { void load(true) }, setScanNotice, item ? [item.library_id] : undefined, `file:${fileId}`)
  if (error) {
    return (
      <div className="clean-state p-6 text-text-secondary">
        <p>加载失败：{error}</p>
        <button className="mt-3 bg-accent text-white rounded-lg px-4 py-2 text-sm" onClick={() => { void load() }}>重试</button>
      </div>
    )
  }
  if (!item || item.id !== fileId) return <div className="clean-state p-6 text-text-secondary">加载中…</div>

  const pickedIds = new Set(item.tags.map(t => t.id))
  const fmt = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`)

  return (
    <div className="file-detail-page clean-page p-6 space-y-6">
      {collectionContext && <div className="page-breadcrumb ui-panel flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <button type="button" className="rounded-lg px-2 py-1.5 transition hover:bg-white/[0.055] hover:text-white" onClick={() => { const query = new URLSearchParams({ collection: String(collectionContext.rootId), entry: collectionContext.entryId, view: collectionContext.view }); navigate(`/folder/${item.folder_id}?${query.toString()}`) }}>← 返回合集内容</button>
        <span className="text-white/15">/</span>
        <button type="button" className="rounded-lg px-2 py-1.5 transition hover:bg-white/[0.055] hover:text-white" onClick={() => navigate(`/folder/${collectionContext.rootId}?collectionView=${collectionContext.view}`)}>返回合集</button>
      </div>}
      <div className="clean-page-header page-header ui-panel">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.045] text-accent"><FileIcon width={17} height={17} /></span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 truncate text-xs text-text-secondary" title={item.path}>{item.path}</div>
              <h1 className="page-title break-all text-2xl font-bold">{item.name}</h1>
              {item.path_missing === 1 && <span className="text-xs text-amber-300">文件缺失 · 标签已保留</span>}
            </div>
          </div>
          <Button
            className="self-start"
            size="sm"
            variant="ghost"
            icon={<FolderIcon width={15} height={15} />}
            disabled={locationBusy || item.path_missing === 1}
            onClick={async () => {
              if (locationBusy) return
              setLocationBusy(true)
              try { await revealFileLocation(item.id) }
              catch (caught) { alert(`定位失败：${caught instanceof Error ? caught.message : String(caught)}`) }
              finally { setLocationBusy(false) }
            }}>
            {locationBusy ? '正在打开…' : '打开所在位置'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2 text-sm text-text-secondary">
          <span>📦 {item.size ? fmt(item.size) : '未知大小'}</span>
          <span>🕒 {item.date_modified ? new Date(item.date_modified * 1000).toLocaleString() : '—'}</span>
        </div>
      </div>
      {notice && <p role="status" className="text-xs text-text-secondary">{notice}</p>}
      {scanNotice && <p role="status" className="text-xs text-text-secondary">{scanNotice}</p>}
      <div className="clean-section ui-panel bg-surface border border-border rounded-xl p-4">
        <TagPicker tags={tags} picked={pickedIds}
          onPick={async t => { await api.tags.link(t.id, 'file', item.id); await load() }}
          onUnpick={async t => { await api.tags.unlinkByTarget(t.id, 'file', item.id); await load() }}
          onCreate={async name => { await api.tags.create(name); await load() }} title="文件标签" />
      </div>
      <Button className="self-start" variant="primary" disabled={item.path_missing === 1} icon={<PlayIcon width={15} height={15} />} onClick={async () => { try { await api.play(item.id) } catch (e: any) { alert(`播放失败：${e.message}`) } }}>播放</Button>
    </div>
  )
}
