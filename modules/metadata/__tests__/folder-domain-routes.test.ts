import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { sqlRun } from '../../../server/db/sql'
import { candidateDomainEvidence } from '../../../shared/media-domain'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'

const instance = vi.hoisted(() => ({ db: undefined as any }))
const metadata = vi.hoisted(() => ({
  getTMDBDetail: vi.fn(), getTMDBPoster: vi.fn(), getBangumiDetail: vi.fn(),
  getAniListDetail: vi.fn(), cachePoster: vi.fn(), findPreferredBangumiSynopsis: vi.fn(),
  preferBangumiSynopsis: vi.fn(),
}))
vi.mock('../../../server/db/instance', () => instance)
vi.mock('../server/metadata', () => metadata)

describe('folder metadata routes retain item classification', () => {
  let db: ReturnType<typeof createDb>
  let server: Server
  let folderId: number
  let rootId: number
  beforeEach(async () => {
    vi.resetAllMocks()
    db = createDb(':memory:'); instance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false })
    const library = makeLibraryDb(db).create('Mixed', 'D:\\RouteFixture', 'anime')
    makeFolderDb(db).upsertTree(library.id, ['D:\\RouteFixture', 'D:\\RouteFixture\\Work'])
    const rows = makeFolderDb(db).getByLibrary(library.id)
    rootId = rows.find(row => row.parent_id == null)!.id
    folderId = rows.find(row => row.parent_id != null)!.id
    makeFolderDb(db).updateAnilist(folderId, { source: 'tmdb', anilistId: 42, tmdbMediaType: 'tv', hasPoster: false,
      domainEvidence: candidateDomainEvidence('tmdb', { tmdbId: 42, mediaType: 'tv', genreIds: [18] }) })
    const app = express(); app.use(express.json())
    app.use('/api/folders', (await import('../server/folders')).default)
    server = await new Promise<Server>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)) })
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close(); instance.db = undefined
  })
  const refresh = () => requestLocalHttp(server, `/api/folders/${folderId}/refresh-metadata`, { method: 'POST' })

  it('preserves confirmed evidence on provider failure and returns the effective result on a no-op', async () => {
    const before = makeFolderDb(db).getById(folderId)!.media_domain_evidence
    metadata.getTMDBDetail.mockRejectedValueOnce(new Error('provider unavailable'))
    expect((await refresh()).status).toBe(500)
    expect(makeFolderDb(db).getById(folderId)!.media_domain_evidence).toBe(before)
    metadata.getTMDBDetail.mockResolvedValueOnce(null)
    metadata.getTMDBPoster.mockResolvedValueOnce(null)
    expect(await (await refresh()).json()).toMatchObject({ media_domain: 'live_action', media_domain_source: 'metadata' })
  })

  it('re-reads manual intent after the awaited refresh and leaves the child binding intact', async () => {
    metadata.getTMDBDetail.mockImplementationOnce(async () => {
      sqlRun(db, "UPDATE folders SET media_domain_override='unknown' WHERE id=?", folderId)
      return { posterUrl: null, domainEvidence: candidateDomainEvidence('tmdb', { tmdbId: 42, mediaType: 'tv', genreIds: [16] }) }
    })
    metadata.getTMDBPoster.mockResolvedValueOnce(null)
    expect(await (await refresh()).json()).toMatchObject({ media_domain_override: 'unknown', media_domain: 'unknown', media_domain_source: 'manual' })
    expect(makeFolderDb(db).getById(folderId)).toMatchObject({ anilist_id: 42, tmdb_media_type: 'tv' })
  })

  it('rejects a stale refresh when the binding changes while the request is in flight', async () => {
    metadata.getTMDBDetail.mockImplementationOnce(async () => {
      makeFolderDb(db).updateAnilist(folderId, { source: 'bangumi', anilistId: 99, hasPoster: false,
        domainEvidence: candidateDomainEvidence('bangumi', { bgmId: 99, type: 2 }) })
      return { posterUrl: null, domainEvidence: candidateDomainEvidence('tmdb', { tmdbId: 42, mediaType: 'tv', genreIds: [18] }) }
    })
    metadata.getTMDBPoster.mockResolvedValueOnce(null)
    expect((await refresh()).status).toBe(409)
    expect(makeFolderDb(db).getById(folderId)).toMatchObject({ source: 'bangumi', anilist_id: 99 })
  })

  it('display selection and no-op synopsis responses use the same resolved classification', async () => {
    const selected = await requestLocalHttp(server, `/api/folders/${rootId}/display-metadata`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId }),
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ media_domain: 'live_action', media_domain_reason: 'display_metadata' })
    makeFolderDb(db).updateAnilist(folderId, { source: 'anilist', anilistId: 24, hasPoster: false })
    metadata.findPreferredBangumiSynopsis.mockResolvedValueOnce(null)
    const synopsis = await requestLocalHttp(server, `/api/folders/${folderId}/prefer-bangumi-synopsis`, { method: 'POST' })
    expect(await synopsis.json()).toMatchObject({ media_domain: 'anime', media_domain_source: 'metadata' })
    expect(makeFolderDb(db).getById(folderId)?.media_domain_override).toBeNull()
  })
})
