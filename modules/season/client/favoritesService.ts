import type { MetadataCandidate, SeasonFavorite } from '@/types'
import { favoritePayloadFromCandidate, isFavoriteCandidateAdded } from './favoriteLayout'
import { api } from './api'

export const favoritesService = {
  list: () => api.season.favorites(),
  isAdded: (favorites: SeasonFavorite[], candidate: MetadataCandidate) => isFavoriteCandidateAdded(favorites, candidate),
  add: (candidate: MetadataCandidate) => api.season.favorite(favoritePayloadFromCandidate(candidate)),
}
