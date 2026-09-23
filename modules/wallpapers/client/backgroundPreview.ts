const OWNER_HEADERS = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

export function revokePreviewObjectUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
  else if (url?.startsWith('/api/background/video-preview/')) {
    void fetch(url, { method: 'DELETE', headers: OWNER_HEADERS }).catch(() => undefined)
  }
}

export function replacePreviewObjectUrl(previous: string | null, next: string | null): string | null {
  if (previous && previous !== next) revokePreviewObjectUrl(previous)
  return next
}

export async function fetchBackgroundPreview(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/background/preview', {
    method: 'POST',
    headers: OWNER_HEADERS,
    body: JSON.stringify({ path }),
    signal,
  })
  if (!response.ok) {
    const parsed = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
    const error = new Error(typeof parsed?.error === 'string' ? parsed.error : `HTTP ${response.status}`) as Error & { status?: number; code?: string }
    error.status = response.status
    if (typeof parsed?.code === 'string') error.code = parsed.code
    throw error
  }
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('预览响应不是图片')
  return URL.createObjectURL(blob)
}

export async function fetchVideoPreview(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/background/video-preview', {
    method: 'POST', headers: OWNER_HEADERS, body: JSON.stringify({ path }), signal,
  })
  const result = await response.json() as { url?: string; error?: string }
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
  if (!result.url?.startsWith('/api/background/video-preview/')) throw new Error('视频预览地址无效')
  return result.url
}

