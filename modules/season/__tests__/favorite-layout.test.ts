import { describe, expect, it } from 'vitest'
import {
  FAVORITE_CARD_WIDTH_MAX,
  FAVORITE_CARD_WIDTH_MIN,
  FAVORITE_CARD_WIDTH_STEP,
  favoriteItemIdForCandidate,
  favoriteMediaDomain,
  favoriteMediaDomainLabel,
  favoritePayloadFromCandidate,
  filterFavoriteEntries,
  formatFavoriteBeginDate,
  getFavoriteLibraryStatusPresentation,
  getFavoriteCardLayout,
  getFavoriteSynopsisLines,
  isFavoriteEditorDirty,
  isFavoriteCandidateAdded,
  isFavoriteEditorSessionCurrent,
  metadataCandidateSource,
  normalizeFavoriteCardWidth,
  resolvedFavoriteAnimeStatus,
  selectFavoriteDraftAfterRefresh,
  selectRefreshedFavorite,
  sortFavoriteEntries,
} from '../client/favoriteLayout'

describe('favorite layout helpers', () => {
  it('maps automatic and manual media-library states to visible results', () => {
    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: null,
      lib_hit: { matched: true, method: 'id', folderName: '番剧', folderId: 1 },
    })).toEqual({
      label: '已收录',
      tone: 'success',
      mode: 'auto',
      ariaLabel: '媒体库状态：自动判断，已收录',
      folder: '番剧',
    })

    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: null,
      lib_status: 'related',
      lib_hit: { matched: false, method: 'id', folderName: '合集条目', folderId: 2 },
    })).toEqual({
      label: '同系列已有',
      tone: 'info',
      mode: 'auto',
      ariaLabel: '媒体库状态：自动判断，同系列已有',
      folder: '合集条目',
    })

    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: null,
      lib_status: 'absent',
      lib_hit: null,
    })).toEqual({
      label: '未收录',
      tone: 'neutral',
      mode: 'auto',
      ariaLabel: '媒体库状态：自动判断，未收录',
      folder: null,
    })

    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: null,
      lib_status: 'unknown',
      lib_hit: null,
    })).toEqual({
      label: '待确认',
      tone: 'warning',
      mode: 'auto',
      ariaLabel: '媒体库状态：自动判断，待确认',
      folder: null,
    })

    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: 'present',
      lib_hit: null,
    })).toEqual({
      label: '已收录',
      tone: 'warning',
      mode: 'manual',
      ariaLabel: '媒体库状态：手动标记为已收录',
      folder: null,
    })

    expect(getFavoriteLibraryStatusPresentation({
      lib_match_override: 'absent',
      lib_hit: { matched: true, method: 'manual', folderName: null, folderId: null },
    })).toEqual({
      label: '未收录',
      tone: 'warning',
      mode: 'manual',
      ariaLabel: '媒体库状态：手动标记为未收录',
      folder: null,
    })
  })

  it('normalizes saved card widths to the supported range and step', () => {
    expect(normalizeFavoriteCardWidth(257)).toBe(260)
    expect(normalizeFavoriteCardWidth(FAVORITE_CARD_WIDTH_MIN - 1)).toBe(FAVORITE_CARD_WIDTH_MIN)
    expect(normalizeFavoriteCardWidth(FAVORITE_CARD_WIDTH_MAX + 1)).toBe(FAVORITE_CARD_WIDTH_MAX)
    expect(normalizeFavoriteCardWidth(Number.NaN)).toBe(260)
    expect(FAVORITE_CARD_WIDTH_STEP).toBe(10)
  })

  it('uses four, three, and two synopsis lines as cards become compact', () => {
    expect(getFavoriteSynopsisLines(260)).toBe(4)
    expect(getFavoriteSynopsisLines(220)).toBe(3)
    expect(getFavoriteSynopsisLines(180)).toBe(2)
  })

  it('hides secondary card information only in the dense layout', () => {
    expect(getFavoriteCardLayout(260)).toEqual({
      density: 'comfortable',
      synopsisLines: 4,
      showOriginalTitle: true,
      showProgress: true,
    })
    expect(getFavoriteCardLayout(220)).toEqual({
      density: 'compact',
      synopsisLines: 3,
      showOriginalTitle: false,
      showProgress: true,
    })
    expect(getFavoriteCardLayout(180)).toEqual({
      density: 'dense',
      synopsisLines: 2,
      showOriginalTitle: false,
      showProgress: false,
    })
  })

  it('reconciles an open editor with the refreshed favorite record', () => {
    const current = { item_id: 'favorite-1', synopsis: '旧简介', image: 'old.jpg' }
    const refreshed = [
      { item_id: 'favorite-1', synopsis: '新简介', image: 'new.jpg' },
      { item_id: 'favorite-2', synopsis: '其他条目', image: 'other.jpg' },
    ]

    expect(selectRefreshedFavorite(current, refreshed)).toEqual(refreshed[0])
    expect(selectRefreshedFavorite(current, null)).toBe(current)
  })

  it('keeps an unsaved synopsis draft when refreshed metadata arrives', () => {
    expect(selectFavoriteDraftAfterRefresh('用户草稿', '旧简介', '抓取后的简介')).toBe('用户草稿')
    expect(selectFavoriteDraftAfterRefresh('旧简介', '旧简介', '抓取后的简介')).toBe('抓取后的简介')
  })

  it('detects unsaved editor fields before closing', () => {
    const favorite = { synopsis: '原简介', lib_match_override: null }
    expect(isFavoriteEditorDirty(favorite, '新简介', 'auto')).toBe(true)
    expect(isFavoriteEditorDirty(favorite, '原简介', 'present')).toBe(true)
    expect(isFavoriteEditorDirty(favorite, ' 原简介 ', 'auto')).toBe(false)
  })

  it('treats an explicit media-domain choice as editor state and keeps unknown visible', () => {
    expect(favoriteMediaDomain({ media_domain: undefined })).toBe('unknown')
    expect(favoriteMediaDomainLabel({ media_domain: undefined })).toBe('待确认')
    const favorite = { synopsis: '', lib_match_override: null, media_domain_override: null }
    expect(isFavoriteEditorDirty(favorite, '', 'auto', null)).toBe(false)
    expect(isFavoriteEditorDirty(favorite, '', 'auto', 'anime')).toBe(true)
    expect(isFavoriteEditorDirty({ ...favorite, media_domain_override: 'anime' }, '', 'auto', 'anime')).toBe(false)
    expect(isFavoriteEditorDirty({ ...favorite, media_domain_override: 'unknown' }, '', 'auto', null)).toBe(true)
  })

  it('accepts asynchronous editor results only for the active session and item', () => {
    expect(isFavoriteEditorSessionCurrent(3, 'favorite-1', 3, 'favorite-1')).toBe(true)
    expect(isFavoriteEditorSessionCurrent(3, 'favorite-1', 4, 'favorite-1')).toBe(false)
    expect(isFavoriteEditorSessionCurrent(3, 'favorite-1', 3, 'favorite-2')).toBe(false)
  })

  it('maps search candidates to complete favorite fallback payloads', () => {
    const candidate = {
      bgmId: 583729,
      title: 'バンドリ！ ゆめ∞みた',
      titleZh: 'BanG Dream! YUME∞MITA',
      year: 2026,
      rating: 8.1,
      synopsis: '中文简介',
      posterUrl: 'https://img.test/poster.jpg',
      posterPath: null,
      type: 2,
      episodes: 13,
      airedEpisodes: 3,
      airDate: '2026-07-02',
      airStatus: 'airing' as const,
    }
    expect(metadataCandidateSource(candidate)).toBe('bangumi')
    expect(favoriteItemIdForCandidate(candidate)).toBe('manual-bangumi-583729')
    expect(favoritePayloadFromCandidate(candidate)).toMatchObject({
      title: 'バンドリ！ ゆめ∞みた',
      title_zh: 'BanG Dream! YUME∞MITA',
      bangumi_id: '583729',
      synopsis: '中文简介',
      aired_episodes: 3,
      total_episodes: 13,
      air_status: 'airing',
      media_type: 'anime',
    })
  })

  it('detects calendar favorites through source links and filters locally', () => {
    const candidate = {
      anilistId: 198376,
      title: 'BanG Dream! Yume∞Mita',
      originalTitle: 'バンドリ！ ゆめ∞みた',
      year: 2026,
      rating: null,
      genres: [],
      synopsis: '简介',
      episodes: 13,
      posterUrl: null,
      posterPath: null,
    }
    const favorites = [{ item_id: 'calendar-id', bangumi_id: null, links: [{ name: 'AniList', url: 'https://anilist.co/anime/198376/' }], title: 'Calendar favorite', title_zh: '日历收藏', synopsis: null, air_day: null, air_time: null }]
    expect(isFavoriteCandidateAdded(favorites, candidate)).toBe(true)
    expect(filterFavoriteEntries(favorites, 'calendar')).toHaveLength(1)
    expect(filterFavoriteEntries(favorites, '不存在')).toHaveLength(0)
  })

  it('filters the shared wishlist query by title fields only', () => {
    const favorites = [
      {
        item_id: 'title-hit',
        title: 'The Title',
        title_zh: '标题命中',
        synopsis: '简介里有隐藏词',
        air_day: 'MON',
        air_time: '12:00',
        links: [{ name: '资料', url: 'https://example.test/hidden-link' }],
      },
      {
        item_id: 'other',
        title: '另一个条目',
        title_zh: null,
        synopsis: '普通简介',
        air_day: 'TUE',
        air_time: '13:00',
        links: [],
      },
    ]

    expect(filterFavoriteEntries(favorites, '标题命中').map(item => item.item_id)).toEqual(['title-hit'])
    expect(filterFavoriteEntries(favorites, '隐藏词')).toHaveLength(0)
    expect(filterFavoriteEntries(favorites, 'hidden-link')).toHaveLength(0)
    expect(filterFavoriteEntries(favorites, 'MON')).toHaveLength(0)
  })

  it('sorts overview entries by the selected column, toggles direction, and keeps empty values last', () => {
    const favorites = [
      { item_id: 'empty-title', title: '', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_hit: null, added_at: '2026-08-01 00:00:00' },
      { item_id: 'charlie', title: 'Charlie', title_zh: null, media_type: 'anime' as const, air_status: 'airing' as const, aired_episodes: 2, total_episodes: 12, air_day: 'MON', air_time: '12:00', begin: '2026-08-01', lib_match_override: 'present' as const, lib_hit: null, added_at: '2026-08-03 00:00:00' },
      { item_id: 'alpha', title: 'Alpha', title_zh: null, media_type: 'anime' as const, air_status: 'finished' as const, aired_episodes: 12, total_episodes: 12, air_day: 'TUE', air_time: '13:00', begin: '2026-07-01', lib_match_override: 'absent' as const, lib_hit: null, added_at: '2026-08-02 00:00:00' },
      { item_id: 'bravo', title: 'Bravo', title_zh: null, media_type: 'anime' as const, air_status: 'upcoming' as const, aired_episodes: null, total_episodes: 12, air_day: 'WED', air_time: '14:00', begin: '2026-09-01', lib_match_override: null, lib_hit: null, added_at: '2026-08-04 00:00:00' },
    ]

    expect(sortFavoriteEntries(favorites, { key: 'title', direction: 'asc' }).map(item => item.item_id)).toEqual(['alpha', 'bravo', 'charlie', 'empty-title'])
    expect(sortFavoriteEntries(favorites, { key: 'title', direction: 'desc' }).map(item => item.item_id)).toEqual(['charlie', 'bravo', 'alpha', 'empty-title'])
    expect(sortFavoriteEntries(favorites, { key: 'added_at', direction: 'desc' }).map(item => item.item_id)).toEqual(['bravo', 'charlie', 'alpha', 'empty-title'])
    expect(sortFavoriteEntries(favorites, { key: 'progress', direction: 'desc' }).map(item => item.item_id)).toEqual(['alpha', 'charlie', 'bravo', 'empty-title'])
  })

  it('sorts media-domain groups with unknown entries after known domains', () => {
    const favorites = [
      { item_id: 'unknown', title: 'Unknown', title_zh: null, media_type: 'anime' as const, media_domain: 'unknown' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_hit: null, added_at: null },
      { item_id: 'anime', title: 'Anime', title_zh: null, media_type: 'anime' as const, media_domain: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_hit: null, added_at: null },
      { item_id: 'live', title: 'Live', title_zh: null, media_type: 'live' as const, media_domain: 'live_action' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_hit: null, added_at: null },
    ]
    expect(sortFavoriteEntries(favorites, { key: 'media_type', direction: 'asc' }).map(item => item.item_id)).toEqual(['anime', 'live', 'unknown'])
  })

  it('keeps the four media-library states distinct when sorting', () => {
    const favorites = [
      { item_id: 'absent', title: 'Absent', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_status: 'absent' as const, lib_hit: null, added_at: null },
      { item_id: 'unknown', title: 'Unknown', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_status: 'unknown' as const, lib_hit: null, added_at: null },
      { item_id: 'related', title: 'Related', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_status: 'related' as const, lib_hit: { matched: false, method: 'id' as const, folderName: null, folderId: 2 }, added_at: null },
      { item_id: 'present', title: 'Present', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: null, air_time: null, begin: null, lib_match_override: null, lib_status: 'present' as const, lib_hit: { matched: true, method: 'id' as const, folderName: null, folderId: 1 }, added_at: null },
    ]

    expect(sortFavoriteEntries(favorites, { key: 'library', direction: 'asc' }).map(item => item.item_id)).toEqual(['present', 'related', 'unknown', 'absent'])
  })

  it('sorts schedule fallbacks by Monday-to-Sunday order before time', () => {
    const favorites = [
      { item_id: 'sun', title: 'Sun', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: 'SUN', air_time: '09:00', begin: null, lib_match_override: null, lib_hit: null, added_at: null },
      { item_id: 'mon-late', title: 'Mon late', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: 'MON', air_time: '22:00', begin: null, lib_match_override: null, lib_hit: null, added_at: null },
      { item_id: 'mon-early', title: 'Mon early', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: 'MON', air_time: '08:00', begin: null, lib_match_override: null, lib_hit: null, added_at: null },
      { item_id: 'wed', title: 'Wed', title_zh: null, media_type: 'anime' as const, air_status: null, aired_episodes: null, total_episodes: null, air_day: 'WED', air_time: '12:00', begin: null, lib_match_override: null, lib_hit: null, added_at: null },
    ]

    expect(sortFavoriteEntries(favorites, { key: 'schedule', direction: 'asc' }).map(item => item.item_id)).toEqual(['mon-early', 'mon-late', 'wed', 'sun'])
  })

  it('uses the premiere date before air_day when classifying legacy favorites', () => {
    const now = new Date('2026-08-29T00:00:00.000Z')
    expect(resolvedFavoriteAnimeStatus({ air_status: null, aired_episodes: null, total_episodes: 13, air_day: 'TUE', begin: '2026-09-01T14:00:00.000Z' }, now)).toBe('UPCOMING')
    expect(resolvedFavoriteAnimeStatus({ air_status: null, aired_episodes: 2, total_episodes: 13, air_day: 'TUE', begin: '2026-08-01T14:00:00.000Z' }, now)).toBe('AIRING')
    expect(resolvedFavoriteAnimeStatus({ air_status: null, aired_episodes: 13, total_episodes: 13, air_day: null, begin: null }, now)).toBe('FINISHED')
  })

  it('formats premiere dates in the same timezone used for weekday and time', () => {
    expect(formatFavoriteBeginDate('2009-10-02')).toBe('2009-10-02')
    expect(formatFavoriteBeginDate('2009-10-02T17:30:00.000Z', 'Asia/Shanghai')).toBe('2009-10-03')
    expect(formatFavoriteBeginDate('not-a-date')).toBe('')
  })
})
