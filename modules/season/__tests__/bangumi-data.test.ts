import { describe, expect, it } from 'vitest'
import {
  favoriteIdentityMatches,
  isSeasonItemFavorited,
  findBangumiSeasonEntryFromItems,
  matchBangumiSeasonEntry,
  mergeFavoriteLinks,
  backfillFavoriteSchedule,
  reconcileFavoriteTitles,
  resolveFavoriteAirStatus,
} from '../server/bangumi-data'

const items = [
  {
    title: 'Example Season 2',
    titleTranslate: { 'zh-Hans': ['示例 第二季'] },
    type: 'tv',
    begin: '2026-07-02T12:00:00',
    sites: [
      { site: 'bangumi', id: '200' },
      { site: 'aniList', id: '300' },
    ],
  },
  {
    title: 'Example',
    titleTranslate: { 'zh-Hans': ['示例'] },
    type: 'tv',
    begin: '2024-04-02T14:00:00.000Z',
    sites: [{ site: 'bangumi', id: '100' }],
  },
]

describe('bangumi-data season matching', () => {
  it('fails closed for explicit unknown IDs, ambiguous seasons, and fuzzy-only titles', () => {
    expect(findBangumiSeasonEntryFromItems(items, { bangumiId: '999', titleZh: '示例 第二季' })).toBeNull()

    const multipleSeasons = [
      {
        title: 'Same Show',
        titleTranslate: { 'zh-Hans': ['同一部番'] },
        type: 'tv',
        begin: '2025-01-01T00:00:00.000Z',
        sites: [{ site: 'bangumi', id: '501' }],
      },
      {
        title: 'Same Show',
        titleTranslate: { 'zh-Hans': ['同一部番'] },
        type: 'tv',
        begin: '2026-01-01T00:00:00.000Z',
        sites: [{ site: 'bangumi', id: '502' }],
      },
    ]
    expect(findBangumiSeasonEntryFromItems(multipleSeasons, { titleZh: '同一部番' })).toBeNull()
    expect(findBangumiSeasonEntryFromItems(multipleSeasons, { titleZh: '同一部番', begin: '2026-01-02' })?.bangumiId).toBe('502')
    expect(findBangumiSeasonEntryFromItems(multipleSeasons, { titleZh: '同一部番', begin: '2030-01-01' })).toBeNull()
    expect(findBangumiSeasonEntryFromItems(multipleSeasons, { titleZh: '同一部番', begin: '2025-07-02' })).toBeNull()
    expect(findBangumiSeasonEntryFromItems(items, { titleZh: '示例 第二季 OVA' })).toBeNull()
  })

  it('resolves duplicate favorite airing status by authoritative precedence', () => {
    expect(resolveFavoriteAirStatus(null, null, 'finished', 'upcoming')).toBe('finished')
    expect(resolveFavoriteAirStatus('airing', 'finished', 'upcoming', 'upcoming')).toBe('airing')
    expect(resolveFavoriteAirStatus(null, 'finished', 'upcoming', 'airing')).toBe('finished')
    expect(resolveFavoriteAirStatus(null, null, null, 'airing')).toBe('airing')
  })

  it('matches the canonical entry by Bangumi id and returns schedule plus links', () => {
    const result = matchBangumiSeasonEntry(items, { bangumiId: '200' })
    expect(result).toMatchObject({
      bangumiId: '200',
      title: 'Example Season 2',
      titleZh: '示例 第二季',
      begin: '2026-07-02T12:00:00',
      day: 'THU',
      links: [
        { name: '番组计划', url: 'https://bgm.tv/subject/200' },
        { name: 'AniList', url: 'https://anilist.co/anime/300' },
      ],
    })
  })

  it('matches by Chinese title and merges links without duplicate URLs', () => {
    const result = matchBangumiSeasonEntry(items, { titleZh: '示例', begin: '2024-04-02' })
    expect(result?.bangumiId).toBe('100')
    expect(mergeFavoriteLinks(
      [{ name: 'AniList', url: 'https://anilist.co/anime/300/' }],
      result?.links,
      [{ name: 'AniList', url: 'https://anilist.co/anime/300' }],
    )).toEqual([
      { name: 'AniList', url: 'https://anilist.co/anime/300/' },
      { name: '番组计划', url: 'https://bgm.tv/subject/100' },
    ])
  })

  it('indexes every Chinese alias and never weak-matches the Railgun OVA as the TV series', () => {
    const railgun = [
      {
        title: 'とある科学の超電磁砲 OVA',
        titleTranslate: { 'zh-Hans': ['某科学的超电磁炮 OVA', '科学超电磁炮 OVA'] },
        type: 'movie',
        begin: '2010-10-29T00:00:00.000Z',
        sites: [{ site: 'bangumi', id: '98371' }],
      },
      {
        title: 'とある科学の超電磁砲',
        titleTranslate: { 'zh-Hans': ['某科学的超电磁炮', '科学超电磁炮'] },
        type: 'tv',
        begin: '2009-10-02T00:00:00.000Z',
        sites: [{ site: 'bangumi', id: '62131' }],
      },
    ]
    expect(matchBangumiSeasonEntry(railgun, { titleZh: '科学超电磁炮' })?.bangumiId).toBe('62131')
    expect(matchBangumiSeasonEntry(railgun, { titleZh: '某科学的超电磁炮' })?.bangumiId).toBe('62131')
    expect(matchBangumiSeasonEntry(railgun, { titleZh: '某科学的超电磁炮 OVA' })).toBeNull()
  })

  it('accepts exact aliases when each language uses a different format qualifier', () => {
    const crossLanguageFormats = [
      {
        title: 'Example Special',
        titleTranslate: { 'zh-Hans': ['示例 特别篇'] },
        type: 'tv',
        begin: '2025-01-02T12:00:00.000Z',
        sites: [{ site: 'bangumi', id: '700' }],
      },
    ]

    expect(matchBangumiSeasonEntry(crossLanguageFormats, { title: 'Example Special' })?.bangumiId).toBe('700')
    expect(matchBangumiSeasonEntry(crossLanguageFormats, { titleZh: '示例 特别篇' })?.bangumiId).toBe('700')
  })

  it('does not fuzzy-match Japanese special-format qualifiers to a base TV series', () => {
    const baseSeries = [
      {
        title: 'Example',
        titleTranslate: { 'zh-Hans': ['示例'] },
        type: 'tv',
        begin: '2025-01-02T12:00:00.000Z',
        sites: [{ site: 'bangumi', id: '701' }],
      },
    ]

    expect(matchBangumiSeasonEntry(baseSeries, { title: 'Example 特別編' })).toBeNull()
    expect(matchBangumiSeasonEntry(baseSeries, { titleZh: '示例 総集編' })).toBeNull()
    expect(matchBangumiSeasonEntry(baseSeries, { titleZh: '示例 スペシャル' })).toBeNull()
  })

  it('recognizes calendar and search favorites as the same identity by Bangumi id or canonical link', () => {
    const calendar = {
      item_id: 'calendar-md5-id',
      bangumi_id: null,
      links: [{ name: '番组计划', url: 'https://bgm.tv/subject/583729/' }],
    }
    const search = {
      item_id: 'manual-bangumi-583729',
      bangumi_id: '583729',
      links: [{ name: '番组计划', url: 'https://bgm.tv/subject/583729' }],
    }
    expect(favoriteIdentityMatches(calendar, search)).toBe(true)
    expect(isSeasonItemFavorited({ id: 'another-calendar-id', links: search.links }, [calendar])).toBe(true)
  })

  it('backfills canonical original and Chinese titles only for explicit Bangumi identities', () => {
    const canonical = {
      bangumiId: '12345',
      title: '白聖女と黒牧師',
      titleZh: '白圣女与黑牧师',
      begin: null,
      day: null,
      time: null,
      links: [],
    }

    expect(reconcileFavoriteTitles({ item_id: 'calendar-id', title: '白圣女与黑牧师', title_zh: '白圣女与黑牧师', bangumi_id: '12345', links: [] }, canonical)).toMatchObject({
      title: '白聖女と黒牧師',
      titleZh: '白圣女与黑牧师',
      changed: true,
    })
    expect(reconcileFavoriteTitles({ item_id: 'calendar-id', title: '白圣女与黑牧师', title_zh: null, bangumi_id: '12345', links: [] }, canonical)).toMatchObject({
      title: '白聖女と黒牧師',
      titleZh: '白圣女与黑牧师',
      changed: true,
    })
    expect(reconcileFavoriteTitles({ item_id: 'calendar-id', title: '白圣女与黑牧师', title_zh: '白圣女与黑牧师', bangumi_id: null, links: [] }, canonical)).toMatchObject({
      title: '白圣女与黑牧师',
      titleZh: '白圣女与黑牧师',
      changed: false,
    })
    expect(reconcileFavoriteTitles({ item_id: 'calendar-id', title: 'Existing Original', title_zh: '用户自定义中文', bangumi_id: '12345', links: [] }, canonical)).toMatchObject({
      title: 'Existing Original',
      titleZh: '用户自定义中文',
      changed: false,
    })
  })

  it('backfills only missing schedule fields from a canonical season entry', () => {
    const canonical = {
      begin: '2020-01-02T12:30:00.000Z',
      day: 'THU',
      time: '20:30',
    }

    expect(backfillFavoriteSchedule({ begin: null, air_day: null, air_time: null }, canonical)).toEqual({
      begin: canonical.begin,
      air_day: canonical.day,
      air_time: canonical.time,
      changed: true,
    })
    expect(backfillFavoriteSchedule({ begin: 'existing-begin', air_day: 'MON', air_time: null }, canonical)).toEqual({
      begin: 'existing-begin',
      air_day: 'MON',
      air_time: canonical.time,
      changed: true,
    })
    expect(backfillFavoriteSchedule({ begin: '', air_day: undefined, air_time: '  ' }, canonical)).toEqual({
      begin: canonical.begin,
      air_day: canonical.day,
      air_time: canonical.time,
      changed: true,
    })
    expect(backfillFavoriteSchedule({ begin: 'existing-begin', air_day: 'MON', air_time: '09:00' }, canonical)).toEqual({
      begin: 'existing-begin',
      air_day: 'MON',
      air_time: '09:00',
      changed: false,
    })
  })
})
