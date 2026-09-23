import { describe, expect, it, vi } from 'vitest'
import type { DownloadResource, ResourcePage, ResourceQuery, SourceId } from '../shared/types'
import {
  DownloadController,
  createInitialDownloadState,
  parseDownloadPreferences,
  serializeDownloadPreferences,
} from '../client/state'
import { safeDetailUrl, safeSourceUrl } from '../client/links'
import { TEST_SOURCE_URLS } from './test-helpers'

const sourceIds: SourceId[] = ['bangumi', 'acgrip', 'dmhy', 'nyaa']

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const resource = (source: SourceId, id: string, publishedAt: string | null, title = id): DownloadResource => ({
  source,
  id,
  title,
  detailUrl: source === 'bangumi'
    ? `${TEST_SOURCE_URLS.bangumi}torrent/${'a'.repeat(24)}`
    : source === 'dmhy'
      ? `${TEST_SOURCE_URLS.dmhy}topics/view/123_Sample.html`
      : source === 'nyaa'
        ? `${TEST_SOURCE_URLS.nyaa}view/123`
        : `${TEST_SOURCE_URLS.acgrip}t/123`,
  group: null,
  size: null,
  publishedAt,
  seeders: null,
})

const page = (
  source: SourceId,
  resources: DownloadResource[],
  nextCursor: string | null = null,
  status: ResourcePage['status'] = { kind: 'success', message: 'ok' },
): ResourcePage => ({ source, resources, nextCursor, status })

describe('download client state', () => {
  it('keeps draft filters local until submit and runs only selected built-in sources', async () => {
    const fetchPage = vi.fn(async (query: ResourceQuery) => page(query.source, []))
    const controller = new DownloadController({ fetchPage })

    controller.setDraftKeyword('  葬送的芙莉莲  ')
    controller.setDraftSources(['bangumi', 'dmhy'])
    expect(fetchPage).not.toHaveBeenCalled()
    expect(controller.getState().submittedKeyword).toBe('')

    await controller.submit()
    expect(fetchPage.mock.calls.map(([query]) => query)).toEqual([
      { source: 'bangumi', keyword: '葬送的芙莉莲' },
      { source: 'dmhy', keyword: '葬送的芙莉莲' },
    ])
    expect(createInitialDownloadState().draftSources).toEqual(sourceIds)
    expect(createInitialDownloadState().submittedSources).toEqual(sourceIds)
  })

  it('filters unknown saved source ids while allowing only built-in source ids', async () => {
    const preferences = parseDownloadPreferences(JSON.stringify({
      version: 1,
      draftKeyword: '',
      draftSources: ['bangumi', 'unknown'],
      submittedKeyword: '',
      submittedSources: ['nyaa', 'unknown'],
    }))!
    expect(preferences).toMatchObject({ draftSources: ['bangumi'], submittedSources: ['nyaa'] })

    const fetchPage = vi.fn(async (query: ResourceQuery) => page(query.source, []))
    const controller = new DownloadController({ fetchPage, initialState: createInitialDownloadState(preferences) })
    expect(controller.getState().draftSources).toEqual(['bangumi'])
    controller.setDraftSources(['bangumi', 'acgrip', 'dmhy', 'nyaa'])
    expect(controller.getState().draftSources).toEqual(sourceIds)
    await controller.submit()
    expect(fetchPage.mock.calls.map(([query]) => query.source)).toEqual(sourceIds)
  })

  it('aborts an old query and ignores its late completion even when fetch ignores abort', async () => {
    const oldPage = deferred<ResourcePage>()
    const newPage = deferred<ResourcePage>()
    const signals: AbortSignal[] = []
    const fetchPage = vi.fn((query: ResourceQuery, signal: AbortSignal) => {
      signals.push(signal)
      return query.keyword === 'old' ? oldPage.promise : newPage.promise
    })
    const controller = new DownloadController({ fetchPage })
    controller.setDraftSources(['bangumi'])
    controller.setDraftKeyword('old')
    const first = controller.submit()
    controller.setDraftKeyword('new')
    const second = controller.submit()

    expect(signals[0].aborted).toBe(true)
    newPage.resolve(page('bangumi', [resource('bangumi', 'new', '2026-09-10T10:00:00Z')]))
    await second
    oldPage.resolve(page('bangumi', [resource('bangumi', 'old', '2026-09-11T10:00:00Z')]))
    await first

    expect(controller.getState().resources.map(item => item.id)).toEqual(['new'])
    expect(controller.getState().submittedKeyword).toBe('new')
  })

  it('aborts on disposal and ignores a completion after the page leaves', async () => {
    const pendingPage = deferred<ResourcePage>()
    let signal!: AbortSignal
    const controller = new DownloadController({ fetchPage: (_query, nextSignal) => {
      signal = nextSignal
      return pendingPage.promise
    } })
    controller.setDraftSources(['bangumi'])
    const pending = controller.submit()
    controller.dispose()
    expect(signal.aborted).toBe(true)
    pendingPage.resolve(page('bangumi', [resource('bangumi', 'late', '2026-09-10T00:00:00Z')]))
    await pending
    expect(controller.getState().resources).toEqual([])
  })

  it('loads restored submitted sources while preserving an explicitly empty draft', async () => {
    const preferences = parseDownloadPreferences(JSON.stringify({
      version: 1,
      draftKeyword: 'draft',
      draftSources: [],
      submittedKeyword: 'saved',
      submittedSources: ['dmhy'],
    }))!
    const fetchPage = vi.fn(async (query: ResourceQuery) => page(query.source, [resource(query.source, 'saved', null)]))
    const controller = new DownloadController({ fetchPage, initialState: createInitialDownloadState(preferences) })
    expect(controller.getState()).toMatchObject({ draftKeyword: 'draft', draftSources: [], submittedKeyword: 'saved', submittedSources: ['dmhy'] })
    expect(await controller.loadSubmitted()).toBe(true)
    expect(fetchPage.mock.calls.map(([query]) => query)).toEqual([{ source: 'dmhy', keyword: 'saved' }])
    expect(controller.getState().draftSources).toEqual([])
    expect(controller.getState().resources.map(item => item.source)).toEqual(['dmhy'])
  })

  it('merges pagination by source id, retains cross-source ids, and sorts missing times last with stable ties', async () => {
    const calls: ResourceQuery[] = []
    const fetchPage = vi.fn(async (query: ResourceQuery) => {
      calls.push(query)
      if (query.source === 'acgrip') return page('acgrip', [resource('acgrip', 'same', '2026-09-09T00:00:00Z')])
      if (!query.cursor) return page('bangumi', [
        resource('bangumi', 'tie-a', '2026-09-10T00:00:00Z'),
        resource('bangumi', 'same', '2026-09-08T00:00:00Z', 'old title'),
        resource('bangumi', 'missing', null),
      ], 'cursor-2')
      return page('bangumi', [
        resource('bangumi', 'tie-b', '2026-09-10T00:00:00Z'),
        resource('bangumi', 'same', '2026-09-11T00:00:00Z', 'updated title'),
      ])
    })
    const controller = new DownloadController({ fetchPage })
    controller.setDraftSources(['bangumi', 'acgrip'])
    await controller.submit()
    await controller.loadMore('bangumi')

    expect(calls.at(-1)).toEqual({ source: 'bangumi', keyword: '', cursor: 'cursor-2' })
    expect(controller.getState().resources.map(item => `${item.source}:${item.id}`)).toEqual([
      'bangumi:same', 'bangumi:tie-a', 'bangumi:tie-b', 'acgrip:same', 'bangumi:missing',
    ])
    expect(controller.getState().resources.find(item => item.source === 'bangumi' && item.id === 'same')?.title).toBe('updated title')
  })

  it('keeps successful rows during another source failure and retries the failed page only', async () => {
    let bangumiAttempts = 0
    const fetchPage = vi.fn(async (query: ResourceQuery) => {
      if (query.source === 'bangumi' && bangumiAttempts++ === 0) throw new Error('offline')
      return page(query.source, [resource(query.source, query.source, '2026-09-10T00:00:00Z')])
    })
    const controller = new DownloadController({ fetchPage })
    controller.setDraftSources(['bangumi', 'dmhy'])
    await controller.submit()

    expect(controller.getState().sourceStates.bangumi).toMatchObject({ phase: 'error', failedCursor: null })
    expect(controller.getState().sourceStates.dmhy.phase).toBe('success')
    expect(controller.getState().resources.map(item => item.source)).toEqual(['dmhy'])

    await controller.retry('bangumi')
    expect(controller.getState().resources.map(item => item.source)).toEqual(['dmhy', 'bangumi'])
    expect(fetchPage.mock.calls.filter(([query]) => query.source === 'bangumi')).toHaveLength(2)
  })

  it('skips a rate-limited source until retryAt, then refreshes the submitted draft without cache', async () => {
    let now = Date.parse('2026-09-10T10:00:00Z')
    const fetchPage = vi.fn(async (query: ResourceQuery) => page(query.source, [], null, {
      kind: query.refresh ? 'success' : 'rate_limited',
      message: '请求过于频繁',
      retryAt: '2026-09-10T10:01:00Z',
    }))
    const controller = new DownloadController({ fetchPage, now: () => now })
    controller.setDraftSources(['nyaa'])
    await controller.submit()
    await controller.retry('nyaa')
    await controller.refresh()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(controller.getRetryRemainingMs('nyaa')).toBe(60_000)

    now += 60_001
    controller.setDraftKeyword('new release')
    await controller.refresh()
    expect(fetchPage).toHaveBeenLastCalledWith(
      { source: 'nyaa', keyword: 'new release', refresh: true },
      expect.any(AbortSignal),
    )
  })

  it('refreshes other selected sources while one source remains rate limited', async () => {
    const retryAt = '2026-09-10T10:01:00Z'
    const calls: ResourceQuery[] = []
    const fetchPage = vi.fn(async (query: ResourceQuery) => {
      calls.push(query)
      return query.source === 'nyaa'
        ? page('nyaa', [], null, { kind: 'rate_limited', message: 'cooldown', retryAt })
        : page('dmhy', [resource('dmhy', query.refresh ? 'refreshed' : 'initial', '2026-09-10T00:00:00Z')])
    })
    const controller = new DownloadController({
      fetchPage,
      now: () => Date.parse('2026-09-10T10:00:00Z'),
    })
    controller.setDraftSources(['nyaa', 'dmhy'])
    await controller.submit()
    await controller.refresh()

    expect(calls.filter(call => call.source === 'nyaa')).toHaveLength(1)
    expect(calls.filter(call => call.source === 'dmhy')).toHaveLength(2)
    expect(calls.at(-1)).toEqual({ source: 'dmhy', keyword: '', refresh: true })
    expect(controller.getState().sourceStates.nyaa).toMatchObject({
      phase: 'rate_limited', retryAt, failedCursor: null,
    })
    expect(controller.getState().resources.map(item => item.id)).toEqual(['refreshed'])
  })

  it('round-trips preferences and explicitly loads a saved submitted session', async () => {
    const initial = createInitialDownloadState()
    const persisted = serializeDownloadPreferences({
      ...initial,
      draftKeyword: 'draft',
      draftSources: ['nyaa'],
      submittedKeyword: 'submitted',
      submittedSources: ['bangumi', 'dmhy'],
    })
    const preferences = parseDownloadPreferences(persisted)
    expect(preferences).toMatchObject({
      draftKeyword: 'draft', draftSources: ['nyaa'],
      submittedKeyword: 'submitted', submittedSources: ['bangumi', 'dmhy'],
    })
    const fetchPage = vi.fn(async (query: ResourceQuery) => page(query.source, []))
    const controller = new DownloadController({ fetchPage, initialState: createInitialDownloadState(preferences) })
    expect(controller.getState().submittedSources).toEqual(['bangumi', 'dmhy'])
    expect(await controller.loadSubmitted()).toBe(true)
    expect(fetchPage.mock.calls.map(([query]) => query)).toEqual([
      { source: 'bangumi', keyword: 'submitted' },
      { source: 'dmhy', keyword: 'submitted' },
    ])
    controller.setDraftSources(['bangumi', 'dmhy'])
    controller.setDraftKeyword('submitted')
    await controller.submit()
    expect(fetchPage.mock.calls.slice(-2).map(([query]) => query)).toEqual([
      { source: 'bangumi', keyword: 'submitted' },
      { source: 'dmhy', keyword: 'submitted' },
    ])
    expect(parseDownloadPreferences(JSON.stringify({
      version: 1, draftKeyword: '', draftSources: ['evil'], submittedKeyword: '', submittedSources: ['evil', 'nyaa'],
    }))).toMatchObject({ draftSources: [], submittedSources: ['nyaa'] })
    expect(parseDownloadPreferences('broken')).toBeNull()
    const emptySaved = JSON.stringify({
      version: 1, draftKeyword: '', draftSources: [], submittedKeyword: 'saved', submittedSources: [],
    })
    expect(parseDownloadPreferences(emptySaved)?.draftSources).toEqual([])
    expect(createInitialDownloadState(parseDownloadPreferences(emptySaved)))
      .toMatchObject({ draftSources: sourceIds, submittedSources: sourceIds })
  })

  it('accepts only configured HTTPS detail hosts and source-specific paths', () => {
    expect(safeDetailUrl('nyaa', `${TEST_SOURCE_URLS.nyaa}view/123`, TEST_SOURCE_URLS.nyaa)).toBe(`${TEST_SOURCE_URLS.nyaa}view/123`)
    expect(safeDetailUrl('nyaa', 'http://nyaa.example/view/123', TEST_SOURCE_URLS.nyaa)).toBeNull()
    expect(safeDetailUrl('nyaa', 'https://evil.example/view/123', TEST_SOURCE_URLS.nyaa)).toBeNull()
    expect(safeDetailUrl('nyaa', `${TEST_SOURCE_URLS.nyaa}search?q=123`, TEST_SOURCE_URLS.nyaa)).toBeNull()
    expect(safeDetailUrl('dmhy', `${TEST_SOURCE_URLS.dmhy}topics/view/123_title.html`, TEST_SOURCE_URLS.dmhy)).toBe(`${TEST_SOURCE_URLS.dmhy}topics/view/123_title.html`)
    expect(safeSourceUrl(TEST_SOURCE_URLS.nyaa)).toBe(TEST_SOURCE_URLS.nyaa)
  })
})
