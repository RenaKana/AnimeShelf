import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('page header surfaces', () => {
  it('uses the shared header panel on the main title surfaces', () => {
    const contracts = [
      ['src/pages/LibraryView.tsx', /<section className="[^"]*page-header ui-panel[^"]*">[\s\S]*?<h1[^>]*>\{showAll \? '全部媒体' : currentLibrary\?\.name \?\? '媒体库'\}<\/h1>/],
      ['modules/season/client/SeasonCalendar.tsx', /<div className="[^"]*page-header ui-panel[^"]*">[\s\S]*?<h1 className="page-title">追番<\/h1>/],
      ['modules/season/client/FavoritesView.tsx', /<div className="[^"]*page-header ui-panel[^"]*">[\s\S]*?<h1 className="page-title">心愿单<\/h1>/],
      ['src/pages/Settings.tsx', /<header className="[^"]*page-header ui-panel[^"]*">[\s\S]*?<h1 className="page-title">设置<\/h1>/],
    ] as const

    for (const [file, contract] of contracts) {
      expect(source(file), file).toMatch(contract)
    }
  })

  it('groups collection navigation, title actions, and tabs in one header panel', () => {
    const text = source('modules/media-catalog/client/collections/CollectionDetail.tsx')

    expect(text).toMatch(/<div className="[^"]*page-header ui-panel space-y-3">\s*<nav[\s\S]*?<\/nav>\s*<header className="collection-header">[\s\S]*?<\/header>\s*<div className="collection-view-switch"[^>]*>[\s\S]*?<\/div>\s*<\/div>/)
  })

  it('styles the folder breadcrumb and metadata title as distinct shared surfaces', () => {
    const text = source('src/pages/FolderDetail.tsx')
    const breadcrumb = text.match(/<div className="page-breadcrumb ui-panel[^"]*">/)?.[0] ?? ''

    expect(breadcrumb).toContain('flex')
    expect(breadcrumb).not.toMatch(/(?:^|\s)h-8(?:\s|$)/)
    expect(text).toMatch(/<section className="page-header ui-panel relative[^"]*">[\s\S]*?<h1[^>]*>[\s\S]*?\{item\.name\}[\s\S]*?<\/h1>/)
  })

  it('keeps long file names and metadata inside a wrapping header panel', () => {
    const text = source('src/pages/FileDetail.tsx')

    expect(text).toMatch(/<div className="[^"]*page-header ui-panel[^"]*">[\s\S]*?<h1 className="[^"]*break-all[^"]*">\{item\.name\}<\/h1>/)
    expect(text).toMatch(/<div className="flex flex-wrap[^"]*">\s*<span>📦/)
  })
})
