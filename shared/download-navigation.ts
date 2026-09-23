/** A route-only handoff: season and download remain independently optional. */
function searchTitle(value: string | null | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
}

export function wishlistDownloadPath(favorite: { title: string; title_zh?: string | null }): string {
  const title = searchTitle(favorite.title)
  const keyword = searchTitle(favorite.title_zh) || title
  if (!keyword) return '/download'
  const params = new URLSearchParams({ keyword, from: 'wishlist' })
  if (title && title !== keyword) params.set('alternate', title)
  return `/download?${params.toString()}`
}

export function readDownloadSearch(search: string): { keyword: string; alternate: string | null; fromWishlist: boolean } | null {
  const params = new URLSearchParams(search)
  const keyword = searchTitle(params.get('keyword'))
  if (!keyword) return null
  const alternate = searchTitle(params.get('alternate'))
  return { keyword, alternate: alternate && alternate !== keyword ? alternate : null, fromWishlist: params.get('from') === 'wishlist' }
}

export function alternateDownloadPath(search: string): string | null {
  const request = readDownloadSearch(search)
  if (!request?.alternate) return null
  const params = new URLSearchParams({ keyword: request.alternate, alternate: request.keyword })
  if (request.fromWishlist) params.set('from', 'wishlist')
  return `/download?${params.toString()}`
}
