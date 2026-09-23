import { createHash } from 'node:crypto'
import { normalizeDownloadRoot } from '../../../shared/download-sources'
import { SOURCE_IDS, type SourceId, type ResourceQuery } from '../shared/types'

export class InvalidQuery extends Error {}
export class InvalidLink extends Error {}

export function parseQuery(query: Record<string, unknown>): ResourceQuery {
  if (typeof query.source !== 'string' || !SOURCE_IDS.includes(query.source as SourceId)) throw new InvalidQuery('来源无效')
  if (query.keyword !== undefined && typeof query.keyword !== 'string') throw new InvalidQuery('关键词无效')
  const keyword = String(query.keyword ?? '').trim()
  if (keyword.length > 200 || /[\x00-\x1f\x7f]/.test(keyword)) throw new InvalidQuery('关键词过长或含控制字符')
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) throw new InvalidQuery('分页游标无效')
  if (query.refresh !== undefined && query.refresh !== '1' && query.refresh !== '0') throw new InvalidQuery('刷新参数无效')
  if (Object.keys(query).some(key => !['source', 'keyword', 'cursor', 'refresh'].includes(key))) throw new InvalidQuery('不支持的查询参数')
  const result = { source: query.source as SourceId, keyword, cursor: query.cursor as string | undefined, refresh: query.refresh === '1' }
  return result
}
const queryKey = (source: SourceId, keyword: string, revision: string) => createHash('sha256').update(JSON.stringify([source, keyword, revision])).digest('hex').slice(0, 24)
export function encodeCursor(source: SourceId, keyword: string, page: number, revision = ''): string {
  return Buffer.from(JSON.stringify({ v: 1, k: queryKey(source, keyword, revision), p: page })).toString('base64url')
}
export function encodeAcgCursor(keyword: string, pages: [number | null, number | null], revision = ''): string | null {
  if (pages.every(page => page === null)) return null
  return Buffer.from(JSON.stringify({ v: 1, k: queryKey('acgrip', keyword, revision), p: Math.max(...pages.map(page => page ?? 0)), a: pages })).toString('base64url')
}
export function acgPages(query: ResourceQuery, revision = ''): [number | null, number | null] {
  if (!query.cursor) return [1, 1]
  decodeCursor(query, revision)
  return JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')).a
}
export function decodeCursor(query: ResourceQuery, revision = ''): number {
  if (!query.cursor) return 1
  try {
    if (!/^[a-zA-Z0-9_-]{1,512}$/.test(query.cursor)) throw new Error()
    const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
    if (value.v !== 1 || value.k !== queryKey(query.source, query.keyword, revision) || !Number.isSafeInteger(value.p) || value.p < 2 || value.p > 1000000) throw new Error()
    if (query.source === 'acgrip' && (!Array.isArray(value.a) || value.a.length !== 2 || value.a.every((p: unknown) => p === null) || value.a.some((p: unknown) => p !== null && (!Number.isSafeInteger(p) || Number(p) < 2 || Number(p) > 1000000)))) throw new Error()
    return value.p
  } catch { throw new InvalidQuery('分页游标与当前来源或关键词不匹配') }
}

export function siteUrl(source: SourceId, raw: string, baseUrl: string): URL {
  if (!raw || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) throw new InvalidLink('链接无效')
  const base = normalizeDownloadRoot(baseUrl)
  if (!base) throw new InvalidLink('来源地址无效')
  let url: URL
  try { url = new URL(raw, base) } catch { throw new InvalidLink('链接无效') }
  if (url.protocol !== 'https:' || url.hostname !== new URL(base).hostname || url.port || url.username || url.password || url.hash) throw new InvalidLink('链接不在允许的 HTTPS 站点内')
  return url
}

export function detailUrl(source: SourceId, raw: string, baseUrl: string): string | null {
  try {
    const url = siteUrl(source, raw, baseUrl)
    if (/%(?:[01][\da-f]|7f|2f|5c|25)/i.test(url.pathname)) return null
    const patterns: Record<SourceId, RegExp> = {
      bangumi: /^\/torrent\/[a-f\d]{24}$/i,
      acgrip: /^\/t\/\d+$/,
      dmhy: /^\/topics\/view\/\d+_[^/]+\.html$/,
      nyaa: /^\/view\/\d+$/,
    }
    if (!patterns[source].test(url.pathname) || url.search) return null
    return url.href
  } catch { return null }
}

/** Checks every hop; no caller-supplied host, path, HTTP method or body reaches transport. */
export function requestUrl(source: SourceId, raw: string, method: 'GET' | 'POST', baseUrl: string): URL {
  const url = siteUrl(source, raw, baseUrl)
  const allowed: Record<SourceId, RegExp> = {
    bangumi: method === 'POST' ? /^\/api\/v2\/torrent\/search$/ : /^\/api\/torrent\/(latest|page\/\d+)$/,
    acgrip: /^\/[15](?:\/page\/\d+)?$/,
    dmhy: /^\/topics\/list(?:\/page\/\d+)?$/,
    nyaa: /^\/$/,
  }
  if ((source !== 'bangumi' && method !== 'GET') || !allowed[source].test(url.pathname)) throw new InvalidLink('请求路径不在允许列表内')
  const keys: Record<SourceId, string[]> = {
    bangumi: [], acgrip: ['term'], dmhy: ['keyword', 'sort_id', 'page'],
    nyaa: ['f', 'c', 'q', 'p', 'page'],
  }
  for (const key of url.searchParams.keys()) {
    if (!keys[source].includes(key) || url.searchParams.getAll(key).length !== 1) throw new InvalidLink('请求参数不在允许列表内')
  }
  return url
}
