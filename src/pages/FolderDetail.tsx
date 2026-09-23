import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { FolderDetail as FolderDetailData, Library, Tag } from '../types'
import { collectionMemberKey, type CollectionOrganization } from '../../shared/collection-organization'
import { api, request } from '../api'
import TagPicker from '../components/TagPicker'
import { posterUrl } from '../lib/poster'
import Button from '../components/ui/Button'
import MediaDomainControl from '../components/MediaDomainControl'
import FolderMoveDialog from '../components/FolderMoveDialog'
import { DetailColumns } from '../components/design/DesktopPresentation'
import { useDialogBehavior } from '../components/ui/dialogBehavior'
import OverlayPresence from '../components/ui/OverlayPresence'
import { ChevronLeftIcon, FileIcon, FolderIcon, InfoIcon, PlayIcon, TagIcon, TrashIcon } from '../components/ui/Icons'
import { createLatestRequestGuard } from '../lib/latestRequest'
import { useLibraryScanRefresh } from '../lib/libraryScan'
import { ModuleErrorBoundary, useModules } from '../modules/registry'
import {
  getFolderRenameHistory,
  openFolderLocation,
  relinkFolder,
  revealFileLocation,
  undoFolderRename,
  updateFolderDisplayName,
  type FolderRenameHistory,
} from '../lib/libraryActions'

const fmt = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

const SOURCE_LABEL: Record<string, string> = {
  bangumi: 'Bangumi',
  anilist: 'AniList',
  tmdb: 'TMDB',
}

function episodeBadge(name: string, index: number): string {
  const episode = name.match(/(?:^|[\s._\-[（(])(?:EP?|E)\s*0*(\d{1,3})(?=$|[\s._\-\]）)])/i)
  if (episode) return `EP ${episode[1].padStart(2, '0')}`
  const special = name.match(/(?:^|[\s._\-[（(])(SP|OVA|OAD)\s*0*(\d{0,2})(?=$|[\s._\-\]）)])/i)
  if (special) return `${special[1].toUpperCase()}${special[2] ? ` ${special[2].padStart(2, '0')}` : ''}`
  return String(index + 1).padStart(2, '0')
}

function pathName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value
}

function renameStatusLabel(status: string): string {
  return ({ applied: '已完成', undone: '已撤销', rolled_back: '已回滚', needs_attention: '待核对', pending: '处理中' } as Record<string, string>)[status] ?? status
}

export function shouldStartFolderDetailLoad(expectedFolderId: number, currentFolderId: number, mounted: boolean): boolean {
  return mounted && expectedFolderId === currentFolderId
}

export interface CollectionRouteContext {
  rootId: number
  entryId: string
  view: 'watch' | 'structure'
}

export interface CollectionNextState {
  position: number
  total: number
  next: null | { entryId: string; title: string; folderId: number | null; status: 'available' | 'missing' | 'unavailable' | 'choose'; reason?: string }
}

export function readCollectionRouteContext(search: URLSearchParams): CollectionRouteContext | null {
  const rootId = Number(search.get('collection'))
  const entryId = search.get('entry')?.trim() ?? ''
  const view = search.get('view')
  return Number.isSafeInteger(rootId) && rootId > 0 && entryId && (view === 'watch' || view === 'structure') ? { rootId, entryId, view } : null
}

export function resolveCollectionNextState(root: FolderDetailData, organization: CollectionOrganization, entryId: string): CollectionNextState {
  const index = organization.watchEntries.findIndex(entry => entry.id === entryId)
  if (index < 0) return { position: 0, total: organization.watchEntries.length, next: { entryId, title: '当前顺序项', folderId: null, status: 'missing', reason: '当前顺序项已失效或不属于这个合集' } }
  const nextEntry = organization.watchEntries[index + 1]
  if (!nextEntry) return { position: index + 1, total: organization.watchEntries.length, next: null }
  const catalog = root.media_catalog_v2
  const item = catalog?.items.find(candidate => collectionMemberKey(candidate.item_key) === nextEntry.targetKey)
  if (!item) return { position: index + 1, total: organization.watchEntries.length, next: { entryId: nextEntry.id, title: nextEntry.targetKey.replace(/^item:/, ''), folderId: null, status: 'missing', reason: '引用的作品已无法解析' } }
  const folderIds = [...new Set((catalog?.mappings ?? []).filter(mapping => mapping.media_item_id === item.id).map(mapping => mapping.folder_id))]
  const title = item.title_zh?.trim() || item.title
  if (folderIds.length === 0) return { position: index + 1, total: organization.watchEntries.length, next: { entryId: nextEntry.id, title, folderId: null, status: 'unavailable', reason: '当前没有可打开的媒体目录' } }
  if (folderIds.length > 1) return { position: index + 1, total: organization.watchEntries.length, next: { entryId: nextEntry.id, title, folderId: null, status: 'choose', reason: '存在多个关联目录，请返回合集选择' } }
  return { position: index + 1, total: organization.watchEntries.length, next: { entryId: nextEntry.id, title, folderId: folderIds[0], status: 'available' } }
}

export default function FolderDetail({ folderId }: { folderId: number }) {
  const { modules } = useModules()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [item, setItem] = useState<FolderDetailData | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [libraries, setLibraries] = useState<Library[]>([])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [synopsisExpanded, setSynopsisExpanded] = useState(false)
  const [notice, setNotice] = useState('')
  const [mediaDomainBusy, setMediaDomainBusy] = useState(false)
  const [scanNotice, setScanNotice] = useState('')
  const [error, setError] = useState('')
  const [coreViewOpen, setCoreViewOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renameHistory, setRenameHistory] = useState<FolderRenameHistory>({ items: [] })
  const [renameHistoryBusy, setRenameHistoryBusy] = useState(false)
  const [renameHistoryError, setRenameHistoryError] = useState('')
  const [undoBusy, setUndoBusy] = useState<string | null>(null)
  const [locationBusy, setLocationBusy] = useState(false)
  const [revealingFileId, setRevealingFileId] = useState<number | null>(null)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [relinkDraft, setRelinkDraft] = useState('')
  const [relinkBusy, setRelinkBusy] = useState(false)
  const [relinkError, setRelinkError] = useState('')
  const [folderOpsOpen, setFolderOpsOpen] = useState(false)
  const [folderOpName, setFolderOpName] = useState('')
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [folderOpBusy, setFolderOpBusy] = useState<'rename' | 'delete' | null>(null)
  const [folderOpError, setFolderOpError] = useState('')
  const [collectionNextState, setCollectionNextState] = useState<CollectionNextState | null>(null)
  const [collectionContextError, setCollectionContextError] = useState('')
  const tagsDialogRef = useRef<HTMLDivElement>(null)
  const tagsCloseRef = useRef<HTMLButtonElement>(null)
  const folderOpsDialogRef = useRef<HTMLDivElement>(null)
  const folderOpsNameRef = useRef<HTMLInputElement>(null)
  const currentFolderIdRef = useRef(folderId)
  const loadRequestGuardRef = useRef(createLatestRequestGuard<number>())
  const folderDetailMountedRef = useRef(true)
  const displayNameSavingRef = useRef(false)
  currentFolderIdRef.current = folderId
  const collectionContext = useMemo(() => readCollectionRouteContext(searchParams), [searchParams])
  const collectionReturnUrl = collectionContext ? `/folder/${collectionContext.rootId}?collectionView=${collectionContext.view}` : null
  const withCollectionContext = (path: string, entryId = collectionContext?.entryId) => {
    if (!collectionContext || !entryId) return path
    const separator = path.includes('?') ? '&' : '?'
    const query = new URLSearchParams({ collection: String(collectionContext.rootId), entry: entryId, view: collectionContext.view })
    return `${path}${separator}${query.toString()}`
  }
  useDialogBehavior({
    open: folderOpsOpen,
    dialogRef: folderOpsDialogRef,
    initialFocusRef: folderOpsNameRef,
    onClose: () => setFolderOpsOpen(false),
    closeDisabled: folderOpBusy !== null || undoBusy !== null,
  })
  useDialogBehavior({
    open: tagsOpen,
    dialogRef: tagsDialogRef,
    initialFocusRef: tagsCloseRef,
    onClose: () => setTagsOpen(false),
  })

  useEffect(() => {
    folderDetailMountedRef.current = true
    return () => {
      folderDetailMountedRef.current = false
      loadRequestGuardRef.current.invalidate()
    }
  }, [])

  const load = useCallback(async (background = false) => {
    if (!shouldStartFolderDetailLoad(folderId, currentFolderIdRef.current, folderDetailMountedRef.current)) return
    const request = loadRequestGuardRef.current.begin(folderId)
    setError('')
    try {
      const [folder, nextTags] = await Promise.all([api.folders.get(folderId), api.tags.list()])
      if (!loadRequestGuardRef.current.isCurrent(request, currentFolderIdRef.current)) return
      setItem(folder)
      setTags(nextTags)
      if (!background) setSynopsisExpanded(false)
      void api.libraries.list()
        .then(nextLibraries => {
          if (loadRequestGuardRef.current.isCurrent(request, currentFolderIdRef.current)) setLibraries(nextLibraries)
        })
        .catch(() => {
          if (loadRequestGuardRef.current.isCurrent(request, currentFolderIdRef.current)) setLibraries([])
        })
    } catch (caught) {
      if (loadRequestGuardRef.current.isCurrent(request, currentFolderIdRef.current)) {
        if (background) setNotice(`媒体库刷新失败：${caught instanceof Error ? caught.message : String(caught)}`)
        else setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [folderId])
  useLibraryScanRefresh(() => { void load(true) }, setScanNotice, item ? [item.library_id] : undefined, `folder:${folderId}`)

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let current = true
    setCollectionNextState(null)
    setCollectionContextError('')
    if (!collectionContext) return () => { current = false }
    Promise.all([
      api.folders.get(collectionContext.rootId),
      request<{ organization: CollectionOrganization; revision: number }>(`/api/folders/${collectionContext.rootId}/collection-organization`, { cache: 'no-store' }),
    ]).then(async ([root, snapshot]) => {
      let nextState = resolveCollectionNextState(root, snapshot.organization, collectionContext.entryId)
      const next = nextState.next
      if (next?.status === 'available' && next.folderId !== null) {
        try {
          const nextFolder = await api.folders.get(next.folderId)
          if (nextFolder.path_missing === 1) nextState = { ...nextState, next: { ...next, folderId: null, status: 'unavailable', reason: '媒体目录已缺失' } }
        } catch (caught) {
          nextState = { ...nextState, next: { ...next, folderId: null, status: 'unavailable', reason: caught instanceof Error ? `媒体目录不可用：${caught.message}` : '媒体目录不可用' } }
        }
      }
      if (current) setCollectionNextState(nextState)
    }).catch(caught => {
      if (current) setCollectionContextError(`合集观看顺序读取失败：${caught instanceof Error ? caught.message : String(caught)}`)
    })
    return () => { current = false }
  }, [collectionContext?.entryId, collectionContext?.rootId, collectionContext?.view])
  useEffect(() => {
    setTagsOpen(false)
    setFolderOpsOpen(false)
    setRenaming(false)
    setRelinkOpen(false)
    setRelinkDraft('')
    setRelinkError('')
    setCoreViewOpen(false)
  }, [folderId])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2800)
    return () => window.clearTimeout(timer)
  }, [notice])

  const folderPanels = useMemo(() => modules.flatMap(loaded => (
    loaded.contribution.folderPanels ?? []
  ).map(panel => ({ ...panel, moduleId: loaded.id }))), [modules])

  const matchingFolderView = useMemo(() => {
    if (!item || item.id !== folderId) return null
    for (const loaded of modules) {
      for (const view of loaded.contribution.folderViews ?? []) {
        try {
          if (view.matches(item)) return { ...view, moduleId: loaded.id }
        } catch (caught) {
          console.error(`Module ${loaded.id} folder view matcher failed`, caught)
        }
      }
    }
    return null
  }, [folderId, item, modules])

  const beginDisplayNameEdit = () => {
    if (!item || displayNameSavingRef.current) return
    setNameDraft(item.name)
    setRenaming(true)
  }

  const saveDisplayName = async () => {
    if (!item || displayNameSavingRef.current) return
    const nextName = nameDraft.trim()
    if (!nextName) return alert('显示名不能为空')
    if (nextName === item.name) return setRenaming(false)
    displayNameSavingRef.current = true
    try {
      await updateFolderDisplayName(item.id, nextName)
      setRenaming(false)
      setNotice('显示名已保存')
      await load()
    } catch (caught) {
      alert(`显示名保存失败：${caught instanceof Error ? caught.message : String(caught)}`)
    } finally {
      displayNameSavingRef.current = false
    }
  }

  const refreshRenameHistory = async (id: number) => {
    setRenameHistoryBusy(true)
    setRenameHistoryError('')
    try { setRenameHistory(await getFolderRenameHistory(id)) }
    catch (caught) { setRenameHistoryError(caught instanceof Error ? caught.message : '无法加载重命名历史') }
    finally { setRenameHistoryBusy(false) }
  }

  const openFolderOperations = () => {
    if (!item) return
    const diskName = item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.name
    setFolderOpName(diskName)
    setDeleteConfirmation('')
    setFolderOpError('')
    setFolderOpsOpen(true)
    void refreshRenameHistory(item.id)
  }

  const runUndoRename = async (operationId: string) => {
    if (!item || undoBusy) return
    setUndoBusy(operationId)
    setFolderOpError('')
    try {
      await undoFolderRename(item.id, operationId, item.path)
      setNotice('磁盘文件夹名称已撤销')
      await load()
      await refreshRenameHistory(item.id)
    } catch (caught) {
      setFolderOpError(caught instanceof Error ? caught.message : '撤销重命名失败')
    } finally { setUndoBusy(null) }
  }

  const runOpenFolder = async () => {
    if (!item || locationBusy) return
    setLocationBusy(true)
    try { await openFolderLocation(item.id) }
    catch (caught) { alert(`打开文件夹失败：${caught instanceof Error ? caught.message : String(caught)}`) }
    finally { setLocationBusy(false) }
  }

  const runRevealFile = async (fileId: number) => {
    if (revealingFileId !== null) return
    setRevealingFileId(fileId)
    try { await revealFileLocation(fileId) }
    catch (caught) { alert(`定位文件失败：${caught instanceof Error ? caught.message : String(caught)}`) }
    finally { setRevealingFileId(null) }
  }

  const runRelink = async () => {
    if (!item || relinkBusy) return
    const path = relinkDraft.trim()
    if (!path) return setRelinkError('请输入新的本机目录路径')
    setRelinkBusy(true)
    setRelinkError('')
    try {
      await relinkFolder(item.id, item.path, path)
      setRelinkOpen(false)
      setRelinkDraft('')
      setNotice('文件夹已重新关联')
      await load()
    } catch (caught) {
      setRelinkError(caught instanceof Error ? caught.message : '重新关联失败')
    } finally { setRelinkBusy(false) }
  }

  const runFolderRename = async () => {
    if (!item) return
    const nextName = folderOpName.trim()
    if (!nextName) return setFolderOpError('请输入新的磁盘文件夹名称')
    setFolderOpBusy('rename')
    setFolderOpError('')
    try {
      await api.folders.rename(item.id, nextName, item.path)
      setFolderOpsOpen(false)
      setNotice('磁盘文件夹已重命名，子目录与文件路径已同步')
      await load()
    } catch (caught) {
      setFolderOpError(caught instanceof Error ? caught.message : '重命名失败')
    } finally {
      setFolderOpBusy(null)
    }
  }

  const runFolderDelete = async () => {
    if (!item || deleteConfirmation !== '删除') return
    setFolderOpBusy('delete')
    setFolderOpError('')
    try {
      const sourceLibraryId = item.library_id
      await api.folders.remove(item.id, item.path)
      setFolderOpsOpen(false)
      navigate(`/library/${sourceLibraryId}`, { replace: true })
    } catch (caught) {
      setFolderOpError(caught instanceof Error ? caught.message : '删除失败')
    } finally {
      setFolderOpBusy(null)
    }
  }

  if (error) {
    return <div className="p-6 text-text-secondary"><p>加载失败：{error}</p><button className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm text-white" onClick={() => { void load() }}>重试</button></div>
  }
  if (!item || item.id !== folderId) return <div className="p-6 text-text-secondary">加载中…</div>

  const active = item
  const pathMissing = active.path_missing === 1
  const moduleProps = {
    folder: active,
    onRefresh: load,
    onUpdate: (next: FolderDetailData) => setItem(current => current?.id === next.id ? next : current),
    onNotice: setNotice,
    onOpenCoreView: () => setCoreViewOpen(true),
  }
  const noticeToast = notice && (
    <div role="status" className="ui-panel-strong fixed right-5 top-5 z-[60] flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-surface/95 px-4 py-3 text-sm text-emerald-200 shadow-[0_18px_50px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-[opacity,transform] duration-200 [@starting-style]:translate-y-[-6px] [@starting-style]:opacity-0">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/15 text-xs">✓</span>
      {notice}
    </div>
  )

  if (matchingFolderView && !coreViewOpen) {
    if (!pathMissing) {
      const FolderView = matchingFolderView.component
      return <>{noticeToast}{scanNotice && <p role="status" className="px-5 pt-2 text-xs text-text-secondary">{scanNotice}</p>}<ModuleErrorBoundary moduleId={matchingFolderView.moduleId}><FolderView {...moduleProps} /></ModuleErrorBoundary></>
    }
  }

  const playFile = pathMissing ? undefined : active.files.find(file => !file.path_missing && /\.(mkv|mp4|avi|m4v|mov|wmv|flv|ts|webm)$/i.test(file.name))
  const pickedIds = new Set(active.tags.map(tag => tag.id))
  const poster = posterUrl(active)
  const sidebarPanels = folderPanels.filter(panel => panel.slot === 'sidebar')
  const contentPanels = folderPanels.filter(panel => panel.slot === 'content')
  const onPick = async (tag: Tag) => { await api.tags.link(tag.id, 'folder', active.id); await load() }
  const onUnpick = async (tag: Tag) => { await api.tags.unlinkByTarget(tag.id, 'folder', active.id); await load() }
  const onCreate = async (name: string) => { await api.tags.create(name); await load() }

  return (
    <div className="detail-page page-shell overflow-y-auto lg:overflow-hidden">
      {matchingFolderView && coreViewOpen && <Button className="self-start" size="sm" variant="ghost" onClick={() => setCoreViewOpen(false)}>← {matchingFolderView.coreViewReturnLabel ?? '返回模块视图'}</Button>}
      {noticeToast}
      {scanNotice && <p role="status" className="text-xs text-text-secondary">{scanNotice}</p>}
      <OverlayPresence open={folderOpsOpen}>
        {folderOpsOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 transition-opacity duration-200 [@starting-style]:opacity-0" onClick={() => { if (!folderOpBusy && !undoBusy) setFolderOpsOpen(false) }}>
          <div ref={folderOpsDialogRef} role="dialog" aria-modal="true" aria-labelledby="folder-operations-title" tabIndex={-1} className="clean-dialog ui-panel-strong w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#0d121b]/98 shadow-[0_28px_90px_rgba(0,0,0,0.58)] backdrop-blur-2xl transition-[opacity,transform] duration-200 ease-[var(--ease-out)] [@starting-style]:scale-[0.97] [@starting-style]:opacity-0" onClick={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
              <div className="min-w-0"><div className="section-kicker">DISK OPERATIONS</div><h2 id="folder-operations-title" className="mt-1 font-semibold text-white">文件夹操作</h2><p className="mt-1 truncate text-xs text-text-secondary/70" title={item.path}>{item.path}</p></div>
              <button type="button" disabled={Boolean(folderOpBusy || undoBusy)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl text-text-secondary transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40" aria-label="关闭文件夹操作" onClick={() => setFolderOpsOpen(false)}>×</button>
            </div>
            <div className="max-h-[min(72vh,680px)] space-y-4 overflow-y-auto p-5">
              <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.07] px-3 py-2.5 text-xs leading-5 text-amber-100/85">下列操作会直接修改磁盘。执行期间请不要在资源管理器或下载工具中同时移动这个目录。</div>
              {folderOpError && <div role="alert" className="rounded-xl border border-red-300/15 bg-red-400/[0.08] px-3 py-2.5 text-sm text-red-200">{folderOpError}</div>}
              <section className="clean-dialog-section rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                <h3 className="text-sm font-semibold text-white">重命名磁盘文件夹</h3><p className="mt-1 text-xs text-text-secondary/70">会同步更新全部子目录和文件路径，原有资料与标签保持不变。</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="folder-operation-name">新的文件夹名称</label><input ref={folderOpsNameRef} id="folder-operation-name" value={folderOpName} onChange={event => setFolderOpName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !folderOpBusy) void runFolderRename() }} disabled={Boolean(folderOpBusy)} className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none transition focus:border-accent disabled:opacity-50" /><Button variant="secondary" disabled={Boolean(folderOpBusy) || !folderOpName.trim()} onClick={() => { void runFolderRename() }}>{folderOpBusy === 'rename' ? '重命名中…' : '重命名'}</Button></div>
              </section>
              <section className="clean-dialog-section rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">重命名历史</h3><p className="mt-1 text-xs text-text-secondary/70">仅可撤销仍与当前磁盘路径一致的操作。</p></div><Button size="sm" variant="ghost" disabled={renameHistoryBusy || Boolean(undoBusy)} onClick={() => { void refreshRenameHistory(item.id) }}>{renameHistoryBusy ? '加载中…' : '刷新'}</Button></div>
                {renameHistoryError && <p role="alert" className="mt-3 text-xs text-red-300">{renameHistoryError}</p>}
                {renameHistory.blocked && <p className="mt-3 rounded-lg bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100/80">{renameHistory.blocked}</p>}
                <div className="mt-3 divide-y divide-white/[0.06]">
                  {renameHistory.items.map(history => <div key={history.operationId} className="flex items-center gap-3 py-2.5 text-xs"><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1.5"><span className="truncate text-text-primary" title={history.fromPath}>{pathName(history.fromPath)}</span><span className="text-text-secondary/50">→</span><span className="truncate text-text-primary" title={history.toPath}>{pathName(history.toPath)}</span></div><div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-text-secondary/65"><time dateTime={history.createdAt}>{new Date(history.createdAt).toLocaleString()}</time><span>{renameStatusLabel(history.status)}</span>{history.reason && <span>{history.reason}</span>}</div></div>{history.canUndo && <Button size="sm" variant="ghost" disabled={Boolean(undoBusy || folderOpBusy)} onClick={() => { void runUndoRename(history.operationId) }}>{undoBusy === history.operationId ? '撤销中…' : '撤销上次磁盘重命名'}</Button>}</div>)}
                  {!renameHistoryBusy && renameHistory.items.length === 0 && !renameHistoryError && <p className="py-2 text-xs text-text-secondary/65">暂无磁盘重命名记录。</p>}
                </div>
              </section>
              <section className="clean-dialog-section rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                <h3 className="text-sm font-semibold text-white">移动到媒体库</h3><p className="mt-1 text-xs text-text-secondary/70">支持同盘与跨盘，选择目标库或已有子目录；同名不覆盖。</p>
                <Button className="mt-3" variant="secondary" disabled={Boolean(folderOpBusy)} onClick={() => { setFolderOpsOpen(false); setMoveOpen(true) }}>选择目标并预览…</Button>
              </section>
              <section className="rounded-xl border border-red-300/15 bg-red-400/[0.045] p-4">
                <h3 className="text-sm font-semibold text-red-200">永久删除磁盘文件夹</h3><p className="mt-1 text-xs leading-5 text-red-100/65">将递归删除该目录中的全部文件，并移除 AnimeShelf 内的目录、文件和标签关联。此操作无法撤销。</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="folder-operation-delete-confirmation">输入删除以确认</label><input id="folder-operation-delete-confirmation" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} disabled={Boolean(folderOpBusy)} placeholder="输入“删除”以确认" className="min-w-0 flex-1 rounded-lg border border-red-300/20 bg-bg px-3 py-2 text-sm outline-none transition placeholder:text-text-secondary/45 focus:border-red-300/45 disabled:opacity-50" /><Button variant="danger" icon={<TrashIcon width={14} height={14} />} disabled={Boolean(folderOpBusy) || deleteConfirmation !== '删除'} onClick={() => { void runFolderDelete() }}>{folderOpBusy === 'delete' ? '删除中…' : '永久删除'}</Button></div>
              </section>
            </div>
          </div>
        </div>}
      </OverlayPresence>
      {moveOpen && <FolderMoveDialog open items={[{ id: active.id, expectedPath: active.path }]} libraries={libraries} onClose={() => setMoveOpen(false)} onResult={job => {
        if (job.items.some(row => row.id === folderId && ['completed', 'cleanup_pending'].includes(row.phase))) { setNotice('目标位置已更新，请查看迁移任务的清理结果'); void load() }
      }} />}
      <OverlayPresence open={tagsOpen}>
        {tagsOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 transition-opacity duration-200 [@starting-style]:opacity-0" onClick={() => setTagsOpen(false)}>
          <div ref={tagsDialogRef} role="dialog" aria-modal="true" aria-label="管理标签" tabIndex={-1} className="clean-dialog ui-panel-strong w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0d121b]/98 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition-[opacity,transform] duration-200 ease-[var(--ease-out)] [@starting-style]:scale-[0.97] [@starting-style]:opacity-0" onClick={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4"><div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent"><TagIcon width={17} height={17} /></span><div className="min-w-0"><h2 className="font-semibold text-white">管理标签</h2><p className="mt-0.5 truncate text-xs text-text-secondary/65" title={active.name}>{active.name}</p></div></div><button ref={tagsCloseRef} type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl text-text-secondary transition hover:bg-white/[0.06] hover:text-white" aria-label="关闭标签管理" onClick={() => setTagsOpen(false)}>×</button></div>
            <div className="max-h-[min(60vh,520px)] overflow-y-auto px-5 py-4"><p className="mb-3 text-xs text-text-secondary/65">选择标签；从上级目录继承的标签也会显示。</p><TagPicker tags={tags} picked={pickedIds} onPick={onPick} onUnpick={onUnpick} onCreate={onCreate} title="" /></div>
          </div>
        </div>}
      </OverlayPresence>

      <div className="page-breadcrumb ui-panel flex shrink-0 items-center gap-2 text-xs text-text-secondary">
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 transition hover:bg-white/[0.055] hover:text-white" onClick={() => collectionReturnUrl ? navigate(collectionReturnUrl) : navigate(-1)}><ChevronLeftIcon width={15} height={15} />{collectionReturnUrl ? '返回合集' : '返回'}</button>
        <span className="text-white/15">/</span><button type="button" className="truncate transition hover:text-white" onClick={() => navigate(`/library/${item.library_id}`)}>媒体库</button><span className="text-white/15">/</span><span className="min-w-0 truncate text-text-secondary/70">{item.name}</span>
      </div>

      {collectionContext && <div className="ui-panel flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-accent/15 px-3 py-2 text-xs">
        <button type="button" className="font-medium text-accent hover:text-white" onClick={() => navigate(collectionReturnUrl!)}>合集观看顺序</button>
        {collectionNextState && <span className="text-text-secondary">第 {collectionNextState.position || '—'} / {collectionNextState.total} 项</span>}
        <span className="min-w-0 flex-1" />
        {collectionContextError ? <span className="text-red-200">{collectionContextError}</span> : collectionNextState?.next ? <>
          <span className={collectionNextState.next.status === 'available' ? 'text-text-secondary' : 'text-amber-200'}>下一部：{collectionNextState.next.title}{collectionNextState.next.reason ? ` · ${collectionNextState.next.reason}` : ''}</span>
          {collectionNextState.next.status === 'available' && collectionNextState.next.folderId !== null ? <Button size="sm" onClick={() => navigate(withCollectionContext(`/folder/${collectionNextState.next!.folderId}`, collectionNextState.next!.entryId))}>打开下一部</Button> : <Button size="sm" variant="ghost" onClick={() => navigate(collectionReturnUrl!)}>返回合集处理</Button>}
        </> : collectionNextState ? <span className="text-text-secondary">已到观看顺序末尾</span> : <span className="text-text-secondary">正在读取下一项…</span>}
      </div>}

      {pathMissing && <section role="alert" className="ui-panel shrink-0 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3">
        <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-amber-100">磁盘位置已缺失</p><p className="mt-1 truncate text-xs text-amber-100/65" title={active.path}>{active.path}</p></div><Button size="sm" variant="secondary" onClick={() => { setRelinkDraft(''); setRelinkError(''); setRelinkOpen(true) }}>重新关联</Button></div>
        {relinkOpen && <div className="mt-3 border-t border-amber-200/10 pt-3"><label className="text-xs text-amber-100/80" htmlFor="folder-relink-path">新的本机目录路径</label><div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="folder-relink-path" autoFocus value={relinkDraft} disabled={relinkBusy} onChange={event => setRelinkDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runRelink(); if (event.key === 'Escape' && !relinkBusy) setRelinkOpen(false) }} placeholder="D:\\Media\\Anime\\作品目录" className="min-w-0 flex-1 rounded-lg border border-amber-200/20 bg-bg px-3 py-2 text-sm outline-none focus:border-amber-200/45 disabled:opacity-50" /><Button size="sm" disabled={relinkBusy || !relinkDraft.trim()} onClick={() => { void runRelink() }}>{relinkBusy ? '关联中…' : '确认关联'}</Button><Button size="sm" variant="ghost" disabled={relinkBusy} onClick={() => setRelinkOpen(false)}>取消</Button></div>{relinkError && <p role="alert" className="mt-2 text-xs text-red-300">{relinkError}</p>}</div>}
      </section>}

      <DetailColumns className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="detail-cover-column min-h-0 space-y-3 pr-1 lg:overflow-y-auto">
          <div className="detail-cover relative mx-auto w-full max-w-[320px] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-[0_22px_52px_rgba(0,0,0,0.28)] lg:mx-0">
            {poster ? <img src={poster} alt={`${active.name} 海报`} className="aspect-[2/3] w-full object-cover object-top" /> : <div className="flex aspect-[2/3] w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgb(var(--ui-accent)/0.22),transparent_42%),linear-gradient(145deg,#202838,#111722)] text-5xl text-white/20">🎌</div>}
            {active.source && <span className="media-overlay absolute left-3 top-3 rounded-full border border-white/10 bg-black/55 px-2 py-1 text-[10px] font-medium tracking-wide text-white/85 backdrop-blur-md">{SOURCE_LABEL[active.source] ?? active.source}</span>}
          </div>
          {sidebarPanels.map(({ moduleId, id, component: Panel }) => <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId}><Panel {...moduleProps} /></ModuleErrorBoundary>)}
        </aside>

        <div className="detail-information min-h-0 min-w-0 space-y-4 pr-1 lg:overflow-y-auto">
          <section className="page-header ui-panel relative overflow-hidden rounded-2xl border border-white/10 bg-[#111722]/82 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.16)] backdrop-blur-xl">
            <div aria-hidden className="detail-decoration pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
            <div className="relative flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 flex-1"><div className="section-kicker">{item.is_series === 1 ? 'SERIES DETAIL' : 'FOLDER DETAIL'}</div>{renaming ? <div className="mt-2 flex max-w-3xl items-center gap-2"><input autoFocus value={nameDraft} onChange={event => setNameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveDisplayName(); if (event.key === 'Escape') setRenaming(false) }} onBlur={() => { void saveDisplayName() }} className="min-w-0 flex-1 rounded-lg border border-accent bg-bg px-3 py-2 text-2xl font-bold outline-none" placeholder="显示名" /><Button size="sm" disabled={!nameDraft.trim()} onMouseDown={event => event.preventDefault()} onClick={() => { void saveDisplayName() }}>保存</Button><Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => setRenaming(false)}>取消</Button></div> : <h1 className="mt-1 text-2xl font-bold leading-tight text-white 2xl:text-3xl" onDoubleClick={beginDisplayNameEdit} title="双击编辑显示名">{item.name}</h1>}<p className="mt-2 truncate text-[11px] text-text-secondary/60" title={item.path}>{item.path}</p></div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">{playFile && <Button variant="primary" icon={<PlayIcon width={15} height={15} />} onClick={async () => { try { await api.play(playFile.id) } catch (caught) { alert(`播放失败：${caught instanceof Error ? caught.message : String(caught)}`) } }}>从头播放</Button>}<Button variant="ghost" onClick={beginDisplayNameEdit}>编辑显示名</Button><Button variant="ghost" icon={<FolderIcon width={15} height={15} />} disabled={pathMissing || locationBusy} onClick={() => { void runOpenFolder() }}>{locationBusy ? '正在打开…' : '打开文件夹'}</Button><Button variant="ghost" icon={<FolderIcon width={15} height={15} />} onClick={openFolderOperations}>文件夹操作</Button></div>
            </div>
            <div className="detail-facts relative mt-4 flex flex-wrap items-center gap-2 text-xs">{typeof active.rating === 'number' && active.rating > 0 && <span className="rounded-lg border border-yellow-300/15 bg-yellow-300/10 px-2.5 py-1.5 font-semibold text-yellow-300 tabular-nums">★ {active.rating.toFixed(1)}</span>}{active.year ? <span className="rounded-lg border border-white/[0.07] bg-white/[0.045] px-2.5 py-1.5 text-text-secondary tabular-nums">{active.year}</span> : null}{active.episodes ? <span className="rounded-lg border border-white/[0.07] bg-white/[0.045] px-2.5 py-1.5 text-text-secondary">全 {active.episodes} 集</span> : null}<span className="rounded-lg border border-white/[0.07] bg-white/[0.045] px-2.5 py-1.5 text-text-secondary">{fmt(active.size)}</span><span className="rounded-lg border border-white/[0.07] bg-white/[0.045] px-2.5 py-1.5 text-text-secondary">{active.file_count} 个文件</span><button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.045] text-text-secondary transition hover:border-accent/30 hover:bg-accent/10 hover:text-accent" aria-label="管理标签" title="管理标签" onClick={() => setTagsOpen(true)}><TagIcon width={15} height={15} /></button></div>
          </section>

          <MediaDomainControl value={item} disabled={mediaDomainBusy} onChange={async override => {
            if (mediaDomainBusy) return
            const requestedId = item.id
            setMediaDomainBusy(true)
            try {
              const updated = await api.folders.setMediaDomain(requestedId, override)
              if (currentFolderIdRef.current !== requestedId || !folderDetailMountedRef.current) return
              setItem(current => current?.id === requestedId ? { ...current, ...updated } : current)
              setNotice(override === null ? '已恢复自动判断' : '媒体类型已保存，仅作用于当前条目')
              await load(true)
            } catch (cause) {
              if (currentFolderIdRef.current === requestedId && folderDetailMountedRef.current) setNotice(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
            } finally { if (folderDetailMountedRef.current) setMediaDomainBusy(false) }
          }} />

          <section className="ui-panel rounded-2xl border border-white/[0.08] bg-[#111722]/82 p-4 backdrop-blur-lg">
            <div className="mb-2 flex items-center justify-between gap-3"><div><div className="section-kicker">SYNOPSIS</div><h2 className="mt-1 font-semibold text-white">剧情简介</h2></div>{active.synopsis && active.synopsis.length > 180 && <button type="button" className="shrink-0 text-xs text-accent transition hover:text-accent" onClick={() => setSynopsisExpanded(value => !value)}>{synopsisExpanded ? '收起' : '展开全文'}</button>}</div>
            <p data-expanded={synopsisExpanded} className={`detail-synopsis ${synopsisExpanded ? 'max-h-[320px] overflow-y-auto pr-2 no-scrollbar' : 'line-clamp-4'} whitespace-pre-line text-sm leading-6 text-text-secondary`}>{active.synopsis?.trim() || '暂无简介。'}</p>
          </section>

          {contentPanels.map(({ moduleId, id, component: Panel }) => <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId}><Panel {...moduleProps} /></ModuleErrorBoundary>)}

          {active.children.length > 0 && (
            <section className="ui-panel overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111722]/82 backdrop-blur-lg">
              <div className="flex items-end justify-between gap-3 px-4 pb-3 pt-4"><div><div className="section-kicker">DIRECTORIES</div><h2 className="mt-1 font-semibold text-white">子目录</h2><p className="mt-0.5 text-xs text-text-secondary">打开目录查看其中的文件与下级目录</p></div><span className="rounded-full border border-white/[0.07] bg-white/[0.045] px-2.5 py-1 text-xs text-text-secondary tabular-nums">{active.children.length}</span></div>
              <div className="divide-y divide-white/[0.055] border-t border-white/[0.06]">{active.children.map(child => <button key={child.id} type="button" className="grid w-full grid-cols-[32px_minmax(0,1fr)_76px_80px] items-center gap-2 px-4 py-3 text-left transition hover:bg-white/[0.045]" onClick={() => navigate(withCollectionContext(`/folder/${child.id}`))}><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.045] text-accent"><FolderIcon width={15} height={15} /></span><span className="min-w-0"><span className="block truncate text-sm text-text-primary" title={child.name}>{child.name}</span><span className="mt-0.5 block truncate text-[10px] text-text-secondary/55" title={child.path}>{child.path}</span></span><span className="text-right text-xs text-text-secondary tabular-nums">{fmt(child.size)}</span><span className="text-right text-xs text-text-secondary tabular-nums">{child.file_count} 个文件</span></button>)}</div>
            </section>
          )}

          {active.files.length > 0 && (
            <section className="ui-panel overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111722]/82 backdrop-blur-lg">
              <div className="flex items-end justify-between gap-3 px-4 pb-3 pt-4"><div><div className="section-kicker">MEDIA FILES</div><h2 className="mt-1 font-semibold text-white">文件列表</h2><p className="mt-0.5 text-xs text-text-secondary">单击一行即可播放</p></div><span className="rounded-full border border-white/[0.07] bg-white/[0.045] px-2.5 py-1 text-xs text-text-secondary tabular-nums">{active.files.length}</span></div>
              <div className="grid grid-cols-[52px_minmax(0,1fr)_76px_68px] border-y border-white/[0.06] bg-black/15 px-3 py-2 text-[10px] uppercase tracking-wider text-text-secondary/55 2xl:grid-cols-[64px_minmax(0,1fr)_80px_120px_68px]"><span>集数</span><span>文件名</span><span className="text-right">大小</span><span className="hidden pl-4 2xl:block">标签</span><span /></div>
              <div className="max-h-[min(48vh,560px)] divide-y divide-white/[0.055] overflow-y-auto overscroll-contain">
                {active.files.map((file, index) => {
                  const fileMissing = pathMissing || file.path_missing === 1
                  const play = fileMissing ? undefined : async () => {
                    try { await api.play(file.id) }
                    catch (caught) { alert(`播放失败：${caught instanceof Error ? caught.message : String(caught)}`) }
                  }
                  const playOnKeyDown = fileMissing ? undefined : async (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    try { await api.play(file.id) }
                    catch (caught) { alert(`播放失败：${caught instanceof Error ? caught.message : String(caught)}`) }
                  }
                  return (
                    <div
                      key={file.id}
                      role={fileMissing ? undefined : 'button'}
                      tabIndex={fileMissing ? undefined : 0}
                      className={`group/file grid grid-cols-[52px_minmax(0,1fr)_76px_68px] items-center px-3 py-2.5 outline-none transition-colors 2xl:grid-cols-[64px_minmax(0,1fr)_80px_120px_68px] ${fileMissing ? 'bg-amber-300/[0.035]' : 'cursor-pointer hover:bg-white/[0.045] focus-visible:bg-white/[0.055]'}`}
                      onClick={play}
                      onKeyDown={playOnKeyDown}
                      title={fileMissing ? '文件缺失，无法播放' : '单击播放'}>
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-accent/90 tabular-nums"><FileIcon width={13} height={13} />{episodeBadge(file.name, index)}</span>
                      <span className="flex min-w-0 items-center gap-2 pr-3">
                        <span className="min-w-0 truncate text-sm text-text-primary" title={file.name}>{file.name}</span>
                        {fileMissing && <span className="shrink-0 rounded border border-amber-300/30 bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-100" title="文件路径已缺失">缺失</span>}
                      </span>
                      <span className="text-right text-xs text-text-secondary tabular-nums">{file.size ? fmt(file.size) : '—'}</span>
                      <span className="hidden truncate pl-4 text-xs text-text-secondary 2xl:block">{file.tags.map(tag => tag.name).join(' · ') || '—'}</span>
                      <span className="flex items-center justify-end gap-1">
                        <button type="button" disabled={fileMissing || revealingFileId !== null} className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40" title={fileMissing ? '文件已缺失，无法打开所在位置' : '打开所在位置'} aria-label={fileMissing ? `${file.name} 的文件位置不可用` : `在文件资源管理器中显示 ${file.name}`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void runRevealFile(file.id) }}><FolderIcon width={14} height={14} /></button>
                        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary/55 transition hover:bg-white/[0.07] hover:text-white" title="文件详情与标签" aria-label={`打开 ${file.name} 的文件详情`} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate(withCollectionContext(`/file/${file.id}`)) }}><InfoIcon width={15} height={15} /></button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </DetailColumns>
    </div>
  )
}
