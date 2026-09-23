import { describe, expect, it, vi } from 'vitest'
import type { DownloadResource, ResourcePage } from '../shared/types'
import { DEFAULT_DOWNLOAD_VIEW, parseSizeBytes, selectDownloadResources } from '../client/presentation'
import { createInitialDownloadState, DownloadController, parseDownloadPreferences, serializeDownloadPreferences } from '../client/state'
import { TEST_SOURCE_URLS } from './test-helpers'

const resource = (id: string, fields: Partial<DownloadResource> = {}): DownloadResource => ({
  source: 'nyaa', id, title: id, detailUrl: `${TEST_SOURCE_URLS.nyaa}view/${id}`,
  group: null, size: null, publishedAt: null, seeders: null, ...fields,
})
const ids = (rows: DownloadResource[]) => rows.map(row => row.id)

describe('download result presentation', () => {
  it('converts decimal and binary units without treating unknown sizes as zero', () => {
    expect(parseSizeBytes('1 GB')).toBe(1_000_000_000)
    expect(parseSizeBytes('1 GiB')).toBe(1_073_741_824)
    expect(parseSizeBytes('1,024 KiB')).toBe(1_048_576)
    expect(parseSizeBytes('1.5 tb')).toBe(1_500_000_000_000)
    expect(parseSizeBytes('0 B')).toBe(0)
    for (const size of [null, '', '—', 'unknown', '-1 GB', '12 monkeys']) expect(parseSizeBytes(size)).toBeNull()
  })

  it('sorts mixed sizes numerically, leaves missing values last in either direction, and keeps ties stable', () => {
    const rows = [resource('unknown'), resource('gb', { size: '1 GB' }), resource('gib', { size: '1 GiB' }),
      resource('mb', { size: '900 MB' }), resource('tie', { size: '1000 MB' })]
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'size' }))).toEqual(['gib', 'gb', 'tie', 'mb', 'unknown'])
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'size', sortDirection: 'asc' }))).toEqual(['mb', 'gb', 'tie', 'gib', 'unknown'])
    expect(ids(rows)).toEqual(['unknown', 'gb', 'gib', 'mb', 'tie'])
  })

  it('sorts timezones by instant and keeps zero seeders ahead of missing counts', () => {
    const rows = [resource('missing'), resource('old', { publishedAt: '2026-09-10T10:00:00+08:00', seeders: 0 }),
      resource('new', { publishedAt: '2026-09-10T03:00:00Z', seeders: 12 }), resource('invalid', { publishedAt: 'not a date' })]
    expect(ids(selectDownloadResources(rows, DEFAULT_DOWNLOAD_VIEW))).toEqual(['new', 'old', 'missing', 'invalid'])
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'seeders', sortDirection: 'asc' }))).toEqual(['old', 'new', 'missing', 'invalid'])
  })

  it('sorts titles naturally and sources by visible names, and does not infer an unconfirmed collection on the client', () => {
    const rows = [resource('10', { title: 'Anime 10', source: 'dmhy', group: 'Z', isCollection: true }),
      resource('2', { title: 'Anime 2', source: 'nyaa', group: 'A' }), resource('batch', { title: 'Batch', group: '' })]
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'title', sortDirection: 'asc' }))).toEqual(['2', '10', 'batch'])
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'group', sortDirection: 'asc' }))).toEqual(['2', '10', 'batch'])
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, sortKey: 'source', sortDirection: 'asc' }, [
      { id: 'dmhy', name: 'Z source', url: TEST_SOURCE_URLS.dmhy },
      { id: 'nyaa', name: 'A source', url: TEST_SOURCE_URLS.nyaa },
    ]))).toEqual(['2', 'batch', '10'])
    expect(ids(selectDownloadResources(rows, { ...DEFAULT_DOWNLOAD_VIEW, collectionsOnly: true }))).toEqual(['10'])
  })

  it('keeps view changes local and applies them to later pages, updates and deduplication', async () => {
    const fetchPage = vi.fn(async (query): Promise<ResourcePage> => ({ source: 'nyaa', status: { kind: 'success', message: 'ok' },
      nextCursor: query.cursor ? null : 'page2', resources: query.cursor
        ? [resource('1', { size: '2 GB', isCollection: true }), resource('3', { size: '3 GB', isCollection: true })]
        : [resource('1', { size: '1 GB', isCollection: true }), resource('2', { size: '9 GB' })] }))
    const controller = new DownloadController({ fetchPage })
    controller.setDraftSources(['nyaa'])
    await controller.submit()
    controller.toggleSort('size')
    controller.setCollectionsOnly(true)
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(ids(selectDownloadResources(controller.getState().resources, controller.getState()))).toEqual(['1'])
    await controller.loadMore('nyaa')
    expect(ids(selectDownloadResources(controller.getState().resources, controller.getState()))).toEqual(['3', '1'])
    expect(controller.getState().resources).toHaveLength(3)
    controller.toggleSort('size')
    expect(controller.getState().sortDirection).toBe('asc')
    controller.toggleSort('title')
    expect(controller.getState().sortDirection).toBe('asc')
    const restored = createInitialDownloadState(parseDownloadPreferences(serializeDownloadPreferences(controller.getState())))
    expect(restored).toMatchObject({ sortKey: 'title', sortDirection: 'asc', collectionsOnly: true })
    controller.dispose()
  })

  it('restores old sessions and repairs only invalid new preferences', () => {
    const old = { version: 1, draftKeyword: 'draft', submittedKeyword: 'saved', draftSources: [], submittedSources: ['nyaa'] }
    expect(createInitialDownloadState(parseDownloadPreferences(JSON.stringify(old)))).toMatchObject(DEFAULT_DOWNLOAD_VIEW)
    expect(parseDownloadPreferences(JSON.stringify({ ...old, sortKey: 'bogus', sortDirection: 'sideways', collectionsOnly: 'false' })))
      .toMatchObject({ ...DEFAULT_DOWNLOAD_VIEW, submittedKeyword: 'saved' })
  })
})
