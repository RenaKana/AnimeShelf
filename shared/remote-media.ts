export function remoteMediaSrc(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const remoteUrl = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^\/\/[^/?#\\\s]/.test(trimmed)
      ? (typeof window !== 'undefined' && window.location.protocol === 'http:' ? 'http:' : 'https:') + trimmed
      : ''
  if (remoteUrl) {
    try { return '/api/remote-media?url=' + encodeURIComponent(new URL(remoteUrl).href) }
    catch { return '/api/remote-media?url=' + encodeURIComponent(remoteUrl) }
  }
  return value
}
