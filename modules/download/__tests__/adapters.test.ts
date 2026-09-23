import { describe, expect, it } from 'vitest'
import { buildRequest, isVerificationPage, parsePage, ParseError } from '../server/adapters'
import { DownloadService } from '../server/service'
import { TEST_SOURCE_URLS } from './test-helpers'

const bangumiId = '0123456789abcdef01234567'
const bangumiBase = TEST_SOURCE_URLS.bangumi
const acgBase = TEST_SOURCE_URLS.acgrip
const dmhyBase = TEST_SOURCE_URLS.dmhy
const nyaaBase = TEST_SOURCE_URLS.nyaa
const collectionTitle = '[SampleGroup] Sample Series Batch [01-12] [1080p]'

const bangumiJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  success: true,
  page_count: 2,
  torrents: [{
    _id: bangumiId,
    category_tag_id: '549ef207fe682f7549f1ea90',
    title: collectionTitle,
    team: { name: 'SampleGroup' },
    size: '1.5 GB',
    publish_time: '2026-09-04T04:04:52.701Z',
    seeders: 0,
    ...overrides,
  }],
})

const acgHtml = (options: { id?: string; title?: string; next?: boolean } = {}) => `
  <table class="post-index">
    <thead><tr><th>发布者</th><th>标题</th><th>DL</th><th>大小</th></tr></thead>
    <tbody><tr>
      <td><a href="/team/1">SampleGroup</a></td>
      <td><a href="/t/${options.id ?? '362381'}">${options.title ?? collectionTitle}</a></td>
      <td>download</td><td class="size">1.5 GiB</td>
      <td><time datetime="2026-09-04T04:04:53Z">2026-09-04</time></td>
      <td class="seeders"></td>
    </tr></tbody>
  </table>
  ${options.next ? '<a rel="next" href="/1/page/2">Next</a>' : ''}
`

const dmhyHtml = (options: { categoryId?: string; categoryLabel?: string; next?: boolean; relative?: boolean } = {}) => `
  <table id="topic_list">
    <thead><tr><th>时间</th><th>类别</th><th>标题</th><th>磁力</th><th>大小</th><th>做种</th></tr></thead>
    <tbody><tr>
      <td>${options.relative ? '3 小时前 ' : ''}<span class="hidden-date">2026/09/04 12:04</span></td>
      <td><a href="/topics/list/sort_id/${options.categoryId ?? '31'}">${options.categoryLabel ?? '季度全集'}</a></td>
      <td><a href="/team/1">SampleGroup</a><a href="/topics/view/726303_Sample_Series.html">${collectionTitle}</a></td>
      <td><a href="magnet:?xt=urn:btih:synthetic">磁力</a></td>
      <td>1.5GB</td><td>0</td>
    </tr></tbody>
  </table>
  ${options.next ? '<a rel="next" href="/topics/list/page/2?keyword=Sample">下一页</a>' : ''}
`

const nyaaHtml = (next = false) => `
  <table class="torrent-list">
    <thead><tr><th>Category</th><th>Name</th><th>Comments</th><th>Size</th><th>Date</th><th>Seeders</th></tr></thead>
    <tbody><tr>
      <td><a href="/?c=1_2">Anime</a></td>
      <td><a href="/view/2156087" title="Sample &amp; Series">Sample &amp; Series</a></td>
      <td></td><td>1.5 GiB</td><td data-timestamp="1788494693">date</td><td>0</td>
    </tr></tbody>
  </table>
  ${next ? '<a rel="next" href="/?c=1_0&amp;p=2">Next</a>' : ''}
`

describe('public list parsing with synthetic responses', () => {
  it('reads a Bangumi collection, preserves multilingual text and real zero', () => {
    const result = parsePage('bangumi', bangumiJson(), 1, bangumiBase)
    expect(result.resources).toEqual([{
      source: 'bangumi', id: bangumiId, title: collectionTitle,
      detailUrl: `${bangumiBase}torrent/${bangumiId}`, group: 'SampleGroup', size: '1.5 GB',
      publishedAt: '2026-09-04T04:04:52.701Z', seeders: 0, isCollection: true,
    }])
    expect(result.nextPage).toBe(2)
    expect(buildRequest('bangumi', 'Sample Group', 3, bangumiBase).body).toEqual({ query: 'Sample Group', p: 3 })
    expect(buildRequest('bangumi', '', 1, bangumiBase).url).toBe(`${bangumiBase}api/torrent/latest`)
  })

  it('reads ACG.RIP category rows, decodes entities, and follows a synthetic next page', () => {
    const result = parsePage('acgrip', acgHtml({ next: true }), 1, acgBase)
    expect(result.resources[0]).toMatchObject({
      source: 'acgrip', id: '362381', title: collectionTitle,
      detailUrl: `${acgBase}t/362381`, group: 'SampleGroup', size: '1.5 GiB',
      publishedAt: '2026-09-04T04:04:53.000Z', seeders: null, isCollection: true,
    })
    expect(result.nextPage).toBe(2)
    expect(buildRequest('acgrip', 'Sample', 2, acgBase, false, '5').url)
      .toBe(`${acgBase}5/page/2?term=Sample`)
  })

  it('reads DMHY collection rows and retains the absolute time behind a relative label', () => {
    const result = parsePage('dmhy', dmhyHtml({ relative: true, next: true }), 1, dmhyBase)
    expect(result.resources[0]).toMatchObject({
      source: 'dmhy', id: '726303', title: collectionTitle,
      detailUrl: `${dmhyBase}topics/view/726303_Sample_Series.html`, group: 'SampleGroup',
      size: '1.5GB', publishedAt: '2026-09-04T04:04:00.000Z', seeders: 0, isCollection: true,
    })
    expect(result.nextPage).toBe(2)
    const singleEpisode = dmhyHtml({ categoryId: '2', categoryLabel: '動畫' }).replace(collectionTitle, '[SampleGroup] Sample Series - 03 [1080p]')
    expect(parsePage('dmhy', singleEpisode, 1, dmhyBase).resources[0].isCollection).toBe(false)
  })

  it('handles Nyaa HTML and RSS with explicit anime categories and zero seeders', () => {
    const html = parsePage('nyaa', nyaaHtml(true), 1, nyaaBase)
    expect(html).toMatchObject({
      resources: [{ source: 'nyaa', id: '2156087', title: 'Sample & Series', detailUrl: `${nyaaBase}view/2156087`, seeders: 0, size: '1.5 GiB' }],
      nextPage: 2,
    })
    const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.example/xmlns/nyaa"><channel>
      <item><title>Sample &amp; Series</title><guid>${nyaaBase}view/2156087</guid>
      <pubDate>Fri, 04 Sep 2026 04:04:53 GMT</pubDate><nyaa:categoryId>1_2</nyaa:categoryId>
      <nyaa:size>1.5 GiB</nyaa:size><nyaa:seeders>0</nyaa:seeders></item>
      <item><title>Audio</title><guid>${nyaaBase}view/99</guid><nyaa:categoryId>2_0</nyaa:categoryId></item>
    </channel></rss>`
    expect(parsePage('nyaa', rss, 1, nyaaBase)).toMatchObject({
      resources: [{ title: 'Sample & Series', seeders: 0, group: null, isCollection: false }], nextPage: null,
    })
  })

  it('filters non-animation categories while retaining next-page evidence', () => {
    const data = JSON.parse(bangumiJson({ category_tag_id: '549ef222fe682f7549f1ea91' }))
    expect(parsePage('bangumi', JSON.stringify(data), 1, bangumiBase)).toEqual({ resources: [], nextPage: 2 })
    expect(parsePage('dmhy', dmhyHtml({ categoryId: '3', categoryLabel: '漫画', next: true }), 1, dmhyBase))
      .toEqual({ resources: [], nextPage: 2 })
  })

  it('does not infer a Bangumi collection from a generic episode title', () => {
    const data = JSON.parse(bangumiJson({
      title: '[Group] Sample Series - 03 [1080p]',
      team: undefined,
      size: undefined,
      publish_time: undefined,
      seeders: undefined,
    }))
    expect(parsePage('bangumi', JSON.stringify(data), 1, bangumiBase).resources[0]).toMatchObject({
      group: null, size: null, publishedAt: null, seeders: null, isCollection: false,
    })
  })

  it('identifies verification and malformed responses as failures, not empty search results', () => {
    for (const html of ['<title>Just a moment...</title>', '<script src="/cdn-cgi/challenge-platform/test"></script>', '<h1>Verify you are human</h1>']) {
      expect(isVerificationPage(html)).toBe(true)
      expect(() => parsePage('acgrip', html, 1, acgBase)).toThrow(ParseError)
    }
    expect(() => parsePage('bangumi', '{"torrents":[{"changedTitle":"Sample"}]}', 1, bangumiBase)).toThrow(ParseError)
    expect(() => parsePage('acgrip', '<table class="post-index"><tr><td>service error</td></tr></table>', 1, acgBase)).toThrow(ParseError)
    expect(() => parsePage('dmhy', '<html><h1>Backend unavailable</h1></html>', 1, dmhyBase)).toThrow(ParseError)
    expect(() => parsePage('nyaa', '<rss><channel><item><title>Sample</title><nyaa:categoryId>1_2</nyaa:categoryId></item></channel></rss>', 1, nyaaBase)).toThrow(ParseError)
    expect(parsePage('acgrip', '<table class="post-index"><thead><tr><th>发布者</th><th>标题</th><th>DL</th><th>大小</th></tr></thead><tbody></tbody></table>', 1, acgBase))
      .toEqual({ resources: [], nextPage: null })
  })

  it('deduplicates within source and advances only ACG categories with next-page evidence', async () => {
    const paths: string[] = []
    const service = new DownloadService({ transport: async request => {
      const pathname = new URL(request.url).pathname
      paths.push(pathname)
      return { status: 200, body: pathname === '/1' ? acgHtml({ next: true }) : acgHtml() }
    } })
    const first = await service.resources({ source: 'acgrip', keyword: 'Sample' })
    expect(first.resources).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = await service.resources({ source: 'acgrip', keyword: 'Sample', cursor: first.nextCursor! })
    expect(paths).toEqual(['/1', '/5', '/1/page/2'])
    expect(second.nextCursor).toBeNull()
    service.dispose()
  })
})
