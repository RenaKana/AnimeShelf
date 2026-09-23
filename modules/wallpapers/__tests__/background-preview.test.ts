import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBackgroundPreview, fetchVideoPreview, replacePreviewObjectUrl, revokePreviewObjectUrl } from '../client/backgroundPreview'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('background preview client', () => {
  it('creates and releases a streaming preview without downloading the full video', async () => {
    const url = '/api/background/video-preview/session'
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ url }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchVideoPreview('C:\\video.mp4')).resolves.toBe(url)
    replacePreviewObjectUrl(url, null)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/background/video-preview', 'POST'], [url, 'DELETE'],
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ path: 'C:\\video.mp4' })
  })

  it('rejects remote addresses returned as a temporary video preview', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ url: 'https://example.test/video' }))))
    await expect(fetchVideoPreview('C:\\video.mp4')).rejects.toThrow('视频预览地址无效')
  })

  it('posts an explicit path with the local-owner header and returns an object URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (..._args: Parameters<typeof fetch>) => new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1')

    await expect(fetchBackgroundPreview('C:\\Pictures\\background.png')).resolves.toBe('blob:preview-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/background/preview')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('X-AnimeShelf-Owner')).toBe('1')
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual({ path: 'C:\\Pictures\\background.png' })
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
  })

  it('keeps server preview errors available to the settings message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ error: '文件不是有效的图片', code: 'IMAGE_INVALID' }), {
      status: 415,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(fetchBackgroundPreview('C:\\Pictures\\notes.txt')).rejects.toMatchObject({ status: 415, code: 'IMAGE_INVALID' })
  })

  it('revokes only preview object URLs when replacing or disposing them', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    expect(replacePreviewObjectUrl('blob:old', 'blob:new')).toBe('blob:new')
    expect(replacePreviewObjectUrl('https://saved.example/background.jpg', 'blob:newer')).toBe('blob:newer')
    revokePreviewObjectUrl('blob:final')
    revokePreviewObjectUrl('https://saved.example/background.jpg')

    expect(revoke.mock.calls).toEqual([['blob:old'], ['blob:final']])
  })
})
