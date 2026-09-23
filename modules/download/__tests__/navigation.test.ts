import { describe, expect, it } from 'vitest'
import { alternateDownloadPath, readDownloadSearch, wishlistDownloadPath } from '../../../shared/download-navigation'

describe('wishlist resource search handoff', () => {
  it('carries the Chinese name and original title without losing URL punctuation', () => {
    const path = wishlistDownloadPath({ title: '新世界 / 신세계 & New World', title_zh: ' 新世界 ' })
    const search = path.slice(path.indexOf('?'))
    expect(readDownloadSearch(search)).toEqual({ keyword: '新世界', alternate: '新世界 / 신세계 & New World', fromWishlist: true })
    const alternate = alternateDownloadPath(search)!
    expect(readDownloadSearch(alternate.slice(alternate.indexOf('?')))).toEqual({ keyword: '新世界 / 신세계 & New World', alternate: '新世界', fromWishlist: true })
  })

  it('uses the original title when a Chinese title is absent and avoids duplicate options', () => {
    for (const title_zh of [null, ' ', '신세계']) {
      const path = wishlistDownloadPath({ title: '신세계', title_zh })
      expect(readDownloadSearch(path.slice(path.indexOf('?')))).toEqual({ keyword: '신세계', alternate: null, fromWishlist: true })
      expect(alternateDownloadPath(path.slice(path.indexOf('?')))).toBeNull()
    }
  })

  it('bounds incoming search terms and leaves a plain download visit to saved preferences', () => {
    expect(readDownloadSearch('')).toBeNull()
    expect(readDownloadSearch('?keyword=%20')).toBeNull()
    expect(readDownloadSearch('?keyword=A%0AB%00C')?.keyword).toBe('A B C')
    expect(readDownloadSearch(`?keyword=${'字'.repeat(250)}`)?.keyword).toHaveLength(200)
    expect(wishlistDownloadPath({ title: '', title_zh: null })).toBe('/download')
  })
})
