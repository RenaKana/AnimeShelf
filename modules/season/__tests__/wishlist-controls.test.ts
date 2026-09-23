import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  WishlistLibraryStatusSelect,
  WishlistSourceSelect,
} from '../client/WishlistControls'
import type { FavoriteLibraryStatusPresentation } from '../client/favoriteLayout'

describe('wishlist controls', () => {
  it('renders the library status as a lightweight result trigger with its matched folder', () => {
    const presentation = {
      label: '已收录',
      tone: 'success',
      mode: 'auto',
      ariaLabel: '媒体库状态：自动判断，已收录',
      folder: '某科学的超电磁炮',
    } as FavoriteLibraryStatusPresentation & { folder?: string | null }

    const markup = renderToStaticMarkup(createElement(WishlistLibraryStatusSelect, {
      value: 'auto',
      presentation,
      onChange: () => undefined,
    }))

    expect(markup).toContain('某科学的超电磁炮')
    expect(markup).toContain('inline-block')
    expect(markup).toContain('w-fit')
    expect(markup).toContain('border-0')
    expect(markup).toContain('bg-transparent')
    expect(markup).not.toContain('w-[164px]')
    expect(markup).not.toContain('border-white/10')
    expect(markup).not.toContain('<svg')
  })

  it('keeps the fixed-size chevron selector styling for metadata sources', () => {
    const markup = renderToStaticMarkup(createElement(WishlistSourceSelect, {
      value: 'bangumi',
      onChange: () => undefined,
    }))

    expect(markup).toContain('w-[164px]')
    expect(markup).toContain('<svg')
  })
})
