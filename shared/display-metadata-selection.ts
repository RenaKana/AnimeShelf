export type DisplayMetadataKind = 'self' | 'season' | 'movie' | 'special' | 'extras' | 'unknown'

function isFirstSeasonName(name: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:s(?:eason)?[\s._-]*0*1|season[\s._-]*0*1|1st[\s._-]*season|第一季|第0*1季)(?:$|[^\p{L}\p{N}])/iu.test(name)
}

function folderYearHint(folderPath: string): number | null {
  const folderName = folderPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? ''
  const years = [...folderName.matchAll(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)]
  const year = years.at(-1)?.[1]
  return year ? Number(year) : null
}

export function classifyDisplayMetadataFolder(name: string, isSelf = false): DisplayMetadataKind {
  if (isSelf) return 'self'
  const compact = name.normalize('NFKC').toLocaleLowerCase().replace(/[\s._\-()[\]{}]+/g, '')
  if (/^(?:z)?(?:sps|extras?|bonuses?|ncop|nced|op|ed|pv|cm|menus?|scans?|cds?|subtitlebackup|subtitles|fonts|trailers?|映像特典|特典|附加内容|花絮)$/.test(compact)) return 'extras'
  if (/^(?:z)?(?:sp|specials?|ova|oad|特别篇|特別篇|番外)$/.test(compact)) return 'special'
  if (/(?:^|[^a-z0-9])(?:movie|film)(?:$|[^a-z0-9])|剧场版|劇場版|映画/iu.test(name)) return 'movie'
  if (/(?:^|[^\p{L}\p{N}])(?:s(?:eason)?[\s._-]*\d+|season[\s._-]*\d+|\d+(?:st|nd|rd|th)[\s._-]*season|第[零一二三四五六七八九十百0-9]+季)(?:$|[^\p{L}\p{N}])/iu.test(name)) return 'season'
  if (/(?:^|[^a-z0-9])(?:sps|extras?|bonuses?|ncop|nced|menus?|scans?|cds?|subtitlebackup|subtitles|fonts|trailers?)(?:$|[^a-z0-9])|映像特典|附加内容|花絮/iu.test(name)) return 'extras'
  if (/(?:^|[^a-z0-9])(?:ova|oad|special|sp)(?:$|[^a-z0-9])|特别篇|特別篇|番外/iu.test(name)) return 'special'
  return 'unknown'
}

function seasonTitleStem(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/(?:^|[^\p{L}\p{N}])(?:s(?:eason)?[\s._-]*\d+|\d+(?:st|nd|rd|th)[\s._-]*season|第[零一二三四五六七八九十百0-9]+季)(?=$|[^\p{L}\p{N}])/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function chooseAutomaticDisplayMetadata<T extends { name: string; year: number | null; parentId: string | number | null; kind: DisplayMetadataKind }>(rootPath: string, eligible: T[]): T | undefined {
  if (eligible.length === 1) return eligible[0]
  if (!eligible.length) return undefined
  const year = folderYearHint(rootPath)
  const yearMatches = year == null ? [] : eligible.filter(row => row.year === year)
  if (yearMatches.length === 1) return yearMatches[0]
  const firstSeasons = eligible.filter(row => isFirstSeasonName(row.name))
  const sameSeries = new Set(eligible.map(row => row.parentId)).size === 1
    && new Set(eligible.map(row => seasonTitleStem(row.name))).size === 1
  return firstSeasons.length === 1 && eligible.every(row => row.kind === 'season') && sameSeries ? firstSeasons[0] : undefined
}
