export const DOWNLOAD_SOURCE_IDS = ['bangumi', 'acgrip', 'dmhy', 'nyaa'] as const
export type DownloadSourceId = typeof DOWNLOAD_SOURCE_IDS[number]
// Retired setting key: legacy data is preserved, hidden and never used for requests.
export const DOWNLOAD_SOURCES_KEY = 'download_sources_v1'
export class InvalidDownloadSources extends Error {}
/** Syntax-only validation for built-in origins and displayed links. */
export function normalizeDownloadRoot(raw: string): string {
  if (raw === '') return ''
  if (raw.length > 2048 || raw !== raw.trim() || /[\x00-\x20\x7f\\?#@]/.test(raw)) throw new InvalidDownloadSources('请输入不含账号、参数或片段的 HTTPS 根地址')
  const match = /^https:\/\/([^/:]+)\/?$/i.exec(raw)
  if (!match) throw new InvalidDownloadSources('仅允许 HTTPS 站点根地址，不支持端口或路径')
  let url: URL
  try { url = new URL(raw) } catch { throw new InvalidDownloadSources('站点地址格式无效') }
  const host = url.hostname
  if (host.length > 253 || !host.includes('.') || host.endsWith('.') || /^\d+(?:\.\d+)*$/.test(host)
    || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|onion|arpa)$/.test(host)) {
    throw new InvalidDownloadSources('仅支持公网域名，不支持本机、内网或特殊地址')
  }
  return url.origin + '/'
}
