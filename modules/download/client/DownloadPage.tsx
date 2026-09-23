import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { alternateDownloadPath, readDownloadSearch } from '../../../shared/download-navigation'
import { useModuleEnabled } from '../../../src/modules/registry'
import { hasSurfaceSelection, isSurfaceAction } from '../../../src/lib/surfaceAction'
import { ChevronDownIcon, RefreshIcon, SearchIcon } from '../../../src/components/ui/Icons'
import { DOWNLOAD_SOURCES } from '../shared/sources'
import { SOURCE_IDS, type DownloadResource, type DownloadSource, type SourceId } from '../shared/types'
import { fetchDownloadPage, fetchDownloadSources } from './api'
import { safeDetailUrl, safeSourceUrl } from './links'
import { DOWNLOAD_SORT_COLUMNS, selectDownloadResources } from './presentation'
import {
  DOWNLOAD_SESSION_KEY,
  DownloadController,
  createInitialDownloadState,
  parseDownloadPreferences,
  serializeDownloadPreferences,
  type ClientSourceState,
  type DownloadClientState,
} from './state'
import './download.css'
import './content-first.css'

function readInitialState(): DownloadClientState {
  if (typeof window === 'undefined') return createInitialDownloadState()
  try {
    return createInitialDownloadState(parseDownloadPreferences(window.sessionStorage.getItem(DOWNLOAD_SESSION_KEY)))
  } catch {
    return createInitialDownloadState()
  }
}

function formatPublishedAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function retryRemaining(retryAt: string | undefined, now: number): number {
  if (!retryAt) return 0
  const target = Date.parse(retryAt)
  return Number.isFinite(target) ? Math.max(0, target - now) : 0
}

function countdownLabel(remaining: number): string {
  const seconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')} 后可重试` : `${seconds} 秒后可重试`
}

function phaseLabel(state: ClientSourceState): string {
  switch (state.phase) {
    case 'idle': return '等待'
    case 'loading': return '请求中'
    case 'success': return '已返回'
    case 'restricted': return '访问受限'
    case 'rate_limited': return '已限流'
    case 'error': return '失败'
  }
}

function sourceMap(sources: DownloadSource[]): Record<SourceId, DownloadSource> {
  const byId = new Map(sources.map(source => [source.id, source]))
  return Object.fromEntries(DOWNLOAD_SOURCES.map(fallback => [fallback.id, byId.get(fallback.id) ?? fallback])) as Record<SourceId, DownloadSource>
}

function ResourceTitle({ resource, baseUrl }: { resource: DownloadResource; baseUrl: string }) {
  const href = safeDetailUrl(resource.source, resource.detailUrl, baseUrl)
  if (!href) return <span>{resource.title}</span>
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (hasSurfaceSelection(event.currentTarget)) event.preventDefault()
  }}>{resource.title}</a>
}

export default function DownloadPage() {
  const location = useLocation()
  const wishlistEnabled = useModuleEnabled('season')
  const routeSearch = useMemo(() => readDownloadSearch(location.search), [location.search])
  const alternatePath = alternateDownloadPath(location.search)
  const [state, setState] = useState<DownloadClientState>(readInitialState)
  const stateRef = useRef(state)
  const controllerRef = useRef<DownloadController | null>(null)
  const [sources, setSources] = useState<DownloadSource[]>(DOWNLOAD_SOURCES)
  const [sourcesError, setSourcesError] = useState('')
  const [filterError, setFilterError] = useState('')
  const [channelsOpen, setChannelsOpen] = useState(false)
  const channelToggleRef = useRef<HTMLButtonElement>(null)
  const [now, setNow] = useState(Date.now)
  const sourcesById = useMemo(() => sourceMap(sources), [sources])
  const visibleResources = useMemo(() => selectDownloadResources(state.resources, state, sources),
    [state.resources, state.sortKey, state.sortDirection, state.collectionsOnly, sources])
  stateRef.current = state

  useEffect(() => {
    const sourceController = new AbortController()
    const controller = new DownloadController({
      fetchPage: fetchDownloadPage,
      initialState: stateRef.current,
      onChange: next => {
        stateRef.current = next
        setState(next)
        try { window.sessionStorage.setItem(DOWNLOAD_SESSION_KEY, serializeDownloadPreferences(next)) } catch { /* Session persistence is optional. */ }
      },
    })
    controllerRef.current = controller
    if (routeSearch) {
      controller.setDraftKeyword(routeSearch.keyword)
      if (!stateRef.current.draftSources.length) controller.setDraftSources(stateRef.current.submittedSources)
      void controller.submit()
    } else {
      void controller.loadSubmitted()
    }
    void fetchDownloadSources(sourceController.signal).then(next => {
      if (!sourceController.signal.aborted) {
        setSources(next.filter(source => SOURCE_IDS.includes(source.id)))
        setSourcesError('')
      }
    }).catch(error => {
      if (!sourceController.signal.aborted) setSourcesError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      sourceController.abort()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [location.key, routeSearch])

  useEffect(() => {
    const hasCountdown = SOURCE_IDS.some(source => retryRemaining(state.sourceStates[source].retryAt, now) > 0)
    if (!hasCountdown) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [now, state.sourceStates])

  const loading = state.submittedSources.some(source => state.sourceStates[source].phase === 'loading')
  const completed = state.submittedSources.length > 0 && state.submittedSources.every(source => state.sourceStates[source].phase !== 'idle' && state.sourceStates[source].phase !== 'loading')
  const successfulSources = state.submittedSources.filter(source => state.sourceStates[source].phase === 'success')
  const failedSources = state.submittedSources.filter(source => ['restricted', 'rate_limited', 'error'].includes(state.sourceStates[source].phase))
  const loadableSources = state.submittedSources.filter(source => {
    const sourceState = state.sourceStates[source]
    return sourceState.phase === 'success' && Boolean(sourceState.nextCursor)
  })
  const sourcesChanged = SOURCE_IDS.some(source => state.draftSources.includes(source) !== state.submittedSources.includes(source))
  const showChannels = () => {
    setChannelsOpen(true)
    channelToggleRef.current?.focus()
  }
  const submit = () => {
    if (!state.draftSources.length) {
      setFilterError('请至少选择一个来源。')
      showChannels()
      return
    }
    setFilterError('')
    void controllerRef.current?.submit()
  }

  const refresh = () => {
    if (!state.draftSources.length) {
      setFilterError('请至少选择一个来源。')
      return
    }
    setFilterError('')
    void controllerRef.current?.refresh()
  }

  const toggleSource = (source: SourceId) => {
    const next = state.draftSources.includes(source)
      ? state.draftSources.filter(item => item !== source)
      : SOURCE_IDS.filter(item => item === source || state.draftSources.includes(item))
    controllerRef.current?.setDraftSources(next)
    if (next.length) setFilterError('')
  }

  return (
    <div className="download-page page-shell clean-page clean-download-page">
      <header className="download-toolbar clean-toolbar clean-page-header clean-download-header">
        <h1 className="page-title">下载</h1>
        <form className="download-search clean-download-search" role="search" aria-label="搜索资源" onSubmit={event => { event.preventDefault(); submit() }}>
          <label className="desktop-search-shell download-keyword-shell">
            <span className="sr-only">关键词</span>
            <SearchIcon width={14} height={14} className="desktop-search-icon" />
            <input
              id="download-keyword"
              className="desktop-search-control w-full pl-8 text-sm"
              value={state.draftKeyword}
              maxLength={200}
              placeholder="搜索资源，留空查看最新发布"
              onChange={event => controllerRef.current?.setDraftKeyword(event.target.value)}
            />
          </label>
          <button className="btn-primary desktop-search-button" type="submit">
            <SearchIcon width={16} height={16} />
            搜索
          </button>
        </form>
        <div className="download-toolbar-actions clean-download-actions">
          <div className="download-channel-control">
            <button
              ref={channelToggleRef}
              type="button"
              className="btn-ghost download-channel-toggle"
              aria-expanded={channelsOpen}
              aria-controls="download-channels"
              aria-describedby={sourcesChanged ? 'download-pending' : undefined}
              onClick={() => setChannelsOpen(open => !open)}>
              <span>渠道 · 已选 {state.draftSources.length}</span>
              <ChevronDownIcon width={14} height={14} />
            </button>
            {sourcesChanged && <span id="download-pending" className="download-pending" role="status">待搜索生效</span>}
          </div>
          <button
            type="button"
            className="btn-ghost download-refresh"
            onClick={refresh}
            disabled={!state.draftSources.length}
            title="忽略缓存并刷新">
            <RefreshIcon width={16} height={16} />
            <span>刷新</span>
          </button>
        </div>
      </header>

      {filterError && <p className="download-inline-error" role="alert">{filterError}</p>}
      {sourcesError && <p className="download-inline-error" role="alert">来源说明读取失败：{sourcesError}</p>}

      <section
        id="download-channels"
        className="download-channels ui-panel-subtle clean-download-channel-panel"
        aria-label="渠道选择与请求状态"
        hidden={!channelsOpen}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setChannelsOpen(false)
            channelToggleRef.current?.focus()
          }
        }}>
        <fieldset className="download-source-filter">
          <legend className="sr-only">搜索渠道</legend>
          <div className="download-channels-head clean-section-header">
            <span>搜索渠道</span>
            <span>本次查询状态 · 修改勾选后点击搜索</span>
          </div>
          {SOURCE_IDS.map(source => {
            const sourceState = state.sourceStates[source]
            const info = sourcesById[source]
            const submitted = state.submittedSources.includes(source)
            const remaining = retryRemaining(sourceState.retryAt, now)
            const canRetry = submitted && ['restricted', 'rate_limited', 'error'].includes(sourceState.phase)
            const count = state.resources.filter(resource => resource.source === source).length
            return (
              <div key={source} className="download-source-row clean-download-source-row" data-phase={submitted ? sourceState.phase : 'idle'}>
                <label className="download-source-option">
                  <input
                    type="checkbox"
                    checked={state.draftSources.includes(source)}
                    onChange={() => toggleSource(source)}
                  />
                  <span>{info.name}</span>
                </label>
                <span className="download-phase"><i aria-hidden="true" />{submitted ? phaseLabel(sourceState) : '未参与'}</span>
                <span className="download-source-count">{submitted ? `${count} 条${sourceState.cached ? ' · 缓存' : ''}` : '—'}</span>
                <p className="download-source-message">
                  {submitted && <span>{sourceState.message || '等待请求'}</span>}
                  {info.note && <small>{info.note}</small>}
                </p>
                <div className="download-source-actions">
                  {safeSourceUrl(info.url) && <a href={safeSourceUrl(info.url)} target="_blank" rel="noopener noreferrer">原站</a>}
                  {submitted && sourceState.phase === 'success' && sourceState.nextCursor && (
                    <button type="button" onClick={() => void controllerRef.current?.loadMore(source)}>加载更多</button>
                  )}
                  {canRetry && (
                    <button
                      type="button"
                      disabled={remaining > 0}
                      onClick={() => void controllerRef.current?.retry(source)}>
                      {remaining > 0 ? countdownLabel(remaining) : '重试'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </fieldset>
      </section>

      <section className="download-results ui-panel clean-section clean-download-results" aria-labelledby="download-results-title" aria-busy={loading}>
        <div className="download-results-head clean-section-header">
          <div className="download-results-heading">
            <div className="download-results-label">
              <h2 id="download-results-title">资源</h2>
              <span className="download-result-count">{visibleResources.length} 条{state.collectionsOnly ? ` / 已加载 ${state.resources.length} 条` : ''}</span>
              <span className="download-status-summary" aria-live="polite">
                {(loading || failedSources.length > 0) && (
                  <button type="button" className="download-status-button" onClick={() => setChannelsOpen(open => !open)} aria-expanded={channelsOpen} aria-controls="download-channels">
                    {loading && <span className="download-progress"><i aria-hidden="true" />加载中</span>}
                    {failedSources.length > 0 && <span className="download-failed-count">{failedSources.length} 个渠道异常</span>}
                    <ChevronDownIcon width={12} height={12} />
                  </button>
                )}
              </span>
            </div>
            <div className="download-results-context">
              <p title={state.submittedKeyword || undefined}>{state.submittedKeyword ? `“${state.submittedKeyword}”` : '最新发布'}</p>
              {routeSearch?.fromWishlist && wishlistEnabled && <Link to="/favorites" className="download-context-link">返回心愿单</Link>}
              {alternatePath && <Link to={alternatePath} className="download-context-link download-alternate" title={`换名搜索：${routeSearch?.alternate}`}>换名搜索：{routeSearch?.alternate}</Link>}
            </div>
          </div>
          <div className="download-results-actions">
            <div className="download-kind-filter clean-download-tabs" role="group" aria-label="资源类型">
              <button type="button" aria-pressed={!state.collectionsOnly} onClick={() => controllerRef.current?.setCollectionsOnly(false)}>全部</button>
              <button type="button" aria-pressed={state.collectionsOnly} onClick={() => controllerRef.current?.setCollectionsOnly(true)}>只看合集</button>
            </div>
            {loadableSources.length > 0 && (
              <button
                type="button"
                className="btn-ghost"
                title={`从 ${loadableSources.length} 个来源加载下一页`}
                onClick={() => void Promise.all(loadableSources.map(source => controllerRef.current?.loadMore(source)))}>
                全部加载更多
              </button>
            )}
          </div>
        </div>

        {visibleResources.length > 0 ? (
          <div className="download-table-wrap clean-download-table" tabIndex={0} role="region" aria-label="资源列表">
            <table>
              <thead>
                <tr>
                  {DOWNLOAD_SORT_COLUMNS.map(([key, label]) => (
                    <th key={key} scope="col" aria-sort={state.sortKey === key ? state.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}>
                      <button type="button" className="download-sort" onClick={() => controllerRef.current?.toggleSort(key)}
                        aria-label={`按${label}排序，当前${state.sortKey === key ? state.sortDirection === 'asc' ? '升序' : '降序' : '未排序'}，点击切换`}>
                        {label}<span aria-hidden="true">{state.sortKey === key ? state.sortDirection === 'asc' ? '↑' : '↓' : '↕'}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleResources.map(resource => (
                  <tr key={`${resource.source}:${resource.id}`}
                    className={safeDetailUrl(resource.source, resource.detailUrl, sourcesById[resource.source].url) ? 'download-resource-row' : undefined}
                    onClick={event => {
                      if (isSurfaceAction(event)) event.currentTarget.querySelector<HTMLAnchorElement>('.download-title a')?.click()
                    }}>
                    <td className="download-title"><ResourceTitle resource={resource} baseUrl={sourcesById[resource.source].url} /></td>
                    <td>{sourcesById[resource.source].name}</td>
                    <td>{resource.group ?? '—'}</td>
                    <td>{resource.size ?? '—'}</td>
                    <td><time dateTime={resource.publishedAt ?? undefined} title={resource.publishedAt ?? undefined}>{formatPublishedAt(resource.publishedAt)}</time></td>
                    <td>{resource.seeders === null ? '—' : resource.seeders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="download-empty clean-state">
            <p>{state.collectionsOnly && state.resources.length > 0
              ? '已加载资源中暂无明确合集'
              : loading
              ? '正在等待各站返回结果…'
              : successfulSources.length > 0
                ? `已返回的渠道没有找到匹配资源${failedSources.length ? `，另有 ${failedSources.length} 个渠道未成功。` : '。'}`
                : completed
                  ? '所选渠道均未成功返回，可查看状态并重试。'
                  : '准备查询资源。'}</p>
            {state.collectionsOnly && <button type="button" className="btn-ghost" onClick={() => controllerRef.current?.setCollectionsOnly(false)}>查看全部资源</button>}
            <button type="button" className="btn-ghost" onClick={showChannels} aria-expanded={channelsOpen} aria-controls="download-channels">查看渠道状态</button>
          </div>
        )}
      </section>
    </div>
  )
}
