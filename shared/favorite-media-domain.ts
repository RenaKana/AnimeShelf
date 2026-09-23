import { evidenceMediaDomain, parseMediaDomainEvidence, resolveMediaDomain, type MediaDomainEvidence, type MediaDomainFields } from './media-domain'

export interface FavoriteDomainRecord extends MediaDomainFields {
  item_id: string
  bangumi_id?: string | null
  links?: unknown
}

type FavoriteLinkLike = { url?: unknown }

function favoriteLinks(value: unknown): FavoriteLinkLike[] {
  let links = value
  if (typeof links === 'string') {
    try { links = JSON.parse(links) } catch { links = [] }
  }
  return Array.isArray(links) ? links.filter(link => link && typeof link === 'object') as FavoriteLinkLike[] : []
}

/**
 * Extract only typed source-link evidence.  A Bangumi link without a subject
 * type remains useful as an identity, but it is not by itself anime evidence.
 * TMDB's media discriminator is part of the identity so movie/tv ids can
 * never be mixed accidentally.
 */
export function favoriteEvidenceFromLinks(value: unknown): MediaDomainEvidence[] {
  const evidence: MediaDomainEvidence[] = []
  for (const link of favoriteLinks(value)) {
    try {
      const url = new URL(String(link.url ?? ''))
      const host = url.hostname.replace(/^www\./, '').toLocaleLowerCase()
      let match: RegExpMatchArray | null
      if (['bgm.tv', 'bangumi.tv', 'chii.in'].includes(host)
        && (match = url.pathname.match(/^\/subject\/(\d+)(?:\/|$)/))) {
        evidence.push({ source: 'bangumi', externalId: match[1], authority: 'automatic', subjectType: null })
      }
      if (['anilist.co', 'anilist.com'].includes(host)
        && (match = url.pathname.match(/^\/anime\/(\d+)(?:\/|$)/))) {
        evidence.push({ source: 'anilist', externalId: match[1], authority: 'confirmed', mediaType: 'ANIME' })
      }
      if (host === 'themoviedb.org'
        && (match = url.pathname.match(/^\/(movie|tv)\/(\d+)(?:\/|$)/))) {
        evidence.push({ source: 'tmdb', externalId: match[2], authority: 'automatic', mediaType: match[1] as 'movie' | 'tv' })
      }
    } catch { /* Invalid links cannot establish an identity. */ }
  }
  return evidence
}

/** Canonical bangumi-data entries are the one trusted non-provider calendar hint. */
export function bangumiDataFavoriteEvidence(itemId: string): MediaDomainEvidence[] {
  return itemId && !itemId.startsWith('manual-')
    ? [{ source: 'bangumi-data', externalId: itemId, authority: 'confirmed', subjectType: 2 }]
    : []
}

export function favoriteEvidenceKeys(row: FavoriteDomainRecord): Set<string> {
  const keys = new Set<string>()
  const manual = row.item_id.match(/^manual-(anilist|bangumi)-(\d+)$/)
  if (manual) keys.add(`${manual[1]}:${manual[2]}`)
  // A manual TMDB id has no media discriminator in its legacy item id.  Keep
  // the typed link as the only identity so movie and TV rows with the same
  // numeric id remain distinct.
  if (row.item_id && !row.item_id.startsWith('manual-')) keys.add(`bangumi-data:${row.item_id}`)
  if (row.bangumi_id && /^\d+$/.test(String(row.bangumi_id))) keys.add(`bangumi:${row.bangumi_id}`)
  for (const entry of favoriteEvidenceFromLinks(row.links)) keys.add(favoriteEvidenceKey(entry))
  return keys
}

export function favoriteEvidenceKey(evidence: MediaDomainEvidence): string {
  return evidence.source === 'tmdb' ? `tmdb:${evidence.mediaType}:${evidence.externalId}`
    : `${evidence.source}:${evidence.externalId}`
}

function mergeEvidenceEntries(entries: readonly MediaDomainEvidence[]): MediaDomainEvidence[] {
  const merged = new Map<string, MediaDomainEvidence[]>()
  for (const entry of entries) {
    const key = favoriteEvidenceKey(entry)
    const bucket = merged.get(key) ?? []
    // Typed links are automatic identity evidence. They must not replace a
    // confirmed result already persisted for the same source identity.
    if (entry.authority === 'automatic' && bucket.some(previous => previous.authority === 'confirmed')) continue
    if (entry.authority === 'confirmed') {
      for (let index = bucket.length - 1; index >= 0; index--) {
        if (bucket[index].authority === 'automatic') bucket.splice(index, 1)
      }
    }
    const variant = evidenceMediaDomain(entry)
    if (!bucket.some(previous => previous.authority === entry.authority && evidenceMediaDomain(previous) === variant)) bucket.push(entry)
    merged.set(key, bucket)
  }
  return [...merged.values()].flat()
}

/**
 * Merge a newly fetched source snapshot. Entries from the same identity in a
 * new confirmed snapshot replace older variants, while an automatic refresh
 * cannot erase a confirmed result. Conflicting entries within one snapshot
 * remain intact so resolveMediaDomain can report the conflict.
 */
function mergeEvidenceSnapshot(previous: readonly MediaDomainEvidence[], incoming: readonly MediaDomainEvidence[]): MediaDomainEvidence[] {
  const current = mergeEvidenceEntries(previous)
  const next = mergeEvidenceEntries(incoming)
  if (next.length === 0) return current

  const nextByIdentity = new Map<string, MediaDomainEvidence[]>()
  for (const entry of next) {
    const key = favoriteEvidenceKey(entry)
    const bucket = nextByIdentity.get(key) ?? []
    bucket.push(entry)
    nextByIdentity.set(key, bucket)
  }
  const currentByIdentity = new Map<string, MediaDomainEvidence[]>()
  for (const entry of current) {
    const key = favoriteEvidenceKey(entry)
    const bucket = currentByIdentity.get(key) ?? []
    bucket.push(entry)
    currentByIdentity.set(key, bucket)
  }

  const combined: MediaDomainEvidence[] = []
  for (const [key, bucket] of currentByIdentity) {
    const replacement = nextByIdentity.get(key)
    if (!replacement || (replacement.every(entry => entry.authority === 'automatic') && bucket.some(entry => entry.authority === 'confirmed'))) {
      combined.push(...bucket)
    }
  }
  combined.push(...next)
  return mergeEvidenceEntries(combined)
}

export function boundFavoriteEvidence(row: FavoriteDomainRecord, input: unknown = row.media_domain_evidence): MediaDomainEvidence[] {
  const identities = favoriteEvidenceKeys(row)
  return parseMediaDomainEvidence(input).filter(entry => identities.has(favoriteEvidenceKey(entry)))
}

export function classifyFavorite(row: FavoriteDomainRecord, extraEvidence?: unknown) {
  const persisted = row.media_domain_evidence != null ? boundFavoriteEvidence(row) : []
  const extra = extraEvidence == null ? [] : boundFavoriteEvidence(row, extraEvidence)
  const linked = favoriteEvidenceFromLinks(row.links).filter(entry => favoriteEvidenceKeys(row).has(favoriteEvidenceKey(entry)))
  const legacyAniList = row.media_domain_evidence == null ? [...favoriteEvidenceKeys(row)]
    .filter(key => key.startsWith('anilist:')).map(key => ({ source: 'anilist', externalId: key.slice(8), mediaType: 'ANIME', authority: 'confirmed' } as MediaDomainEvidence)) : []
  const evidence = mergeEvidenceSnapshot(mergeEvidenceEntries([...persisted, ...linked, ...legacyAniList]), extra)
  return resolveMediaDomain({ override: row.media_domain_override, evidence: evidence.length || row.media_domain_evidence != null ? evidence : null,
    hasMetadata: favoriteEvidenceKeys(row).size > 0 || /^manual-(?:anilist|bangumi|tmdb)-/.test(row.item_id) })
}

export function mergeFavoriteEvidence(row: FavoriteDomainRecord, incoming: unknown): string | null {
  const merged = mergeEvidenceSnapshot(boundFavoriteEvidence(row), boundFavoriteEvidence(row, incoming))
  return merged.length ? JSON.stringify(merged) : row.media_domain_evidence ?? null
}
