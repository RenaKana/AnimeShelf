import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ClientModuleLoader } from '../../../src/modules/contracts'
import { loadClientModules } from '../../../src/modules/registry'

const MODULE_IDS = [
  'metadata',
  'season',
  'media-catalog',
  'download',
  'wallpapers',
  'external-api',
] as const

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('module client entries', () => {
  it('provides a typed client contribution for every discovered module', () => {
    for (const id of MODULE_IDS) {
      const entry = `modules/${id}/client.tsx`
      expect(existsSync(resolve(process.cwd(), entry)), `${entry} should exist`).toBe(true)
      expect(source(entry)).toContain('satisfies ClientModule')
    }
  })

  it('imports only modules that are active for this server boot', async () => {
    const calls: string[] = []
    const loaders: Record<string, ClientModuleLoader> = {
      active: async () => { calls.push('active'); return { default: {} } },
      disabled: async () => { calls.push('disabled'); return { default: {} } },
    }

    const result = await loadClientModules({
      modules: [
        { id: 'active', name: 'Active', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: false, active: true, reason: null },
        { id: 'disabled', name: 'Disabled', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: false, reason: null },
      ],
      restartRequired: true,
    }, loaders)

    expect(calls).toEqual(['active'])
    expect(result.modules.map(module => module.id)).toEqual(['active'])
  })

  it('loads required client modules first and blocks dependents when a requirement fails', async () => {
    const calls: string[] = []
    const snapshot = {
      modules: [
        { id: 'feature', name: 'Feature', version: '1', defaultEnabled: true, requires: ['base'], optional: [], configuredEnabled: true, active: true, reason: null },
        { id: 'base', name: 'Base', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: true, reason: null },
      ],
      restartRequired: false,
    }
    const loaded = await loadClientModules(snapshot, {
      feature: async () => { calls.push('feature'); return { default: {} } },
      base: async () => { calls.push('base'); return { default: {} } },
    })
    expect(calls).toEqual(['base', 'feature'])
    expect(loaded.modules.map(module => module.id)).toEqual(['base', 'feature'])

    calls.length = 0
    const failed = await loadClientModules(snapshot, {
      feature: async () => { calls.push('feature'); return { default: {} } },
      base: async () => { calls.push('base'); throw new Error('base boom') },
    })
    expect(calls).toEqual(['base'])
    expect(failed.modules).toEqual([])
    expect(failed.errors).toMatchObject({ base: 'base boom' })
    expect(failed.errors.feature).toContain('base')
  })
  it('rejects client routes that differ from manifest pages or collide with core routes', async () => {
    const mismatch = await loadClientModules({
      modules: [{ id: 'mismatch', name: 'Mismatch', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: true, reason: null, pages: ['/declared'] }],
      restartRequired: false,
    }, { mismatch: async () => ({ default: { routes: [{ path: '/actual', element: null }] } }) })
    expect(mismatch.modules).toEqual([])
    expect(mismatch.errors.mismatch).toContain('/declared')

    const collision = await loadClientModules({
      modules: [{ id: 'collision', name: 'Collision', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: true, reason: null, pages: ['/settings'] }],
      restartRequired: false,
    }, { collision: async () => ({ default: { routes: [{ path: '/settings', element: null }] } }) })
    expect(collision.modules).toEqual([])
    expect(collision.errors.collision).toContain('核心路由')
  })
  it('isolates a failed client entry while retaining other active modules', async () => {
    const result = await loadClientModules({
      modules: [
        { id: 'broken', name: 'Broken', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: true, reason: null },
        { id: 'healthy', name: 'Healthy', version: '1', defaultEnabled: true, requires: [], optional: [], configuredEnabled: true, active: true, reason: null },
      ],
      restartRequired: false,
    }, {
      broken: async () => { throw new Error('boom') },
      healthy: async () => ({ default: { navItems: [{ to: '/healthy', label: 'Healthy', icon: null }] } }),
    })

    expect(result.modules.map(module => module.id)).toEqual(['healthy'])
    expect(result.errors).toEqual({ broken: 'boom' })
  })

  it('keeps optional routes, navigation, settings, providers, and backgrounds behind the registry', () => {
    const app = source('src/App.tsx')
    const main = source('src/main.tsx')
    const sidebar = source('src/components/Sidebar.tsx')
    const settings = source('src/pages/Settings.tsx')
    const registry = source('src/modules/registry.tsx')
    const wallpapers = source('modules/wallpapers/client.tsx')

    expect(main).toContain('<ModulesProvider>')
    expect(app).toContain('<ModuleProviders>')
    expect(app).toContain('contribution.routes')
    expect(app).toContain('contribution.Background')
    expect(sidebar).toContain('contribution.navItems')
    expect(settings).toContain('contribution.settingsSections')
    expect(registry).toContain('X-AnimeShelf-Owner')
    expect(wallpapers).toContain('WallpaperSettings')
    expect(wallpapers).toContain('Background: AppBackground')

    for (const legacyImport of [
      './components/AppBackground',
      './pages/SeasonCalendar',
      './pages/season/FavoritesView',
      './pages/FindAnime',
      './pages/MediaCatalogAiWorkbenchPage',
      './components/media-catalog-ai/MediaCatalogAiWorkbenchProvider',
    ]) expect(app).not.toContain(legacyImport)
  })

  it('registers season and wishlist routes, navigation, and preferences from one module', () => {
    const entry = source('modules/season/client.tsx')

    expect(entry).toContain("path: '/season'")
    expect(entry).toContain("path: '/favorites'")
    expect(entry).toContain("to: '/season'")
    expect(entry).toContain("to: '/favorites'")
    expect(entry).toContain('SeasonSettings')
    expect(existsSync(resolve(process.cwd(), 'modules/season/client/SeasonCalendar.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'modules/season/client/FavoritesView.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'src/pages/SeasonCalendar.tsx'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/pages/season/FavoritesView.tsx'))).toBe(false)
  })

  it('does not ship excluded feature modules or their legacy client files', () => {
    for (const id of ['ai-provider', 'find-anime', 'catalog-ai']) {
      expect(existsSync(resolve(process.cwd(), `modules/${id}`)), id).toBe(false)
    }
    for (const file of [
      'src/pages/FindAnime.tsx',
      'src/pages/MediaCatalogAiWorkbenchPage.tsx',
      'src/components/settings/FindAnimeSearchSettings.tsx',
      'src/components/settings/AiProviderConnectionTest.tsx',
      'src/components/media-catalog-ai/MediaCatalogAiWorkbenchProvider.tsx',
    ]) expect(existsSync(resolve(process.cwd(), file)), file).toBe(false)
  })

  it('owns external API settings and client calls behind the external-api entry', () => {
    const entry = source('modules/external-api/client.tsx')

    expect(entry).toContain('ExternalApiSettings')
    expect(entry).toContain("id: 'settings-external-api'")
    expect(existsSync(resolve(process.cwd(), 'modules/external-api/client/ExternalApiSettings.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'modules/external-api/client/ExternalApiTokenManager.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'modules/external-api/client/externalApiClient.ts'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'src/components/settings/ExternalApiSettings.tsx'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/lib/externalApiClient.ts'))).toBe(false)
  })

  it('contributes metadata settings, folder controls, and library controls without core endpoint ownership', () => {
    const entry = source('modules/metadata/client.tsx')
    const folderDetail = source('src/pages/FolderDetail.tsx')
    const libraryView = source('src/pages/LibraryView.tsx')
    const settings = source('src/pages/Settings.tsx')
    const api = source('src/api.ts')

    expect(entry).toContain('MetadataSettings')
    expect(entry).toContain('MetadataFolderPanel')
    expect(entry).toContain('MetadataLibraryActions')
    expect(entry).toContain('folderPanels')
    expect(entry).toContain('libraryActions')
    expect(entry).not.toContain('libraryToolbars')
    expect(folderDetail).toContain('contribution.folderPanels')
    expect(libraryView).toContain('contribution.libraryActions')
    expect(settings).not.toContain('settings-metadata')
    expect(api).not.toContain('api/metadata')
    expect(api).not.toContain('match-metadata')
    expect(existsSync(resolve(process.cwd(), 'src/components/MetadataPicker.tsx'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/lib/displayMetadata.ts'))).toBe(false)
  })

  it('contributes the media catalog panel and pinned collection view without owning core folder rendering', () => {
    const entry = source('modules/media-catalog/client.tsx')
    const folderDetail = source('src/pages/FolderDetail.tsx')
    const api = source('src/api.ts')

    expect(entry).toContain('MediaCatalogPanel')
    expect(entry).toContain('CollectionFolderView')
    expect(entry).toContain('folderPanels')
    expect(entry).toContain('folderViews')
    expect(folderDetail).toContain('contribution.folderViews')
    expect(folderDetail).toContain('active.children')
    expect(folderDetail).not.toContain('MediaCatalogWorkGroups')
    expect(folderDetail).not.toContain('CollectionDetail')
    expect(api).not.toContain('media-catalog')
    expect(api).not.toContain('collection-presentation')
    expect(existsSync(resolve(process.cwd(), 'modules/media-catalog/client/MediaCatalogPanel.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'modules/media-catalog/client/CollectionFolderView.tsx'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'src/components/media-catalog/MediaCatalogWorkGroups.tsx'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/components/collections/CollectionDetail.tsx'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'src/lib/mediaCatalog.ts'))).toBe(false)
  })
})
