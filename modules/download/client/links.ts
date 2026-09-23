import { normalizeDownloadRoot } from '../../../shared/download-sources'
import type { SourceId } from '../shared/types'

const DETAIL_PATHS: Record<SourceId, RegExp> = {
  bangumi: /^\/torrent\/[a-f\d]{24}$/i,
  acgrip: /^\/t\/\d+$/,
  dmhy: /^\/topics\/view\/\d+_[^/]+\.html$/,
  nyaa: /^\/view\/\d+$/,
}

function checkedUrl(source: SourceId, raw: string, baseUrl: string): URL | null {
  if (!raw || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) return null
  try {
    const expected = new URL(normalizeDownloadRoot(baseUrl))
    const url = new URL(raw)
    if (
      url.protocol !== 'https:'
      || url.hostname !== expected.hostname
      || Boolean(url.port || url.username || url.password || url.hash)
    ) return null
    return url
  } catch {
    return null
  }
}

export function safeDetailUrl(source: SourceId, raw: string, baseUrl: string): string | null {
  const url = checkedUrl(source, raw, baseUrl)
  if (url && /%(?:[01][\da-f]|7f|2f|5c|25)/i.test(url.pathname)) return null
  if (!url || url.search || !DETAIL_PATHS[source].test(url.pathname)) return null
  return url.href
}

export function safeSourceUrl(baseUrl: string): string | undefined {
  try { return normalizeDownloadRoot(baseUrl) || undefined } catch { return undefined }
}
