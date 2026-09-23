import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FolderView, Library, Tag } from '../types'
import { api, type QueryParams } from '../api'
import FilterBar, { type FilterState } from '../components/FilterBar'
import DataTable from '../components/DataTable'
import PosterWall from '../components/PosterWall'
import LibraryEditDialog from '../components/LibraryEditDialog'
import LibrarySelectionActions from '../components/LibrarySelectionActions'
import FolderMoveDialog from '../components/FolderMoveDialog'
import { LibraryBrowsePresentation } from '../components/design/DesktopPresentation'
import Button from '../components/ui/Button'
import { ChevronDownIcon, HomeIcon, LibraryIcon, SearchIcon } from '../components/ui/Icons'
import { customFilterTags, sortLibraryItems } from '../lib/libraryFilters'
import { libraryRouteKey, readLibraryRouteDomain, readLibraryRouteFilter, writeLibraryRouteDomain, writeLibraryRouteFilter } from '../lib/libraryRouteState'
import { readBooleanPref, readStringPref, UI_PREF_KEYS, useNumberPref, writePref } from '../lib/uiPreferences'
import { retainResultSelection, scanResultMessage, useLibraryScanRefresh } from '../lib/libraryScan'
import { recoverRead } from '../lib/readRecovery'
import { ModuleErrorBoundary, useModules } from '../modules/registry'
import { useDialogBehavior } from '../components/ui/dialogBehavior'
import { libraryActionTargets } from '../lib/libraryActionScope'
import OverlayPresence from '../components/ui/OverlayPresence'
import { setLibraryView, useLibraryView, useTitlePosition, usePresentationError } from '../lib/presentationPreferences'

const defaultFilter = (): FilterState => ({
  q: '', tag: [], status: [], libraryIds: [], mediaDomain: 'all', tagMatch: 'any',
  showSeasons: readBooleanPref(UI_PREF_KEYS.libraryShowSeasons, true),
  // 媒体库固定展示系列，避免把季目录和资源子目录平铺到主视图。
  view: readStringPref<FilterState['view']>(UI_PREF_KEYS.libraryView, 'table', ['table', 'poster']),
  sort: 'name',
  order: 'asc',
})

const libraryScrollPositions = new Map<string, number>()

const formatSize = (bytes: number) => {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

type LibraryViewProps = {
  libraryId?: number
  showAll?: boolean
  libraries?: Library[]
  onLibrariesChange?: () => void | Promise<void>
}

export default function LibraryView({ libraryId, showAll = false, libraries = [], onLibrariesChange = () => {} }: LibraryViewProps) {
  const { modules } = useModules()
  useLibraryView()
  const titlePosition = useTitlePosition('library')
  const presentationError = usePresentationError()
  const baseRouteKey = libraryRouteKey(libraryId, Boolean(showAll))
  const [items, setItems] = useState<FolderView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [tags, setTags] = useState<Tag[]>([])
  const [tagsReady, setTagsReady] = useState(false)
  const [, refreshFilter] = useState(0)
  const defaultFilterRef = useRef<FilterState | undefined>(undefined)
  if (!defaultFilterRef.current) defaultFilterRef.current = defaultFilter()
  const fallbackFilter = defaultFilterRef.current
  const mediaDomain = readLibraryRouteDomain(baseRouteKey, fallbackFilter.mediaDomain)
  const routeKey = libraryRouteKey(libraryId, Boolean(showAll), mediaDomain)
  const filter = readLibraryRouteFilter(routeKey, fallbackFilter)
  const actionScopeKey = JSON.stringify([routeKey, filter.q, filter.tag, filter.status, filter.tagMatch])
  const actionScopeRef = useRef(actionScopeKey)
  actionScopeRef.current = actionScopeKey
  const [loadedScopeKey, setLoadedScopeKey] = useState('')
  const [actionReadPending, setActionReadPending] = useState(true)
  const setFilter = useCallback((value: FilterState | ((previous: FilterState) => FilterState)) => {
    const previous = readLibraryRouteFilter(routeKey, fallbackFilter)
    const next = typeof value === 'function' ? value(previous) : value
    if (next.view !== previous.view && next.mediaDomain === previous.mediaDomain) setLibraryView(next.view)
    const nextRouteKey = libraryRouteKey(libraryId, Boolean(showAll), next.mediaDomain)
    if (next.mediaDomain !== mediaDomain) {
      // Domain switching selects an independent route scope. Do not carry the
      // current query, tags, or sorting into a domain that already has
      // its own browsing state.
      const targetFallback = { ...fallbackFilter, mediaDomain: next.mediaDomain }
      const target = readLibraryRouteFilter(nextRouteKey, targetFallback)
      writeLibraryRouteDomain(baseRouteKey, next.mediaDomain)
      writeLibraryRouteFilter(nextRouteKey, target)
    } else {
      writeLibraryRouteFilter(nextRouteKey, next)
    }
    refreshFilter(previous => previous + 1)
  }, [baseRouteKey, fallbackFilter, libraryId, mediaDomain, routeKey, showAll])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [operationMsg, setOperationMsg] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [filterEditorRequest, setFilterEditorRequest] = useState(0)
  const [manageOpen, setManageOpen] = useState(false)
  const [actionMenu, setActionMenu] = useState<HTMLDivElement | null>(null)
  const [contentSwitching, setContentSwitching] = useState(false)
  const previousDomain = useRef(mediaDomain)
  const [activeTaskPanelId, setActiveTaskPanelId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [moveHistoryOpen, setMoveHistoryOpen] = useState(false)
  const batchBusyRef = useRef(false)
  const manageRef = useRef<HTMLDivElement>(null)
  const manageButtonRef = useRef<HTMLButtonElement>(null)
  const taskDialogRef = useRef<HTMLDivElement>(null)
  const taskCloseRef = useRef<HTMLButtonElement>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const getContentScrollElement = useCallback(() => contentScrollRef.current?.querySelector<HTMLElement>('.library-data-table tbody') ?? contentScrollRef.current, [])
  const lastScrollTopRef = useRef(0)
  const observedScrollRef = useRef(false)
  const navigatingAwayRef = useRef(false)
  const posterSize = useNumberPref(UI_PREF_KEYS.posterCardWidth, 150, 100, 280)
  const navigate = useNavigate()
  const loadSeq = useRef(0) // 请求序号：快速切换筛选时丢弃过期响应（T8-M2）
  const loadController = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const routeScopeRef = useRef({ key: routeKey, generation: 0 })
  if (routeScopeRef.current.key !== routeKey) {
    routeScopeRef.current = { key: routeKey, generation: routeScopeRef.current.generation + 1 }
  }
  const latestLoadRef = useRef({ libraryId, showAll, filter })
  latestLoadRef.current = { libraryId, showAll, filter }

  const load = useCallback(async (routeGeneration = routeScopeRef.current.generation, background = false) => {
    if (!mountedRef.current || routeGeneration !== routeScopeRef.current.generation) return
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    const seq = ++loadSeq.current
    const requestedScope = actionScopeRef.current
    setActionReadPending(true)
    if (!background) setLoading(true)
    setLoadError('')
    const params: QueryParams = {}
    const latest = latestLoadRef.current
    if (latest.libraryId) params.libraryId = latest.libraryId
    if (latest.filter.q) params.q = latest.filter.q
    if (latest.filter.tag.length) params.tag = latest.filter.tag
    if (latest.filter.status.length) params.status = latest.filter.status
    params.tagMatch = latest.filter.tagMatch
    params.type = 'series'
    params.mediaDomain = latest.filter.mediaDomain
    try {
      const data = await recoverRead(signal => api.folders.list(params, signal), controller.signal)
      if (!mountedRef.current || routeGeneration !== routeScopeRef.current.generation || seq !== loadSeq.current) return
      setItems(data)
      setLoadedScopeKey(requestedScope)
      setSelected(previous => retainResultSelection(previous, data.map(item => item.id)))
    } catch (error: any) {
      if (!mountedRef.current || routeGeneration !== routeScopeRef.current.generation || seq !== loadSeq.current) return
      setLoadedScopeKey('')
      if (background) setOperationMsg(`媒体库刷新失败：${error?.message ?? '读取失败'}`)
      else setLoadError(error?.message ?? '媒体库读取失败')
    } finally {
      if (mountedRef.current && routeGeneration === routeScopeRef.current.generation && seq === loadSeq.current) { setLoading(false); setActionReadPending(false) }
    }
  }, [])

  useLayoutEffect(() => {
    if (previousDomain.current !== mediaDomain) { previousDomain.current = mediaDomain; setContentSwitching(true) }
  }, [mediaDomain])
  useEffect(() => {
    if (loading || !contentSwitching) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setContentSwitching(false)) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [loading, contentSwitching, mediaDomain])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadController.current?.abort()
      routeScopeRef.current.generation++
      loadSeq.current++
    }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
    const main = getContentScrollElement()
    if (!main) return
    const saved = libraryScrollPositions.get(routeKey)
    if (saved === undefined || loading) return
    const restoreFrame = window.requestAnimationFrame(() => {
      main.scrollTop = saved
    })
    return () => window.cancelAnimationFrame(restoreFrame)
  }, [loading, routeKey, filter.view, getContentScrollElement])
  useEffect(() => {
    const main = getContentScrollElement()
    if (!main) return
    lastScrollTopRef.current = main.scrollTop
    const remember = () => {
      observedScrollRef.current = true
      lastScrollTopRef.current = main.scrollTop
      libraryScrollPositions.set(routeKey, lastScrollTopRef.current)
    }
    main.addEventListener('scroll', remember, { passive: true })
    return () => {
      // During route teardown the browser may reset a detached scroll node to
      // zero before effect cleanup runs. Preserve the last observed position.
      if (!navigatingAwayRef.current && observedScrollRef.current) {
        libraryScrollPositions.set(routeKey, lastScrollTopRef.current)
      }
      main.removeEventListener('scroll', remember)
    }
  }, [routeKey, loading, filter.view, getContentScrollElement])
  useEffect(() => {
    loadSeq.current++
    setLoading(true)
    setLoadError('')
    setScanning(false)
    setScanMsg('')
    setOperationMsg('')
    setManageOpen(false)
    setActiveTaskPanelId(null)
  }, [routeKey])
  useEffect(() => {
    setSelected(new Set()) // 筛选条件/库变化时清空选择，避免批量操作作用到屏幕外条目（T8-M1）
    load().catch(console.error)
  }, [actionScopeKey, load])
  useEffect(() => {
    const controller = new AbortController()
    recoverRead(signal => api.tags.list(signal), controller.signal).then(value => {
      if (!controller.signal.aborted) { setTags(value); setTagsReady(true) }
    }).catch(error => { if (!controller.signal.aborted) console.error(error) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!tagsReady) return
    const valid = new Set(customFilterTags(tags).map(tag => tag.name))
    if (filter.tag.every(tag => valid.has(tag))) return
    setFilter(previous => ({ ...previous, tag: previous.tag.filter(tag => valid.has(tag)) }))
  }, [filter.tag, tags, tagsReady])
  useEffect(() => {
    try { writePref(UI_PREF_KEYS.libraryShowSeasons, filter.showSeasons) }
    catch { /* Storage denial must not prevent browsing or restoring the global view. */ }
  }, [filter.showSeasons])
  useEffect(() => {
    if (!manageOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      const portalMenu = (target as HTMLElement).closest?.('[role="listbox"]')
      if (!manageRef.current?.contains(target) && !portalMenu) setManageOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setManageOpen(false)
      manageButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [manageOpen])
  useLibraryScanRefresh(() => { if (!batchBusyRef.current) void load(routeScopeRef.current.generation, true) }, setScanMsg, libraryId ? [libraryId] : [], routeKey)
  const sorted = useMemo(
    () => sortLibraryItems(items, filter.sort, filter.order),
    [items, filter.sort, filter.order],
  )
  const domainLabels = { anime: '动漫', live_action: '真人影视', unknown: '待确认' } as const
  const groupedSorted = useMemo(() => (['anime', 'live_action', 'unknown'] as const).map(domain => ({
    domain,
    label: domainLabels[domain],
    items: sorted.filter(item => (item.media_domain ?? 'unknown') === domain),
  })).filter(group => group.items.length > 0), [sorted])
  const moduleToolbars = useMemo(() => modules.flatMap(loaded => (
    loaded.contribution.libraryToolbars ?? []
  ).map(toolbar => ({ ...toolbar, moduleId: loaded.id }))), [modules])
  const moduleActions = useMemo(() => modules.flatMap(loaded => (loaded.contribution.libraryActions ?? []).map(action => ({ ...action, moduleId: loaded.id }))), [modules])
  const moduleTaskPanels = useMemo(() => modules.flatMap(loaded => (
    loaded.contribution.libraryTaskPanels ?? []
  ).map(panel => ({ ...panel, moduleId: loaded.id, key: `${loaded.id}:${panel.id}` }))), [modules])
  const visibleModuleToolbars = useMemo(() => moduleToolbars.filter(toolbar => (
    Boolean(libraryId) || (showAll && toolbar.supportsAllLibraries === true)
  )), [libraryId, moduleToolbars, showAll])
  const visibleModuleTaskPanels = useMemo(() => moduleTaskPanels.filter(panel => (
    Boolean(libraryId) || (showAll && panel.supportsAllLibraries === true)
  )), [libraryId, moduleTaskPanels, showAll])
  const currentLibrary = libraryId === undefined ? undefined : libraries.find(library => library.id === libraryId)
  const actionFolderIds = libraryActionTargets(items, selected)
  const actionScopeLabel = `${showAll ? '全部媒体' : currentLibrary?.name ?? '当前媒体库'} / ${mediaDomain === 'all' ? '全部分类' : domainLabels[mediaDomain]} / ${actionFolderIds.some(id => selected.has(id)) ? '当前勾选' : '当前筛选结果'}`
  const actionScopeReady = !loading && !actionReadPending && !loadError && loadedScopeKey === actionScopeKey && actionFolderIds.length > 0
  const closeManage = () => { setManageOpen(false); manageButtonRef.current?.focus() }
  const refreshActionScope = () => {
    if (mountedRef.current && actionScopeRef.current === actionScopeKey) return load(routeScopeRef.current.generation, true)
  }
  const activeTaskPanel = visibleModuleTaskPanels.find(panel => panel.key === activeTaskPanelId)
  const ActiveTaskPanel = activeTaskPanel?.component
  const taskScopeLabel = activeTaskPanel
    ? activeTaskPanel.scope === 'all-libraries' || (showAll && activeTaskPanel.supportsAllLibraries === true)
      ? '全部媒体库'
      : currentLibrary
        ? `媒体库「${currentLibrary.name}」`
        : '当前媒体库'
    : ''
  const closeTaskPanel = useCallback(() => setActiveTaskPanelId(null), [])
  useDialogBehavior({
    open: Boolean(activeTaskPanel),
    dialogRef: taskDialogRef,
    initialFocusRef: taskCloseRef,
    triggerRef: manageButtonRef,
    onClose: closeTaskPanel,
  })

  const stats = useMemo(() => ({
    size: items.reduce((sum, item) => sum + item.size, 0),
    files: items.reduce((sum, item) => sum + item.file_count, 0),
  }), [items])
  const handleScan = async () => {
    const ids = libraryId ? [libraryId] : libraries.map(library => library.id)
    if (!ids.length || scanning) return
    const routeGeneration = routeScopeRef.current.generation
    setScanning(true); setScanMsg('正在扫描…')
    try {
      const results = await Promise.all(ids.map(id => api.libraries.scan(id)))
      if (!mountedRef.current || routeGeneration !== routeScopeRef.current.generation) return
      setScanMsg(results.map(scanResultMessage).filter((value, index, values) => values.indexOf(value) === index).join('；'))
      await load(routeGeneration, true)
    } catch (e: any) {
      if (mountedRef.current && routeGeneration === routeScopeRef.current.generation) setScanMsg(`扫描失败：${e.message}`)
    } finally {
      if (mountedRef.current && routeGeneration === routeScopeRef.current.generation) setScanning(false)
    }
  }

  const handleLibrarySaved = async (updated: Library) => {
    setEditOpen(false)
    await onLibrariesChange()
    await load(undefined, true)
  }

  const toggleSelect = (id: number) => setSelected(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s })
  const selectAll = () => setSelected(prev => items.every(i => prev.has(i.id)) ? new Set() : new Set(items.map(i => i.id)))
  const setPosterSize = (value: number) => writePref(UI_PREF_KEYS.posterCardWidth, value)
  const rememberCurrentScrollPosition = useCallback(() => {
    const main = getContentScrollElement()
    if (!main) return
    lastScrollTopRef.current = main.scrollTop
    observedScrollRef.current = true
    libraryScrollPositions.set(routeKey, main.scrollTop)
  }, [routeKey, getContentScrollElement])
  const openFolder = useCallback((id: number) => {
    navigatingAwayRef.current = true
    rememberCurrentScrollPosition()
    navigate(`/folder/${id}`)
  }, [navigate, rememberCurrentScrollPosition])
  const filterSummaries = useMemo(() => {
    const summaries: Array<{ key: string; label: string; values: string[]; remove: (value: string) => void }> = []
    if (filter.tag.length > 0) summaries.push({
      key: 'tag',
      label: '标签',
      values: filter.tag,
      remove: value => setFilter(previous => ({ ...previous, tag: previous.tag.filter(tag => tag !== value) })),
    })
    if (filter.status.length > 0) summaries.push({
      key: 'status',
      label: '状态',
      values: filter.status.map(value => value.replace(/^状态:/, '')),
      remove: value => setFilter(previous => ({ ...previous, status: previous.status.filter(status => status.replace(/^状态:/, '') !== value) })),
    })
    return summaries
  }, [filter.status, filter.tag, setFilter])
  const hasAdditionalFilters = filter.tag.length > 0 || filter.status.length > 0 || filter.tagMatch !== 'any'

  return (
    <div data-title-position={titlePosition} className="library-page page-shell overflow-visible" style={{ gap: 8, paddingTop: 12, paddingBottom: 12 }}>
      <LibraryBrowsePresentation>
      <section className="library-header page-header ui-panel relative z-30 shrink-0 overflow-visible rounded-xl border border-border/70 px-4 py-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
        <div className="library-heading-row flex flex-wrap items-center justify-between gap-3">
          <div className="library-heading flex min-w-0 items-center gap-3">
            <div className="library-heading-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/25">
              {showAll ? <HomeIcon width={17} height={17} /> : <LibraryIcon width={17} height={17} />}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight text-text-primary">{showAll ? '全部媒体' : currentLibrary?.name ?? '媒体库'}</h1>
              <div className="library-statistics mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-text-secondary">
                <span><strong className="font-semibold text-text-primary tabular-nums">{formatSize(stats.size)}</strong> 总大小</span>
                <span className="h-3 w-px bg-border" />
                <span><strong className="font-semibold text-text-primary tabular-nums">{stats.files}</strong> 个文件</span>
              </div>
            </div>
          </div>

          {(libraryId || moduleActions.length > 0 || visibleModuleToolbars.length > 0 || visibleModuleTaskPanels.length > 0) && (
            <div className="library-header-actions flex flex-wrap items-center justify-end gap-2">
              {libraryId && <Button size="sm" variant="primary" onClick={handleScan} disabled={scanning} icon={<SearchIcon width={14} height={14} />}>
                {scanning ? '扫描中…' : '扫描媒体库'}
              </Button>}
              <div ref={manageRef} className="relative">
                <Button ref={manageButtonRef} size="sm" variant="secondary" aria-haspopup="menu" aria-expanded={manageOpen} onClick={() => setManageOpen(value => !value)}>
                  管理 <ChevronDownIcon width={14} height={14} className={manageOpen ? 'rotate-180' : ''} />
                </Button>
                <OverlayPresence open={manageOpen} kind="menu">{manageOpen && (
                  <div role="menu" aria-label="管理" className="library-manage ui-panel-strong absolute right-0 top-[calc(100%+0.5rem)] z-[110] w-[min(21rem,calc(100vw-2rem))] max-h-[min(34rem,calc(100vh-6rem))] overflow-y-auto rounded-xl border border-border/70 p-2 shadow-[0_22px_60px_rgba(0,0,0,0.4)]">
                    <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-xs hover:bg-surface-hover" onClick={() => { setManageOpen(false); setMoveHistoryOpen(true) }}>移动任务…</button>
                    <div ref={setActionMenu} />
                    {libraryId && currentLibrary && (
                      <button type="button" role="menuitem" className="mb-3 flex w-full items-center justify-between rounded-lg border border-border/70 bg-surface/70 px-3 py-2 text-left text-xs text-text-primary transition hover:bg-surface-hover" onClick={() => { setManageOpen(false); setEditOpen(true) }}>
                        <span>编辑媒体库…</span><span className="text-text-secondary">名称 / 默认类型</span>
                      </button>
                    )}
                    {visibleModuleTaskPanels.length > 0 && (
                      <div className={libraryId && currentLibrary ? 'border-t border-border/60 pt-3' : ''}>
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">任务</p>
                        <div className="space-y-2">
                          {visibleModuleTaskPanels.map(panel => {
                            const panelScope = panel.scope === 'all-libraries' || (showAll && panel.supportsAllLibraries === true)
                              ? '全部媒体库'
                              : currentLibrary?.name ?? '当前媒体库'
                            return <button
                              key={panel.key}
                              type="button"
                              role="menuitem"
                              className="flex w-full items-start justify-between gap-4 rounded-lg border border-border/70 bg-surface/70 px-3 py-2 text-left transition hover:border-accent/40 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              onClick={() => { setManageOpen(false); setActiveTaskPanelId(panel.key) }}>
                              <span className="min-w-0">
                                <span className="block text-xs font-medium text-text-primary">{panel.label}</span>
                                <span className="mt-1 block text-[11px] leading-4 text-text-secondary">{panel.description}</span>
                              </span>
                              <span className="shrink-0 pt-0.5 text-[11px] text-text-secondary">{panelScope}</span>
                            </button>
                          })}
                        </div>
                      </div>
                    )}
                    {visibleModuleToolbars.length > 0 && (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-red-300/80">危险操作</p>
                        <div className="space-y-2">
                          {visibleModuleToolbars.map(({ moduleId, id, component: Toolbar }) => (
                            <div key={`${moduleId}:${id}`}>
                              <ModuleErrorBoundary moduleId={moduleId}>
                                <Toolbar libraryId={libraryId} items={items} onRefresh={() => load(routeScopeRef.current.generation, true)} onStatus={setOperationMsg} />
                              </ModuleErrorBoundary>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}</OverlayPresence>
              </div>
            </div>
          )}
        </div>

        {scanMsg && (
          <div className="library-scan-notice mt-1 flex min-h-7 flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span aria-hidden="true" className={/失败|未完成|不可用/.test(scanMsg) ? 'text-warning' : 'text-text-secondary'}>{/失败|未完成|不可用/.test(scanMsg) ? '⚠' : '↻'}</span>
            <span role="status">{scanMsg}</span>
            {/失败|未完成|不可用/.test(scanMsg) && <Button size="sm" variant="ghost" disabled={scanning} onClick={() => { void handleScan() }}>重试扫描</Button>}
          </div>
        )}
        {operationMsg && <p role="status" className="library-scan-notice text-xs text-text-secondary">{operationMsg}</p>}
        {presentationError && <p role="status" className="library-scan-notice text-xs text-warning">{presentationError}</p>}
        {moduleActions.map(({ moduleId, id, component: Actions }) => <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId}>
          <Actions libraryId={libraryId} items={items} folderIds={actionFolderIds} scopeLabel={actionScopeLabel} scopeKey={actionScopeKey} scopeReady={actionScopeReady} menuContainer={actionMenu} closeMenu={closeManage} onRefresh={refreshActionScope} onStatus={setOperationMsg} />
        </ModuleErrorBoundary>)}
      </section>

      <div className="library-filter-slot shrink-0"><FilterBar value={filter} onChange={setFilter} tags={tags} showMediaDomainFilter posterSize={posterSize} onPosterSizeChange={setPosterSize} openFilterRequest={filterEditorRequest} /></div>

      <div className="library-results flex min-h-7 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-1 py-0.5 text-xs text-text-secondary">
        <LibrarySelectionActions key={actionScopeKey} items={items} selected={selected} libraries={libraries} tags={tags}
          disabled={loading || actionReadPending || Boolean(loadError)} onSelectAll={selectAll} onClear={() => setSelected(new Set())}
          onBusy={busy => { batchBusyRef.current = busy; setBatchBusy(busy) }}
            onCompleted={async ids => {
              if (actionScopeRef.current !== actionScopeKey) return
              setSelected(previous => new Set([...previous].filter(id => !ids.includes(id))))
              setOperationMsg(`已处理 ${ids.length} 项`)
              await load(routeScopeRef.current.generation, true)
          }} />
        {filterSummaries.map(summary => (
          <div key={summary.key} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border/60 bg-surface/45 px-1.5 py-0.5">
            <button
              type="button"
              className="shrink-0 text-text-secondary transition hover:text-text-primary"
              aria-label={`编辑${summary.label}筛选`}
              onClick={() => setFilterEditorRequest(value => value + 1)}>
              {summary.label}:
            </button>
            {summary.values.slice(0, 2).map(value => (
              <span key={value} className="inline-flex max-w-44 items-center gap-0.5 rounded-md bg-surface-hover/75 pl-1.5 text-text-primary">
                <span className="truncate" title={value}>{value}</span>
                <button
                  type="button"
                  className="rounded px-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  aria-label={`移除${summary.label} ${value}`}
                  onClick={() => summary.remove(value)}>×</button>
              </span>
            ))}
            {summary.values.length > 2 && (
              <button
                type="button"
                className="rounded px-1 text-accent hover:bg-accent/10"
                aria-label={`编辑${summary.label}筛选`}
                onClick={() => setFilterEditorRequest(value => value + 1)}>
                +{summary.values.length - 2}
              </button>
            )}
          </div>
        ))}
        {hasAdditionalFilters && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-accent transition hover:bg-accent/10 hover:text-text-primary"
            onClick={() => setFilter(previous => ({ ...previous, tag: [], status: [], tagMatch: 'any' }))}>
            清除附加筛选
          </button>
        )}
      </div>

      </LibraryBrowsePresentation>
      <div
        ref={contentScrollRef}
        data-switching={contentSwitching}
        className="library-content min-h-0 flex-1 overflow-y-auto"
        onPointerDownCapture={event => {
          const target = event.target as HTMLElement
          if (!target.closest('button[aria-label^="打开 "]')) return
          navigatingAwayRef.current = true
          rememberCurrentScrollPosition()
        }}>
        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-text-secondary">
            <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
            <p className="text-sm">正在读取媒体库…</p>
          </div>
        ) : loadError ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="text-3xl">⚠</span>
            <div>
              <p className="text-sm font-medium text-red-300">媒体库读取失败</p>
              <p className="mt-1 max-w-lg break-all text-xs text-text-secondary">{loadError}</p>
            </div>
            <button className="rounded-lg border border-accent/35 px-4 py-2 text-sm text-accent transition hover:bg-accent/10" onClick={() => { void load() }}>重新读取</button>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-text-secondary gap-2 px-6">
            <span className="text-5xl">🗂</span>
            {filter.q || filter.tag.length || filter.status.length ? <p>没有符合条件的条目，试试调整筛选条件</p> : items.length === 0 && !showAll ? (
              <>
                <p>媒体库为空，点击「扫描（Everything）」从 Everything 载入文件结构</p>
                <button className="mt-1 bg-accent text-white rounded-lg px-4 py-2 text-sm" onClick={() => navigate('/settings')}>去设置添加媒体库</button>
              </>
            ) : showAll ? (
              <div className="flex flex-col items-center gap-3 max-w-md w-full">
                <p>媒体库为空，添加第一个媒体库开始使用</p>
                <div className="ui-panel-subtle w-full bg-surface border border-border rounded-xl p-4 space-y-2 text-left">
                  <input id="inline-lib-name" placeholder="媒体库名称（如：动画库）" className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm" />
                  <input id="inline-lib-path" placeholder="绝对路径，如 D:\Anime" className="w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm" />
                  <div className="flex items-center gap-2">
                    <select id="inline-lib-type" className="bg-bg border border-border rounded-lg px-2 py-2 text-sm">
                      <option value="anime">动画</option>
                      <option value="movie">影视</option>
                    </select>
                    <button className="flex-1 bg-accent text-white rounded-lg px-4 py-2 text-sm" onClick={async () => {
                      const name = (document.getElementById('inline-lib-name') as HTMLInputElement).value.trim()
                      const p = (document.getElementById('inline-lib-path') as HTMLInputElement).value.trim()
                      const type = (document.getElementById('inline-lib-type') as HTMLSelectElement).value
                      if (!name || !p) return alert('名称和路径必填')
                      try {
                        const lib = await api.libraries.create({ name, path: p, type })
                        navigate(`/library/${lib.id}`)
                      } catch (e: any) { alert(e.message) }
                    }}>添加媒体库</button>
                  </div>
                </div>
              </div>
            ) : (
              <p>没有符合条件的条目，试试调整筛选条件</p>
            )}
          </div>
        ) : filter.view === 'table' ? (
          <div className="library-table-viewport px-4 pb-4 pt-0">
            <DataTable items={sorted} selected={selected} onToggleSelect={toggleSelect} onSelectAll={selectAll}
              selectionDisabled={batchBusy} onOpen={openFolder} showLibrary={showAll} showSeasons={filter.showSeasons} />
          </div>
        ) : filter.mediaDomain === 'all' ? (
          <div className="library-grid-groups space-y-5 px-4 pb-4 pt-0">
            {groupedSorted.map(group => <section key={group.domain} aria-labelledby={`library-domain-${group.domain}`}>
              {(showAll || groupedSorted.length > 1) && (
                <div className="library-domain-heading mb-2 flex items-center gap-2 border-b border-white/10 pb-2">
                  <h2 id={`library-domain-${group.domain}`} className="text-sm font-semibold text-text-primary">{group.label}</h2>
                  <span className="text-xs text-text-secondary">{group.items.length} 项</span>
                </div>
              )}
              <PosterWall items={group.items} selected={selected} onToggleSelect={toggleSelect} selectionDisabled={batchBusy} onOpen={openFolder} showSeasons={filter.showSeasons} posterSize={posterSize} />
            </section>)}
          </div>
        ) : (
          <div className="library-poster-group px-4 pb-4 pt-0">
            <PosterWall items={sorted} selected={selected} onToggleSelect={toggleSelect} selectionDisabled={batchBusy} onOpen={openFolder} showSeasons={filter.showSeasons} posterSize={posterSize} />
          </div>
        )}
      </div>
      {activeTaskPanel && ActiveTaskPanel && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) closeTaskPanel() }}>
          <div
            ref={taskDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-task-title"
            tabIndex={-1}
            className="clean-dialog ui-panel-strong flex max-h-[min(44rem,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
            onMouseDown={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
              <div className="min-w-0">
                <h2 id="library-task-title" className="text-base font-semibold text-text-primary">{activeTaskPanel.label}</h2>
                <p className="mt-1 text-xs text-text-secondary">作用范围：{taskScopeLabel}</p>
              </div>
              <button ref={taskCloseRef} type="button" className="shrink-0 rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary" onClick={closeTaskPanel} aria-label="关闭">×</button>
            </div>
            <div className="min-h-0 overflow-y-auto px-5 py-5">
              <p className="mb-4 text-sm leading-6 text-text-secondary">{activeTaskPanel.description}</p>
              <ModuleErrorBoundary moduleId={activeTaskPanel.moduleId}>
                <ActiveTaskPanel
                  libraryId={libraryId}
                  items={items}
                  scopeLabel={taskScopeLabel}
                  onRefresh={() => load(routeScopeRef.current.generation, true)}
                  onStatus={setOperationMsg} />
              </ModuleErrorBoundary>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {moveHistoryOpen && <FolderMoveDialog open items={[]} libraries={libraries} triggerRef={manageButtonRef} onClose={() => setMoveHistoryOpen(false)} onResult={() => { void load(routeScopeRef.current.generation, true) }} />}
      {currentLibrary && (
        <LibraryEditDialog
          open={editOpen}
          library={currentLibrary}
          triggerRef={manageButtonRef}
          onClose={() => setEditOpen(false)}
          onSaved={updated => { void handleLibrarySaved(updated) }}
        />
      )}
    </div>
  )
}
