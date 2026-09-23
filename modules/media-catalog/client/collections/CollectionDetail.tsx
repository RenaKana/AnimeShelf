import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { removeCollectionMembers, type CollectionOrganization } from '../../../../shared/collection-organization'
import type { CollectionPresentation, FolderDetail, MediaCatalogCandidate } from '../../../../src/types'
import { api } from '../api'
import { buildCollectionNavigation, naturalCompare, type CollectionGroup, type CollectionRow, type CollectionWork } from '../collectionNavigation'
import {
  acknowledgeWatchEntry,
  collectionFolderUrl,
  confirmWatchOrder,
  filterCollectionTargets,
  flattenCollectionWorks,
  moveStructureGroup,
  moveStructureMember,
  moveWatchEntry,
  resolveCollectionViews,
  resolvedTargetTitle,
  setStructureMembership,
  type ResolvedCollectionGroup,
  type ResolvedCollectionTarget,
} from '../collectionOrganization'
import { posterUrl } from '../../../../src/lib/poster'
import { buildCollectionArtwork } from '../collectionArtwork'
import CollectionWorkList, { CollectionArtwork, CollectionWorkItem } from './CollectionWorkList'
import CollectionEditor, { type CollectionSave } from './CollectionEditor'
import CollectionGroupEditor from './CollectionGroupEditor'
import CollectionDialog from './CollectionDialog'
import CollectionClassificationForm from './CollectionClassificationForm'
import CollectionResetDialog from './CollectionResetDialog'
import Button from '../../../../src/components/ui/Button'
import { SearchIcon } from '../../../../src/components/ui/Icons'
import { ChevronLeftIcon, FolderIcon } from '../../../../src/components/ui/Icons'
import { openFolderLocation, updateFolderDisplayName } from '../../../../src/lib/libraryActions'
import { readBooleanPref, readNumberPref, readStringPref, writePref } from '../../../../src/lib/uiPreferences'
import './collection.css'

type CollectionView = 'watch' | 'structure'
const emptyOrganization = (): CollectionOrganization => ({ version: 1, orderSource: 'existing', watchEntries: [], groups: [] })
const cloneOrganization = (value: CollectionOrganization): CollectionOrganization => structuredClone(value)
const viewKey = (rootId: number) => `animeshelf.collection-view:${rootId}`
const scrollKey = (rootId: number, view: CollectionView) => `animeshelf.collection-scroll:${rootId}:${view}`
const collapsedKey = (rootId: number, groupId: string) => `animeshelf.collection-group-collapsed:${rootId}:${groupId}`
const safeReadView = (rootId: number): CollectionView => typeof window === 'undefined' ? 'watch' : readStringPref(viewKey(rootId), 'watch', ['watch', 'structure'] as const)

function MoveButtons({ title, index, length, busy, onMove }: { title: string; index: number; length: number; busy: boolean; onMove: (offset: number) => void }) {
  return <span className="collection-order">
    <button type="button" disabled={busy || index === 0} aria-label={`上移${title}`} onClick={() => onMove(-1)}>↑</button>
    <button type="button" disabled={busy || index === length - 1} aria-label={`下移${title}`} onClick={() => onMove(1)}>↓</button>
  </span>
}

function StructureGroupSection({ rootId, row, index, groupCount, allTargets, artwork, manage, busy, query, onChange, onOpen, onEdit, renderStatus }: {
  rootId: number
  row: ResolvedCollectionGroup
  index: number
  groupCount: number
  allTargets: ResolvedCollectionTarget[]
  artwork: Record<number, string | null>
  manage: boolean
  busy: boolean
  query: string
  onChange: (update: (organization: CollectionOrganization) => CollectionOrganization) => void
  onOpen: (target: ResolvedCollectionTarget, folderId: number) => void
  onEdit: (work: CollectionWork) => void
  renderStatus: (target: ResolvedCollectionTarget) => ReactNode
}) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' ? true : !readBooleanPref(collapsedKey(rootId, row.group.id), false))
  const visible = filterCollectionTargets(row.members, query)
  const normalized = query.trim().toLocaleLowerCase()
  const shown = !normalized || row.group.title.toLocaleLowerCase().includes(normalized) ? row.members : visible
  if (normalized && shown.length === 0) return null
  return <section className="collection-structure-group">
    <div className="collection-structure-heading">
      {manage ? <div className="collection-structure-toggle">
        <button type="button" className="collection-structure-disclosure" aria-label={`${open ? '折叠' : '展开'}${row.group.title}`} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (typeof window !== 'undefined') writePref(collapsedKey(rootId, row.group.id), !next) }}><span className={`collection-chevron ${open ? 'rotate-90' : ''}`}>›</span></button>
        <input aria-label="分组名称" value={row.group.title} disabled={busy} maxLength={200} onChange={event => { const title = event.target.value; onChange(organization => ({ ...organization, groups: organization.groups.map(group => group.id === row.group.id ? { ...group, title } : group) })) }} />
        <span className="shrink-0 text-xs text-text-secondary">{row.members.length} 项</span>
      </div> : <button type="button" className="collection-structure-toggle" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (typeof window !== 'undefined') writePref(collapsedKey(rootId, row.group.id), !next) }}><span className={`collection-chevron ${open ? 'rotate-90' : ''}`}>›</span><span className="min-w-0 flex-1 break-words text-left font-medium text-text-primary">{row.group.title}</span><span className="shrink-0 text-xs text-text-secondary">{row.members.length} 项</span></button>}
      {manage && <div className="collection-structure-actions"><MoveButtons title={row.group.title} index={index} length={groupCount} busy={busy} onMove={offset => onChange(organization => moveStructureGroup(organization, row.group.id, offset))} /><Button size="sm" variant="danger" disabled={busy} onClick={() => onChange(organization => ({ ...organization, groups: organization.groups.filter(group => group.id !== row.group.id) }))}>删除组</Button></div>}
    </div>
    {open && <div className="collection-group-members">
      {shown.map(target => {
        const memberIndex = row.group.memberKeys.indexOf(target.targetKey)
        return <CollectionWorkItem key={`${row.group.id}:${target.targetKey}`} work={target.work} title={resolvedTargetTitle(target)} targetKey={target.targetKey} artwork={artwork} busy={busy} onOpen={folderId => onOpen(target, folderId)} onEdit={manage && target.work ? onEdit : undefined} status={renderStatus(target)} actions={manage ? <><MoveButtons title={resolvedTargetTitle(target)} index={memberIndex} length={row.group.memberKeys.length} busy={busy} onMove={offset => onChange(organization => moveStructureMember(organization, row.group.id, target.targetKey, offset))} /><Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange(organization => setStructureMembership(organization, row.group.id, target.targetKey, false))}>移出组</Button></> : undefined} />
      })}
      {!shown.length && <p className="p-4 text-sm text-text-secondary">这个分组暂时没有作品。</p>}
      {manage && <details className="collection-member-picker"><summary>分配成员</summary><div>{allTargets.map(target => <label key={target.targetKey}><input type="checkbox" checked={row.group.memberKeys.includes(target.targetKey)} disabled={busy} onChange={event => onChange(organization => setStructureMembership(organization, row.group.id, target.targetKey, event.target.checked))} /><span>{resolvedTargetTitle(target)}</span>{target.missing && <span className="collection-status-missing">引用失效</span>}</label>)}</div></details>}
    </div>}
  </section>
}

export default function CollectionDetail({ item, onRefresh, onSettings, onNotice }: { item: FolderDetail; onRefresh: () => Promise<void>; onSettings: () => void; onNotice?: (message: string) => void }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedView = searchParams.get('collectionView')
  const [view, setView] = useState<CollectionView>(() => requestedView === 'structure' || requestedView === 'watch' ? requestedView : safeReadView(item.id))
  const [showFolders, setShowFolders] = useState(false)
  const [manage, setManage] = useState(false)
  const [query, setQuery] = useState('')
  const [presentation, setPresentation] = useState<CollectionPresentation>({ entries: [] })
  const [organization, setOrganization] = useState<CollectionOrganization>(emptyOrganization)
  const [organizationDraft, setOrganizationDraft] = useState<CollectionOrganization>(emptyOrganization)
  const [organizationRevision, setOrganizationRevision] = useState(0)
  const [presentationReady, setPresentationReady] = useState(false)
  const [organizationReady, setOrganizationReady] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<CollectionWork | null>(null)
  const [editingGroup, setEditingGroup] = useState<CollectionGroup | null>(null)
  const [adding, setAdding] = useState(false)
  const [resetVersion, setResetVersion] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<MediaCatalogCandidate | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(item.name)
  const [titleBusy, setTitleBusy] = useState(false)
  const [locationBusy, setLocationBusy] = useState(false)
  const [newGroupTitle, setNewGroupTitle] = useState('')
  const [statusByFolder, setStatusByFolder] = useState<Record<number, string[]>>({})
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const listRef = useRef<HTMLElement>(null)
  const editingRef = useRef<CollectionWork | null>(null)
  const editingGroupRef = useRef<CollectionGroup | null>(null)
  const resetVersionRef = useRef<string | null>(null)
  const ready = presentationReady && organizationReady

  if (editing) editingRef.current = editing
  if (editingGroup) editingGroupRef.current = editingGroup
  if (resetVersion) resetVersionRef.current = resetVersion

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let current = true
    setPresentationReady(false); setOrganizationReady(false); setError(''); setManage(false)
    Promise.all([api.folders.getCollectionPresentation(item.id), api.folders.getCollectionOrganization(item.id)]).then(([nextPresentation, nextOrganization]) => {
      if (!current) return
      setPresentation(nextPresentation); setPresentationReady(true)
      setOrganization(nextOrganization.organization); setOrganizationDraft(cloneOrganization(nextOrganization.organization)); setOrganizationRevision(nextOrganization.revision); setOrganizationReady(true)
    }).catch(caught => { if (current) setError(`合集设置加载失败：${caught instanceof Error ? caught.message : String(caught)}`) })
    const requested = requestedView === 'structure' || requestedView === 'watch' ? requestedView : safeReadView(item.id)
    setView(requested); setShowFolders(false)
    return () => { current = false }
  }, [item.id])
  useEffect(() => {
    if (manage || (requestedView !== 'watch' && requestedView !== 'structure')) return
    setView(requestedView); setShowFolders(false)
    if (typeof window !== 'undefined') writePref(viewKey(item.id), requestedView)
  }, [item.id, manage, requestedView])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3500); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => { if (!editingTitle) setTitleDraft(item.name) }, [editingTitle, item.name])
  useEffect(() => {
    if (!ready || showFolders || typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = readNumberPref(scrollKey(item.id, view), 0, 0, 10_000_000) })
    return () => window.cancelAnimationFrame(frame)
  }, [item.id, ready, showFolders, view])

  const rows = useMemo(() => buildCollectionNavigation(item.media_catalog_v2, presentation), [item.media_catalog_v2, presentation])
  const statusFolderIds = useMemo(() => [...new Set(flattenCollectionWorks(rows).flatMap(work => work.folders.map(folder => folder.id)))], [rows])
  const statusFolderSignature = statusFolderIds.join(',')
  useEffect(() => {
    let current = true
    setStatusByFolder({})
    void Promise.allSettled(statusFolderIds.map(id => api.folders.get(id))).then(results => {
      if (!current) return
      const next: Record<number, string[]> = {}
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return
        const labels = result.value.tags.map(tag => tag.name).filter(name => /^状态:(未看|在看|看完)$/.test(name))
        if (labels.length) next[statusFolderIds[index]] = [...new Set(labels)]
      })
      setStatusByFolder(next)
    })
    return () => { current = false }
  }, [item.id, statusFolderSignature])
  const activeOrganization = manage ? organizationDraft : organization
  const organized = useMemo(() => resolveCollectionViews(rows, activeOrganization), [activeOrganization, rows])
  const normalized = query.trim().toLocaleLowerCase()
  const filteredWatch = useMemo(() => filterCollectionTargets(organized.watch, query), [organized.watch, query])
  const children = [...item.children].sort((a, b) => naturalCompare(a.name, b.name))
  const artwork = buildCollectionArtwork(item)
  const covers = children.filter(folder => posterUrl(folder)).slice(0, 4)
  const draftDirty = JSON.stringify(organizationDraft) !== JSON.stringify(organization)
  const catalogFiltered = rows.flatMap(row => {
    if (!normalized || row.title.toLocaleLowerCase().includes(normalized)) return [row]
    if (row.type === 'group') { const works = row.works.filter(work => work.title.toLocaleLowerCase().includes(normalized)); return works.length ? [{ ...row, works }] : [] }
    return []
  })

  const renderTargetStatus = (target: ResolvedCollectionTarget, showPending = false) => <>
    {target.work && [...new Set(target.work.folders.flatMap(folder => statusByFolder[folder.id] ?? []))].map(label => <span key={label} className="collection-status collection-status-existing"> · {label}</span>)}
    {showPending && target.pending && <span className="collection-status collection-status-pending"> · 待安排</span>}
    {target.work && target.work.folders.length === 0 && <span className="collection-status collection-status-missing"> · 媒体不可用</span>}
  </>
  const rememberScroll = () => { if (!showFolders && listRef.current && typeof window !== 'undefined') writePref(scrollKey(item.id, view), listRef.current.scrollTop) }
  const switchView = (next: CollectionView) => { rememberScroll(); setShowFolders(false); setView(next); setQuery(''); if (typeof window !== 'undefined') writePref(viewKey(item.id), next); navigate(`/folder/${item.id}?collectionView=${next}`, { replace: true }) }
  const openTarget = (target: ResolvedCollectionTarget, folderId: number) => { rememberScroll(); navigate(collectionFolderUrl(folderId, item.id, target.entryId, view)) }
  const changeDraft = (update: (value: CollectionOrganization) => CollectionOrganization) => setOrganizationDraft(current => update(current))
  const beginManage = () => { setOrganizationDraft(cloneOrganization(organization)); setNewGroupTitle(''); setManage(true); setShowFolders(false); setError('') }
  const cancelManage = () => { setOrganizationDraft(cloneOrganization(organization)); setNewGroupTitle(''); setManage(false); setError('') }

  const reloadSettings = async () => {
    const [nextPresentation, nextOrganization] = await Promise.all([api.folders.getCollectionPresentation(item.id), api.folders.getCollectionOrganization(item.id)])
    if (!mounted.current) return
    setPresentation(nextPresentation); setPresentationReady(true)
    setOrganization(nextOrganization.organization); setOrganizationDraft(cloneOrganization(nextOrganization.organization)); setOrganizationRevision(nextOrganization.revision); setOrganizationReady(true); setRefreshRequired(false)
  }

  const save: CollectionSave = async (action, message) => {
    if (busyRef.current || !ready) return false
    if (draftDirty) { setError('请先保存或取消观看顺序 / 系列结构调整，再修改作品识别。'); return false }
    busyRef.current = true; setBusy(true); setError('')
    try {
      await action()
      if (!mounted.current) return true
      try { await onRefresh(); await reloadSettings(); if (mounted.current) setNotice(message) }
      catch (caught) { if (mounted.current) { setPresentationReady(false); setOrganizationReady(false); setRefreshRequired(true); setNotice(''); setError(`已保存，但刷新显示失败：${caught instanceof Error ? caught.message : '请重试加载合集设置'}`) } }
      return true
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : '操作失败，请重试')
      return false
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const saveOrganization = async () => {
    if (busyRef.current || !organizationReady) return
    if (organizationDraft.groups.some(group => !group.title.trim())) return setError('分组名称不能为空。')
    if (!draftDirty) return setManage(false)
    busyRef.current = true; setBusy(true); setError('')
    try {
      const saved = await api.folders.updateCollectionOrganization(item.id, organizationDraft, organizationRevision)
      if (!mounted.current) return
      setOrganization(saved.organization); setOrganizationDraft(cloneOrganization(saved.organization)); setOrganizationRevision(saved.revision); setManage(false); setNotice('合集整理已保存')
    } catch (caught) {
      const apiError = caught as Error & { code?: string }
      if (apiError.code === 'COLLECTION_ORGANIZATION_CONFLICT') {
        try {
          const latest = await api.folders.getCollectionOrganization(item.id)
          if (mounted.current) { setOrganization(latest.organization); setOrganizationRevision(latest.revision); setError('合集已在其他位置更新。最新版本已读取，当前未保存调整仍保留；请核对后再次保存。') }
        } catch { if (mounted.current) setError(`${apiError.message}；重新读取最新版本失败。`) }
      } else if (mounted.current) setError(apiError.message || '合集整理保存失败，请重试')
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const retrySettings = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { if (refreshRequired) await onRefresh(); await reloadSettings() }
    catch (caught) { if (mounted.current) setError(`合集设置加载失败：${caught instanceof Error ? caught.message : '请重试'}`) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const moveCatalogRow = (siblings: CollectionRow[], key: string, offset: number) => {
    const index = siblings.findIndex(row => row.key === key); const next = [...siblings]
    if (index < 0 || !next[index + offset]) return
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    void save(() => api.folders.updateCollectionPresentation(item.id, next.map((row, position) => ({ key: row.orderKey, position }))), '识别浏览排序已保存，观看顺序未改变')
  }
  const editCatalogGroup = (filteredRow: CollectionGroup) => { const complete = rows.find(row => row.key === filteredRow.key); if (complete?.type === 'group') { setError(''); setEditingGroup(complete) } }
  const beginTitleEdit = () => { if (!titleBusy) { setTitleDraft(item.name); setEditingTitle(true) } }
  const saveTitle = async () => {
    if (titleBusy) return
    const name = titleDraft.trim()
    if (!name) return setError('显示名不能为空')
    if (name === item.name) return setEditingTitle(false)
    setTitleBusy(true); setError('')
    try { await updateFolderDisplayName(item.id, name); setEditingTitle(false); await onRefresh(); onNotice?.('显示名已保存'); setNotice('显示名已保存') }
    catch (caught) { setError(caught instanceof Error ? caught.message : '显示名保存失败') }
    finally { setTitleBusy(false) }
  }
  const openLocation = async () => { if (!locationBusy) { setLocationBusy(true); setError(''); try { await openFolderLocation(item.id) } catch (caught) { setError(caught instanceof Error ? caught.message : '无法打开文件夹') } finally { setLocationBusy(false) } } }
  const createGroup = () => {
    const title = newGroupTitle.trim()
    if (!title) return setError('请输入分组名称。')
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? `group:${crypto.randomUUID()}` : `group:${Date.now().toString(36)}`
    changeDraft(current => ({ ...current, groups: [...current.groups, { id, title, memberKeys: [] }] })); setNewGroupTitle('')
  }
  const retainedEditing = editingRef.current
  const retainedEditingGroup = editingGroupRef.current
  const retainedResetVersion = resetVersionRef.current

  return <div className="clean-page page-shell collection-page overflow-hidden">
    <div className="clean-page-header page-header ui-panel space-y-3">
      <nav className="flex shrink-0 items-center gap-2 text-xs text-text-secondary"><Button size="sm" variant="ghost" onClick={() => navigate(item.parent_id ? `/folder/${item.parent_id}` : `/library/${item.library_id}`)} icon={<ChevronLeftIcon width={14} height={14} />}>返回</Button><span>/</span><span>合集</span></nav>
      <header className="collection-header">
        <div className="collection-collage" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <CollectionArtwork key={index} src={covers[index] ? posterUrl(covers[index]) : null} title={covers[index]?.name ?? item.name} />)}</div>
        <div className="min-w-0 flex-1"><p className="mb-1 text-xs text-text-secondary">合集 · {organized.works.size} 部作品</p>{editingTitle ? <div className="flex max-w-2xl items-center gap-2"><input autoFocus className="input min-w-0 flex-1 text-xl font-bold" value={titleDraft} disabled={titleBusy} onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveTitle(); if (event.key === 'Escape') setEditingTitle(false) }} /><Button size="sm" disabled={titleBusy || !titleDraft.trim()} onClick={() => { void saveTitle() }}>{titleBusy ? '保存中…' : '保存'}</Button><Button size="sm" variant="ghost" disabled={titleBusy} onClick={() => setEditingTitle(false)}>取消</Button></div> : <h1 className="page-title break-words" title="双击编辑显示名" onDoubleClick={beginTitleEdit}>{item.name}</h1>}</div>
        <div className="collection-header-actions"><Button variant="ghost" disabled={busy || titleBusy} onClick={beginTitleEdit}>编辑显示名</Button><Button variant="ghost" icon={<FolderIcon width={15} height={15} />} disabled={locationBusy} onClick={() => { void openLocation() }}>{locationBusy ? '正在打开…' : '打开文件夹'}</Button>{manage ? <><Button variant="primary" disabled={busy} onClick={() => { void saveOrganization() }}>{busy ? '保存中…' : '保存整理'}</Button><Button variant="ghost" disabled={busy} onClick={cancelManage}>取消</Button></> : <Button variant="secondary" disabled={busy || !ready} onClick={beginManage}>管理</Button>}</div>
      </header>
      <div className="collection-view-switch" aria-label="合集视图"><button type="button" aria-pressed={!showFolders && view === 'watch'} onClick={() => switchView('watch')}>观看顺序</button><button type="button" aria-pressed={!showFolders && view === 'structure'} onClick={() => switchView('structure')}>系列结构</button></div>
    </div>
    {(error || notice) && <div className={`shrink-0 rounded-lg px-3 py-2 text-sm ${error ? 'bg-red-500/10 text-red-200' : 'bg-emerald-400/10 text-emerald-100'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
    {!ready && error && <Button className="self-start" size="sm" disabled={busy} onClick={() => { void retrySettings() }}>重试加载合集设置</Button>}
     <div className="collection-toolbar"><label className="desktop-search-shell collection-search min-w-0 flex-1 max-w-sm"><span className="sr-only">搜索合集</span><SearchIcon width={14} height={14} className="desktop-search-icon" /><input className="desktop-search-control w-full pl-8 text-sm" aria-label="搜索合集" placeholder={showFolders ? '搜索文件夹' : '搜索作品'} value={query} onChange={event => setQuery(event.target.value)} /></label><Button size="md" variant={showFolders ? 'secondary' : 'ghost'} onClick={() => { rememberScroll(); setShowFolders(value => !value); setQuery('') }}>{showFolders ? '返回双视图' : '浏览文件夹'}</Button>
      {manage && <><Button size="sm" disabled={busy || !ready || draftDirty} onClick={() => setAdding(true)}>添加作品</Button><Button size="sm" variant="ghost" disabled={busy || draftDirty} onClick={onSettings}>文件夹设置</Button><Button size="sm" variant="ghost" disabled={busy || !ready || draftDirty} onClick={() => { void save(() => api.folders.rebuildMediaCatalog(item.id), '自动记录已重新整理，用户顺序与分组保持不变') }}>重新整理自动记录</Button><Button size="sm" variant="ghost" disabled={busy || !ready || draftDirty || !item.collection_reset?.snapshot_version} onClick={() => { setError(''); setResetVersion(item.collection_reset!.snapshot_version) }}>完全重置</Button></>}
    </div>
    {!showFolders && view === 'watch' && <div className="collection-source"><span>{activeOrganization.orderSource === 'user' ? '用户维护的观看顺序' : '沿用已有列表（未确认）'}</span>{manage ? <button type="button" disabled={busy || (activeOrganization.orderSource === 'user' && activeOrganization.watchEntries.every(entry => !entry.pending))} onClick={() => changeDraft(confirmWatchOrder)}>确认当前顺序</button> : <button type="button" onClick={beginManage}>编辑顺序</button>}</div>}
    {manage && !showFolders && view === 'structure' && <div className="collection-new-group"><input className="input" value={newGroupTitle} disabled={busy} maxLength={200} placeholder="新分组名称" aria-label="新分组名称" onChange={event => setNewGroupTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') createGroup() }} /><Button size="sm" disabled={busy || !newGroupTitle.trim()} onClick={createGroup}>新建分组</Button></div>}
    <section ref={listRef} className="collection-list-panel ui-panel min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/[0.07] p-1" aria-label={showFolders ? '合集文件夹' : view === 'watch' ? '观看顺序' : '系列结构'}>
      {showFolders ? <>
        {children.filter(folder => !normalized || folder.name.toLocaleLowerCase().includes(normalized)).map(folder => <button key={folder.id} className="collection-folder-row" onClick={() => navigate(`/folder/${folder.id}`)}><FolderIcon width={18} height={18} /><span className="min-w-0 flex-1 break-words text-sm">{folder.name}</span><span className="shrink-0 text-xs text-text-secondary">{folder.file_count} 视频</span></button>)}
        {item.files.filter(file => !normalized || file.name.toLocaleLowerCase().includes(normalized)).map(file => <div key={file.id} className="collection-folder-row"><span className="min-w-0 flex-1 break-all text-xs text-text-secondary">{file.name}</span></div>)}
        {!children.length && !item.files.length && <p className="p-5 text-sm text-text-secondary">这个目录中没有文件夹或文件。</p>}
      </> : view === 'watch' ? <div className="collection-list">{filteredWatch.map(target => {
        const index = organized.watch.findIndex(entry => entry.entryId === target.entryId)
        return <CollectionWorkItem key={target.entryId} work={target.work} title={resolvedTargetTitle(target)} targetKey={target.targetKey} artwork={artwork} sequence={index + 1} busy={busy} onOpen={folderId => openTarget(target, folderId)} onEdit={manage && target.work ? work => setEditing(work) : undefined} status={renderTargetStatus(target, true)} actions={manage ? <><MoveButtons title={resolvedTargetTitle(target)} index={index} length={organized.watch.length} busy={busy} onMove={offset => changeDraft(current => moveWatchEntry(current, target.entryId, offset))} />{target.pending && <Button size="sm" variant="ghost" disabled={busy} onClick={() => changeDraft(current => acknowledgeWatchEntry(current, target.entryId))}>标为已安排</Button>}{target.missing && <Button size="sm" variant="ghost" disabled={busy} onClick={() => changeDraft(current => removeCollectionMembers(current, [target.targetKey]))}>移除失效引用</Button>}</> : undefined} />
      })}{!filteredWatch.length && <p className="p-6 text-sm text-text-secondary">{query ? '没有匹配的作品。' : '暂无作品。可在管理中添加目录，或使用管理功能整理。'}</p>}</div> : <div className="collection-structure">
        {organized.groups.map((row, index) => <StructureGroupSection key={row.group.id} rootId={item.id} row={row} index={index} groupCount={organized.groups.length} allTargets={organized.watch} artwork={artwork} manage={manage} busy={busy} query={query} onChange={changeDraft} onOpen={openTarget} onEdit={work => setEditing(work)} renderStatus={renderTargetStatus} />)}
        {(!normalized || '未分组'.includes(normalized) || filterCollectionTargets(organized.ungrouped, query).length > 0) && <section className="collection-structure-group"><div className="collection-structure-heading collection-structure-static"><span className="min-w-0 flex-1 font-medium text-text-primary">未分组</span><span className="text-xs text-text-secondary">{organized.ungrouped.length} 项</span></div><div className="collection-group-members">{filterCollectionTargets(organized.ungrouped, query).map(target => <CollectionWorkItem key={`ungrouped:${target.targetKey}`} work={target.work} title={resolvedTargetTitle(target)} targetKey={target.targetKey} artwork={artwork} busy={busy} onOpen={folderId => openTarget(target, folderId)} onEdit={manage && target.work ? work => setEditing(work) : undefined} status={renderTargetStatus(target)} />)}{organized.ungrouped.length === 0 && <p className="p-4 text-sm text-text-secondary">所有作品都已归入至少一个分组。</p>}</div></section>}
      </div>}
    </section>
    {manage && !showFolders && <details className="collection-catalog-tools"><summary>作品识别与目录调整</summary><p>此处沿用原有识别分组和显示排序；不会改变观看顺序或系列结构。</p><CollectionWorkList rows={catalogFiltered} artwork={artwork} manage busy={busy || !ready || draftDirty} onOpen={id => navigate(`/folder/${id}`)} onEdit={work => { if (!draftDirty) { setError(''); setEditing(work) } }} onEditGroup={editCatalogGroup} onMove={!normalized && !draftDirty ? moveCatalogRow : undefined} /></details>}
    {retainedEditing && <CollectionEditor open={editing !== null} key={retainedEditing.key} rootId={item.id} work={retainedEditing} groups={item.media_catalog_v2?.work_groups ?? []} busy={busy} errorMessage={error} onClose={() => setEditing(null)} onSave={save} />}
    {retainedEditingGroup && <CollectionGroupEditor open={editingGroup !== null} rootId={item.id} row={retainedEditingGroup} groups={item.media_catalog_v2?.work_groups ?? []} busy={busy} errorMessage={error} onClose={() => setEditingGroup(null)} onSave={save} />}
    {retainedResetVersion && <CollectionResetDialog open={resetVersion !== null} rootId={item.id} rootName={item.name} snapshotVersion={retainedResetVersion} busy={busy} errorMessage={error} onClose={() => setResetVersion(null)} onSave={save} />}
    <CollectionDialog open={adding} title="添加作品目录" busy={busy} onClose={() => { setAdding(false); setCandidate(null) }}>
      {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
      {candidate ? <><Button size="sm" variant="ghost" disabled={busy} onClick={() => setCandidate(null)}>← 选择其他目录</Button><p className="break-words text-sm">{candidate.folder_name}</p><CollectionClassificationForm key={candidate.folder_id} busy={busy} initial={{ kind: candidate.suggested_kind, seasonNumbers: candidate.suggested_season_numbers, partNumber: candidate.suggested_part_number, customLabel: candidate.suggested_custom_label }} onSave={async body => { const ok = await save(() => api.folders.updateMediaCatalog(candidate.folder_id, body), '作品已添加'); if (ok) { setAdding(false); setCandidate(null) }; return ok }} /></> : <>
        {(item.media_catalog_candidates ?? []).map(row => <button key={row.folder_id} type="button" className="collection-folder-row" disabled={busy} onClick={() => setCandidate(row)}><span className="min-w-0 flex-1 break-words text-sm">{row.folder_name}</span><span className="text-xs text-text-secondary">{row.reason === 'excluded' ? '已移出' : '未加入'}</span></button>)}
        {!item.media_catalog_candidates?.length && <p className="text-sm text-text-secondary">没有可添加的已扫描目录。新文件夹请先扫描媒体库。</p>}
      </>}
    </CollectionDialog>
  </div>
}
