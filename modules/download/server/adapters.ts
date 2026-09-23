import { load, type CheerioAPI } from 'cheerio'
import type { DownloadResource, SourceId } from '../shared/types'
import { classifyCollection } from '../shared/collections'
import { detailUrl, siteUrl } from './security'
import type { ListRequest } from './transport'

export class ParseError extends Error {}
export function isVerificationPage(body: string): boolean {
  return /(?:cf-chl-|challenge-platform|challenges\.cloudflare\.com|<title>\s*(?:Just a moment|Attention Required|验证|驗證)|checking your browser|verify (?:that )?you are human|人机验证|人機驗證|访问验证|訪問驗證|DDoS-Guard|anubis_challenge)/i.test(body)
}
export function buildRequest(source: SourceId, keyword: string, page: number, baseUrl: string, rss = false, category: '1' | '5' = '1'): ListRequest {
  const url = new URL(baseUrl)
  if (source === 'bangumi') {
    url.pathname = keyword ? '/api/v2/torrent/search' : page === 1 ? '/api/torrent/latest' : `/api/torrent/page/${page}`
    return { source, baseUrl, url: url.href, method: keyword ? 'POST' : 'GET', ...(keyword ? { body: { query: keyword, p: page } } : {}) }
  }
  if (source === 'acgrip') {
    url.pathname = `/${category}${page > 1 ? `/page/${page}` : ''}`
    if (keyword) url.searchParams.set('term', keyword)
  } else if (source === 'dmhy') {
    url.pathname = '/topics/list'
    if (page > 1) url.pathname += `/page/${page}`
    if (keyword) url.searchParams.set('keyword', keyword)
  } else if (source === 'nyaa') {
    url.searchParams.set('f', '0'); url.searchParams.set('c', '1_0')
    if (keyword) url.searchParams.set('q', keyword)
    if (rss) url.searchParams.set('page', 'rss')
    else if (page > 1) url.searchParams.set('p', String(page))
  }
  return { source, baseUrl, url: url.href, method: 'GET' }
}

const clean = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
function timestamp(value: unknown, zone = ''): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = typeof value === 'string' && zone && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(value.trim()) ? value.trim().replace(' ', 'T') + zone : value
  const date = typeof normalized === 'number' ? normalized : Date.parse(normalized)
  return Number.isFinite(date) ? new Date(date).toISOString() : null
}
function nextHtmlPage($: CheerioAPI, source: SourceId, page: number, baseUrl: string): number | null {
  const next: number[] = []
  $('a[href]').each((_index, element) => {
    const link = $(element)
    const label = link.text().trim()
    if (link.attr('rel') !== 'next' && !/^(?:下一[页頁]|下[页頁]|Next(?: »)?|›|»|→|Older.*)$/i.test(label) && !link.parent().hasClass('next')) return
    if (link.parent().hasClass('disabled') || link.attr('aria-disabled') === 'true') return
    try {
      const url = siteUrl(source, link.attr('href')!, baseUrl)
      const raw = source === 'nyaa' ? url.searchParams.get('p') : url.pathname.match(/\/page\/(\d+)$/)?.[1] ?? url.searchParams.get('page')
      const number = Number(raw)
      if (Number.isSafeInteger(number) && number > page && number <= 1000000) next.push(number)
    } catch { /* Ignore untrusted cross-site navigation. */ }
  })
  return next.length ? Math.min(...next) : null
}

function bangumi(body: string, page: number, baseUrl: string) {
  let data: any
  try { data = JSON.parse(body) } catch { throw new ParseError() }
  if (!data || data.success === false || !Array.isArray(data.torrents)) throw new ParseError()
  const resources: DownloadResource[] = []
  for (const row of data.torrents) {
    if (!row || typeof row !== 'object' || typeof row.category_tag_id !== 'string') throw new ParseError()
    // This public category is animation, including anime batches; no title heuristics.
    if (!['549ef207fe682f7549f1ea90', '54967e14ff43b99e284d0bf7'].includes(row.category_tag_id)) continue
    const title = clean(row.title), url = detailUrl('bangumi', `/torrent/${row._id}`, baseUrl)
    if (!title || !url) throw new ParseError()
    resources.push({ source: 'bangumi', id: row._id, title, detailUrl: url,
      group: clean(row.team?.name ?? row.team_name), size: clean(row.size),
      publishedAt: timestamp(row.publish_time), seeders: numeric(row.seeders), isCollection: classifyCollection(title),
    })
  }
  const count = numeric(data.page_count)
  if (count === null) throw new ParseError()
  return { resources, nextPage: page < count ? page + 1 : null }
}

function htmlList(source: 'acgrip' | 'dmhy' | 'nyaa', body: string, page: number, baseUrl: string) {
  const $ = load(body)
  const table = source === 'dmhy' ? $('#topic_list') : source === 'nyaa' ? $('table.torrent-list') : $('table.post-index')
  if (!table.length) {
    // Only an explicit known empty-state message is a successful empty response.
    if (/没有找到|沒有找到|No results found|没有符合|沒有符合/.test($('body').text())) return { resources: [], nextPage: nextHtmlPage($, source, page, baseUrl) }
    throw new ParseError()
  }
  const headers = table.find('th').map((_index, element) => clean($(element).text())).get()
  if (source === 'acgrip') {
    // ACG.RIP represents a genuine zero-match search as an empty table with this
    // exact header schema (no separate empty-state marker).
    if (headers.join('|') !== '发布者|标题|DL|大小') throw new ParseError()
  } else if (!headers.length) throw new ParseError()
  const resources: DownloadResource[] = []
  const rows = table.find('tbody tr').length ? table.find('tbody tr') : table.find('tr').slice(1)
  for (const element of rows.toArray()) {
    const row = $(element), cells = row.find('td')
    if (!cells.length) continue
    let allowed = false, sourceConfirmedCollection = false, raw: string | undefined, title: string | null = null, group: string | null = null, size: string | null = null, publishedAt: string | null = null, seeders: number | null = null
    if (source === 'dmhy') {
      const category = cells.eq(1).find('a').first()
      const categoryId = category.attr('href')?.match(/sort_id[=/](\d+)/)?.[1]
      allowed = ['2', '31'].includes(categoryId ?? '') || /^(?:動畫|动画|季度全集|動畫合集|动画合集)$/.test(category.text().trim())
      sourceConfirmedCollection = categoryId === '31' || /^(?:季度全集|動畫合集|动画合集)$/.test(category.text().trim())
      const link = cells.eq(2).find('a[href*="/topics/view/"]').first()
      raw = link.attr('href'); title = clean(link.text())
      group = clean(cells.eq(2).find('a[href*="team_id"], a[href*="team/"]').first().text())
      size = clean(cells.eq(4).text())
      // Recent rows show a relative label but keep the sortable absolute date in
      // a hidden span. Read the date text without executing the site's scripts.
      const absoluteDate = cells.eq(0).text().match(/\d{4}[/-]\d{2}[/-]\d{2}\s+\d{2}:\d{2}(?::\d{2})?/)?.[0]
      publishedAt = timestamp(absoluteDate?.replace(/\//g, '-'), '+08:00')
      seeders = numeric(cells.eq(5).text().trim())
    } else if (source === 'nyaa') {
      const category = cells.eq(0).find('a').attr('href') ?? ''
      allowed = /(?:[?&]c=1_|\?c=1_)/.test(category)
      const link = cells.eq(1).find('a[href*="/view/"]').filter((_index, element) => !$(element).hasClass('comments') && !$(element).attr('href')?.includes('#')).last()
      raw = link.attr('href'); title = clean(link.attr('title') ?? link.text())
      size = clean(cells.eq(3).text())
      const seconds = numeric(cells.eq(4).attr('data-timestamp'))
      publishedAt = seconds === null ? timestamp(clean(cells.eq(4).text()), '+00:00') : timestamp(seconds * 1000)
      seeders = numeric(cells.eq(5).text().trim())
    } else {
      // Only /1 (animation) and /5 (collections) are requested. The public rows
      // have no category field; classification comes from these scoped endpoints.
      allowed = true
      const link = row.find('a[href^="/t/"]').first()
      raw = link.attr('href'); title = clean(link.text())
      group = clean(row.find('a[href^="/team/"]').first().text())
      size = clean(row.find('.size').text())
      const seconds = numeric(row.find('time').attr('datetime'))
      publishedAt = seconds === null ? timestamp(row.find('time').attr('datetime')) : timestamp(seconds * 1000)
      seeders = numeric(row.find('.seeders').text().trim())
    }
    if (!allowed) {
      if (source === 'dmhy' && !cells.eq(1).find('a[href*="sort_id"]').length) throw new ParseError()
      if (source === 'nyaa' && !cells.eq(0).find('a[href*="c="]').length) throw new ParseError()
      continue
    }
    if (!raw || !title) throw new ParseError()
    const url = detailUrl(source, raw, baseUrl)
    if (!url) throw new ParseError()
    const id = new URL(url).pathname.match(/(?:\/t\/|\/view\/|\/topics\/view\/)(\d+)/)?.[1]
    if (!id) continue
    resources.push({ source, id, title, detailUrl: url, group, size, publishedAt, seeders, isCollection: classifyCollection(title, sourceConfirmedCollection) })
  }
  return { resources, nextPage: nextHtmlPage($, source, page, baseUrl) }
}

function rssList(body: string, baseUrl: string) {
  const $ = load(body, { xmlMode: true })
  if (!$('rss > channel').length) throw new ParseError()
  const resources: DownloadResource[] = []
  $('item').each((_index, element) => {
    const row = $(element)
    const category = row.find('nyaa\\:categoryId').text().trim()
    if (!/^\d_\d$/.test(category)) throw new ParseError()
    if (!/^1_/.test(category)) return
    const url = detailUrl('nyaa', row.find('guid').text().trim(), baseUrl)
    const title = clean(row.find('title').text())
    if (!url || !title) throw new ParseError()
    resources.push({ source: 'nyaa', id: new URL(url).pathname.split('/').pop()!, title, detailUrl: url,
      group: null, size: clean(row.find('nyaa\\:size').text()), publishedAt: timestamp(row.find('pubDate').text()), seeders: numeric(row.find('nyaa\\:seeders').text().trim()), isCollection: classifyCollection(title) })
  })
  // RSS is a finite feed and publishes no next-page link; HTML supplies pagination.
  return { resources, nextPage: null }
}

export function parsePage(source: SourceId, body: string, page: number, baseUrl: string) {
  if (isVerificationPage(body)) throw new ParseError('Verification required')
  if (source === 'bangumi') return bangumi(body, page, baseUrl)
  if (source === 'nyaa' && /<rss[\s>]/.test(body)) return rssList(body, baseUrl)
  return htmlList(source, body, page, baseUrl)
}
