import { queryString, request } from '@/api'
import type { MetadataCandidate, SeasonCalendarData, SeasonFavorite, SeasonFavoritePayload } from '@/types'
import type { MediaDomain } from '../../../shared/media-domain'

const ownerHeaders = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

export const api = {
  metadata: {
    search: (query: string, source = 'bangumi') => request<MetadataCandidate[]>(`/api/metadata/search${queryString({ q: query, source })}`),
  },
  season: {
    calendar: () => request<SeasonCalendarData>('/api/season/calendar'),
    favorites: (options: { refreshLibraryMatches?: boolean } = {}) => request<SeasonFavorite[]>(`/api/season/favorites${queryString({ refresh_library_matches: options.refreshLibraryMatches ? 1 : undefined })}`),
    favorite: (item: SeasonFavoritePayload) => request<{ ok: boolean }>('/api/season/favorites', { method: 'POST', body: JSON.stringify(item) }),
    unfavorite: (itemId: string) => request<{ ok: boolean }>(`/api/season/favorites/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
    updatePoster: (itemId: string, url?: string, source?: 'auto' | 'anilist' | 'bangumi' | 'tmdb') => request<{ ok: boolean; image: string | null }>(`/api/season/favorites/${encodeURIComponent(itemId)}/poster`, { method: 'POST', body: JSON.stringify(url ? { url } : source ? { source } : {}) }),
    updateSynopsis: (itemId: string, synopsis: string) => request<{ ok: boolean }>(`/api/season/favorites/${encodeURIComponent(itemId)}`, { method: 'PUT', body: JSON.stringify({ synopsis }) }),
    updateLibraryStatus: (itemId: string, override: 'auto' | 'present' | 'absent') => request<{ ok: boolean; lib_match_override: 'present' | 'absent' | null }>(`/api/season/favorites/${encodeURIComponent(itemId)}/library-status`, { method: 'PUT', body: JSON.stringify({ override }) }),
    updateMediaDomain: (itemId: string, override: MediaDomain | null) => request<{ ok: boolean; media_domain: MediaDomain; media_domain_override: MediaDomain | null }>(`/api/season/favorites/${encodeURIComponent(itemId)}/media-domain`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ override }) }),
  },
}
