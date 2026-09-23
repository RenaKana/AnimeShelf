import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleRuntime } from '../../../server/core/module-runtime'

const dbState = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; name: string; source: string | null; anilist_id: number | null }>,
  canonicalRows: [] as Array<Record<string, unknown>>,
}))

const mockedDb = vi.hoisted(() => ({
  prepare: vi.fn((sql: string) => ({
    all: () => sql.includes('folder_media_mappings') ? dbState.canonicalRows : dbState.rows,
    finalize: () => undefined,
  })),
}))

vi.mock('../../../server/db/instance', () => ({ db: mockedDb }))

describe('wishlist media-library matching', () => {
  beforeEach(async () => {
    dbState.rows = []
    dbState.canonicalRows = []
    vi.resetModules()
    const { bindModuleRuntime } = await import('../../../server/core/extensions')
    bindModuleRuntime(mockedDb as any, {
      isActive: (id: string) => id === 'media-catalog',
      capability: () => undefined,
      afterRestore: async () => {},
    } as unknown as ModuleRuntime)
  })

  it('uses the stored Bangumi id even when the favorite item id is not source-prefixed', async () => {
    dbState.rows = [{ id: 42, name: '媒体库目录', source: 'bangumi', anilist_id: 123456 }]
    const { detectLibHit } = await import('../server/libhit')

    const hit = (detectLibHit as (...args: unknown[]) => unknown)(
      'calendar-md5-item',
      '完全不同的原名',
      '完全不同的中文名',
      { bangumiId: '123456' },
    )

    expect(hit).toEqual({ matched: true, method: 'id', folderName: '媒体库目录', folderId: 42 })
  })

  it('can force a fresh database read instead of reusing the folder cache', async () => {
    dbState.rows = [{ id: 1, name: '无关目录', source: 'bangumi', anilist_id: 1 }]
    const { detectLibHit } = await import('../server/libhit')
    const call = detectLibHit as (...args: unknown[]) => unknown

    expect(call('calendar-item', '目标番剧', null, { bangumiId: '999' }, false)).toBeNull()
    dbState.rows = [{ id: 9, name: '目标番剧目录', source: 'bangumi', anilist_id: 999 }]

    expect(call('calendar-item', '目标番剧', null, { bangumiId: '999' }, true)).toEqual({
      matched: true,
      method: 'id',
      folderName: '目标番剧目录',
      folderId: 9,
    })
  })

  it('uses the AniList link id when the media-library folder is bound to AniList', async () => {
    dbState.rows = [{ id: 77, name: 'AniList 媒体库目录', source: 'anilist', anilist_id: 198376 }]
    const { detectLibHit } = await import('../server/libhit')

    const hit = (detectLibHit as (...args: unknown[]) => unknown)(
      'calendar-md5-item',
      '完全不同的原名',
      '完全不同的中文名',
      { anilistId: 198376 },
    )

    expect(hit).toEqual({ matched: true, method: 'id', folderName: 'AniList 媒体库目录', folderId: 77 })
  })

  it('matches manually-added TMDB favorites by their source-prefixed item id', async () => {
    dbState.rows = [{ id: 88, name: 'TMDB 媒体库目录', source: 'tmdb', anilist_id: 77338 }]
    const { detectLibHit } = await import('../server/libhit')

    const hit = detectLibHit('manual-tmdb-77338', '完全不同的原名', null)

    expect(hit).toEqual({ matched: true, method: 'id', folderName: 'TMDB 媒体库目录', folderId: 88 })
  })

  it('uses the TMDB link id for non-prefixed legacy favorites', async () => {
    dbState.rows = [{ id: 99, name: 'TMDB 旧收藏目录', source: 'tmdb', anilist_id: 300112 }]
    const { detectLibHit } = await import('../server/libhit')

    const hit = detectLibHit('calendar-md5-item', '完全不同的原名', null, { tmdbId: 300112 })

    expect(hit).toEqual({ matched: true, method: 'id', folderName: 'TMDB 旧收藏目录', folderId: 99 })
  })

  it('returns related when only a secondary id matches a pinned collection', async () => {
    dbState.canonicalRows = [{
      folder_id: 7,
      folder_name: 'JOJO的奇妙冒险 石之海',
      folder_path: 'D:\\Anime\\JOJO的奇妙冒险\\石之海',
      root_folder_id: 3,
      root_pinned: 1,
      media_item_id: 70,
      item_title: 'JOJO的奇妙冒险 石之海',
      item_title_zh: null,
      source: 'bangumi',
      external_id: '43558',
      kind: 'season',
      conflict_reason: null,
      confidence: 1,
    }]
    const { detectLibStatus } = await import('../server/libhit')

    const result = detectLibStatus(
      'manual-bangumi-551918',
      'JoJo no Kimyou na Bouken',
      null,
      { bangumiIds: [551918, 43558] },
    )

    expect(result.status).toBe('related')
    expect(result.hit).toEqual({ matched: false, method: 'id', folderName: 'JOJO的奇妙冒险 石之海', folderId: 7 })
  })

  it('prioritizes the primary id over a related id even when both match', async () => {
    dbState.canonicalRows = [
      {
        folder_id: 7,
        folder_name: '关联条目',
        folder_path: 'D:\\Anime\\合集\\关联条目',
        root_folder_id: 3,
        root_pinned: 1,
        media_item_id: 70,
        item_title: '关联条目',
        item_title_zh: null,
        source: 'bangumi',
        external_id: '43558',
        kind: 'season',
        conflict_reason: null,
        confidence: 1,
      },
      {
        folder_id: 8,
        folder_name: '目标条目',
        folder_path: 'D:\\Anime\\合集\\目标条目',
        root_folder_id: 3,
        root_pinned: 1,
        media_item_id: 80,
        item_title: '目标条目',
        item_title_zh: null,
        source: 'bangumi',
        external_id: '551918',
        kind: 'season',
        conflict_reason: null,
        confidence: 1,
      },
    ]
    const { detectLibStatus } = await import('../server/libhit')

    expect(detectLibStatus('manual-bangumi-551918', '目标条目', null, { bangumiIds: [551918, 43558] })).toMatchObject({
      status: 'present',
      hit: { matched: true, folderId: 8 },
    })
  })

  it('distinguishes absent from unknown when the primary id is missing', async () => {
    const { detectLibStatus } = await import('../server/libhit')

    expect(detectLibStatus('manual-bangumi-999', '不存在的条目', null, { bangumiIds: [999] }).status).toBe('absent')
    expect(detectLibStatus('calendar-md5-item', '没有身份的条目', null).status).toBe('unknown')
  })

  it('keeps a strict ambiguous or unknown title candidate in the unknown state', async () => {
    dbState.canonicalRows = [{
      folder_id: 9,
      folder_name: '标题候选',
      folder_path: 'D:\\Anime\\标题候选',
      root_folder_id: 9,
      root_pinned: 0,
      media_item_id: 90,
      item_title: '标题候选',
      item_title_zh: null,
      source: null,
      external_id: null,
      kind: 'unknown',
      conflict_reason: '目录名与文件名冲突',
      confidence: 0.25,
    }]
    const { detectLibStatus } = await import('../server/libhit')

    expect(detectLibStatus('calendar-md5-item', '标题候选', null).status).toBe('unknown')
  })

  it('falls back to an exact unique named item when its catalog mapping is valid', async () => {
    dbState.canonicalRows = [{
      folder_id: 10,
      folder_name: '严格同名条目',
      folder_path: 'D:\\Anime\\严格同名条目',
      root_folder_id: 10,
      root_pinned: 0,
      media_item_id: 100,
      item_title: '严格同名条目',
      item_title_zh: null,
      source: 'bangumi',
      external_id: '123',
      kind: 'season',
      conflict_reason: null,
      confidence: 0.99,
    }]
    const { detectLibStatus } = await import('../server/libhit')

    expect(detectLibStatus('manual-bangumi-999', '严格同名条目', null, { bangumiIds: [999] })).toMatchObject({
      status: 'present',
      hit: { matched: true, method: 'name', folderId: 10 },
    })
  })
})
