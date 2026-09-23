import { describe, it, expect, vi, afterEach } from 'vitest'
import { EverythingClient, parseDateModified } from '../everything'

afterEach(() => { vi.unstubAllGlobals() })

describe('parseDateModified', () => {
  it('converts FILETIME string (100ns since 1601) to unix seconds', () => {
    // 实测样本：134285936321588154 ≈ 2026-07-15
    expect(parseDateModified('134285936321588154')).toBe(1784120032)
  })
  it('converts numeric FILETIME and date-time strings', () => {
    expect(parseDateModified(134285936321588154)).toBe(1784120032)
    expect(parseDateModified('2024-01-01 12:00:00')).toBe(1704081600) // 本地时区（UTC+8）解析
  })
  it('returns null for empty/missing values', () => {
    expect(parseDateModified(null)).toBeNull()
    expect(parseDateModified(undefined)).toBeNull()
    expect(parseDateModified('')).toBeNull()
    expect(parseDateModified('not-a-date')).toBeNull()
  })
})

function jsonResponse(results: unknown[], totalResults: unknown = results.length): Response {
  return { ok: true, status: 200, json: async () => ({ results, totalResults }) } as unknown as Response
}

describe('EverythingClient', () => {
  it('joins path (parent dir) + name into full path and maps fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { path: 'D:\\Anime', name: 'a.mkv', size: 1234, date_modified: '134285936321588154' },
      { path: 'D:\\Anime', name: 'b.mp4', size: '999', date_modified: null },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EverythingClient('http://localhost:1223')
    const files = await client.searchFiles('D:\\Anime')

    expect(files).toEqual([
      { path: 'D:\\Anime\\a.mkv', size: 1234, dateModified: 1784120032 },
      { path: 'D:\\Anime\\b.mp4', size: 999, dateModified: null }, // 字符串 size 解析为数字；缺失 date → null
    ])
    const called = fetchMock.mock.calls[0][0] as string
    expect(called).toContain('search=file%3A+path%3A%22D%3A%5CAnime%22')
    expect(called).toContain('count=1024')
  })

  it('paginates with offset and stops at short page', async () => {
    const big = Array.from({ length: 1024 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(big, 1025))
      .mockResolvedValueOnce(jsonResponse([{ path: 'D:\\Anime', name: 'last.mkv' }], 1025))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EverythingClient('http://localhost:1223')
    const files = await client.searchFiles('D:\\Anime')

    expect(files).toHaveLength(1025)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondUrl = fetchMock.mock.calls[1][0] as string
    expect(secondUrl).toContain('offset=1024')
  })

  it('rejects when server keeps returning the same full page (offset ignored)', async () => {
    const big = Array.from({ length: 1024 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` }))
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(big, 2048))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EverythingClient('http://localhost:1223')
    await expect(client.searchFiles('D:\\Anime')).rejects.toMatchObject({
      code: 'EVERYTHING_QUERY_INCOMPLETE', retryable: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses totalResults to return all 2500 rows across same-parent pages', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(rows.slice(0, 1024), '2500'))
      .mockResolvedValueOnce(jsonResponse(rows.slice(1024, 2048), '2500'))
      .mockResolvedValueOnce(jsonResponse(rows.slice(2048), '2500'))
    vi.stubGlobal('fetch', fetchMock)

    const files = await new EverythingClient('http://localhost:1223').searchFiles('D:\\Anime')

    expect(files).toHaveLength(2500)
    expect(files.at(-1)?.path).toBe('D:\\Anime\\f2499.mkv')
    expect(fetchMock.mock.calls.map(call => String(call[0]).match(/offset=(\d+)/)?.[1])).toEqual(['0', '1024', '2048'])
  })

  it.each([
    ['missing total', [{ ok: true, status: 200, json: async () => ({ results: [] }) } as unknown as Response]],
    ['malformed total', [jsonResponse([], 'many')]],
    ['changing total', [jsonResponse(Array.from({ length: 1024 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` })), 1025), jsonResponse([{ path: 'D:\\Anime', name: 'last.mkv' }], 1026)]],
    ['early empty page', [jsonResponse(Array.from({ length: 1024 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` })), 1025), jsonResponse([], 1025)]],
    ['early short page', [jsonResponse([{ path: 'D:\\Anime', name: 'only.mkv' }], 2)]],
    ['overflow', [jsonResponse([{ path: 'D:\\Anime', name: 'a.mkv' }, { path: 'D:\\Anime', name: 'b.mkv' }], 1)]],
    ['page cap', [jsonResponse(Array.from({ length: 1024 }, (_, i) => ({ path: 'D:\\Anime', name: `f${i}.mkv` })), 1024 * 512 + 1)]],
  ])('rejects incomplete pagination: %s', async (_label, responses) => {
    const fetchMock = vi.fn()
    for (const response of responses as Response[]) fetchMock.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(new EverythingClient('http://localhost:1223').searchFiles('D:\\Anime')).rejects.toMatchObject({
      code: 'EVERYTHING_QUERY_INCOMPLETE', retryable: true,
    })
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const client = new EverythingClient('http://localhost:1223')
    await expect(client.searchFiles('D:\\Anime')).rejects.toThrow('Everything HTTP 500')
  })

  it('filters out paths outside the root (wildcard over-match and ancestors)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([
        { path: 'D:\\Anime', name: 'a.mkv', size: '100' },
        { path: 'D:\\AnimeX', name: 'b.mkv', size: '100' }, // 兄弟目录（通配符误匹配）
        { path: 'D:\\', name: 'root.mkv', size: '' }, // root 祖先
        { path: 'E:\\Other', name: 'c.mkv', size: '100' }, // 无关路径
      ]))
      .mockResolvedValueOnce(jsonResponse([
        { path: 'D:\\Anime', name: 'sub' },
        { path: 'D:\\AnimeX', name: 'sub2' }, // 兄弟目录
        { path: 'D:\\', name: 'root' }, // root 祖先
      ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new EverythingClient('http://localhost:1223')

    const files = await client.searchFiles('D:\\Anime')
    expect(files.map(f => f.path)).toEqual(['D:\\Anime\\a.mkv'])

    const folders = await client.searchFolders('D:\\Anime')
    expect(folders).toEqual(['D:\\Anime\\sub'])
  })

  it('dedupes repeated paths from wildcard over-match', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { path: 'D:\\Anime', name: 'a.mkv', size: '1' },
      { path: 'D:\\Anime', name: 'a.mkv', size: '1' }, // Everything 通配符展开返回重复
      { path: 'D:\\Anime', name: 'a.mkv', size: '1' },
      { path: 'D:\\Anime', name: 'b.mkv', size: '2' },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new EverythingClient('http://localhost:1223')
    const files = await client.searchFiles('D:\\Anime')
    expect(files.map(f => f.path)).toEqual(['D:\\Anime\\a.mkv', 'D:\\Anime\\b.mkv'])
  })

  it('filters out non-video files (audio/image/subtitle) via ext whitelist', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { path: 'D:\\Anime', name: 'real.mkv', size: '1' },
      { path: 'D:\\Anime', name: 'cover.jpg', size: '2' }, // 图片
      { path: 'D:\\Anime', name: 'ost.flac', size: '3' }, // 音频
      { path: 'D:\\Anime', name: 'subs.ass', size: '4' }, // 字幕
      { path: 'D:\\Anime', name: 'scans.png', size: '5' }, // 图片
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new EverythingClient('http://localhost:1223')
    const files = await client.searchFiles('D:\\Anime')
    // 只有视频扩展名通过白名单；图片/音频/字幕全部过滤
    expect(files.map(f => f.path)).toEqual(['D:\\Anime\\real.mkv'])
  })

  it('filters out empty paths from searchFolders', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ path: 'D:\\', name: 'Anime' }, { path: '', name: '' }])))
    const client = new EverythingClient('http://localhost:1223')
    expect(await client.searchFolders('D:\\Anime')).toEqual(['D:\\Anime'])
  })
})
