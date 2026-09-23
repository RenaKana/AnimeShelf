import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFolderDb } from '../../db/folders'
import { makeFileDb } from '../../db/files'
import { makeLibraryDb } from '../../db/libraries'
import { sqlAll, sqlGet, sqlRun } from '../../db/sql'
import { restoreDatabaseTables } from '../../db/restore-tables'
import { presentFolders, resolveFolderMediaDomain, setDisplayMetadataFolder } from '../folder-presentation'
import { candidateDomainEvidence, resolveMediaDomain } from '../../../shared/media-domain'
import { classifyFavorite } from '../../../shared/favorite-media-domain'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'
import { requestLocalHttp } from './http-test-client'

const instance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => '' } }))
vi.mock('../../db/instance', () => instance)

describe('item media-domain policy', () => {
  const anime = candidateDomainEvidence('bangumi', { bgmId: 1, type: 2 })
  const live = candidateDomainEvidence('tmdb', { tmdbId: 2, mediaType: 'tv', genreIds: [18] })
  it.each(['anime', 'live_action', 'unknown'] as const)('keeps explicit %s above all evidence and defaults', override => {
    expect(resolveMediaDomain({ override, evidence: [...anime, ...live], libraryType: 'anime' })).toMatchObject({ media_domain: override, media_domain_source: 'manual' })
  })
  it('falls back only when evidence is absent, never when insufficient, invalid or conflicting', () => {
    expect(resolveMediaDomain({ libraryType: 'movie' })).toMatchObject({ media_domain: 'live_action', media_domain_source: 'library_default' })
    for (const evidence of [[], '{bad-json', candidateDomainEvidence('tmdb', { tmdbId: 4, mediaType: 'movie' })]) {
      expect(resolveMediaDomain({ evidence, libraryType: 'anime' })).toMatchObject({ media_domain: 'unknown', media_domain_reason: 'insufficient' })
    }
    expect(resolveMediaDomain({ evidence: [...anime, ...live], libraryType: 'anime' })).toMatchObject({ media_domain: 'unknown', media_domain_reason: 'conflict' })
    expect(resolveMediaDomain({})).toMatchObject({ media_domain: 'unknown', media_domain_reason: 'missing' })
  })
  it('uses confirmation above automatic inference and distinguishes format from domain', () => {
    expect(resolveMediaDomain({ evidence: [...anime, ...live.map(entry => ({ ...entry, authority: 'automatic' }))] }).media_domain).toBe('anime')
    expect(resolveMediaDomain({ evidence: candidateDomainEvidence('tmdb', { tmdbId: 3, mediaType: 'movie', genreIds: [16, 18] }) }).media_domain).toBe('anime')
  })
})

describe('persisted item classification and API', () => {
  let db: any
  let server: any
  let directory: string
  let libraryId: number
  let rows: ReturnType<ReturnType<typeof makeFolderDb>['getByLibrary']>

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-item-domain-'))
    db = createDb(path.join(directory, 'fixture.db'))
    instance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false })
    libraryId = makeLibraryDb(db).create('Mixed', 'D:\\Mixed', 'anime').id
    makeFolderDb(db).upsertTree(libraryId, ['D:\\Mixed', ...['Animation', 'Live', 'Bare', 'Insufficient', 'Conflict', 'Manual'].map(name => `D:\\Mixed\\${name}`)])
    rows = makeFolderDb(db).getByLibrary(libraryId).filter(row => row.parent_id != null)
    const files = makeFileDb(db)
    for (const row of rows) {
      sqlRun(db, 'UPDATE folders SET is_series=1 WHERE id=?', row.id)
      files.upsertMany(libraryId, [{ folder_id: row.id, path: `${row.path}\\01.mkv`, name: '01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    }
    const bind = (name: string, type: number) => makeFolderDb(db).updateAnilist(id(name), { source: 'bangumi', anilistId: id(name), hasPoster: false, domainEvidence: candidateDomainEvidence('bangumi', { bgmId: id(name), type }) })
    bind('Animation', 2); bind('Live', 6)
    makeFolderDb(db).updateAnilist(id('Insufficient'), { source: 'bangumi', anilistId: 300, hasPoster: false })
    bind('Conflict', 2)
    sqlRun(db, 'UPDATE folders SET media_domain_evidence=? WHERE id=?', [JSON.stringify([2, 6].flatMap(type => candidateDomainEvidence('bangumi', { bgmId: id('Conflict'), type }))), id('Conflict')])
    sqlRun(db, "UPDATE folders SET media_domain_override='unknown' WHERE id=?", id('Manual'))
    const router = (await import('../../routes/folders')).default
    const app = express(); app.use(express.json()); app.use('/api/folders', router)
    server = await new Promise<any>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)) })
  })
  function id(name: string) { return rows.find(row => row.name === name)!.id }
  async function list(domain: string) {
    const response = await requestLocalHttp(server, `/api/folders?type=series&libraryId=${libraryId}&mediaDomain=${domain}`)
    expect(response.status).toBe(200)
    return response.json() as Promise<any[]>
  }
  async function setOverride(folderId: number, override: unknown, owner = true) {
    return requestLocalHttp(server, `/api/folders/${folderId}/media-domain`, { method: 'PUT', body: JSON.stringify({ override }), headers: { 'content-type': 'application/json', ...(owner ? { 'X-AnimeShelf-Owner': '1' } : {}) } })
  }
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (db?.isOpen) db.close()
    instance.db = undefined
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('animeshelf-item-domain-')) throw new Error('Unsafe test cleanup')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  it('classifies a mixed library by item, and library changes only affect absence', async () => {
    expect((await list('anime')).map(row => row.name).sort()).toEqual(['Animation', 'Bare'])
    expect((await list('live_action')).map(row => row.name)).toEqual(['Live'])
    expect((await list('unknown')).map(row => row.name).sort()).toEqual(['Conflict', 'Insufficient', 'Manual'])
    sqlRun(db, "UPDATE libraries SET type='live_action' WHERE id=?", libraryId)
    expect((await list('anime')).map(row => row.name)).toEqual(['Animation'])
    expect((await list('live_action')).map(row => row.name).sort()).toEqual(['Bare', 'Live'])
    expect((await list('all'))).toHaveLength(6)
  })
  it('requires owner access, validates overrides and round-trips null separately from unknown', async () => {
    expect((await setOverride(id('Live'), 'anime', false)).status).toBe(403)
    expect((await setOverride(id('Live'), 'movie')).status).toBe(400)
    expect((await setOverride(999999, 'anime')).status).toBe(404)
    for (const override of ['anime', 'live_action', 'unknown', null]) {
      const response = await setOverride(id('Live'), override)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ media_domain_override: override, media_domain: override ?? 'live_action' })
    }
  })
  it('owner-gates explicit batch classification, reports missing IDs and refreshes filtered groups', async () => {
    const body = JSON.stringify({ ids: [id('Animation'), 999999], override: 'live_action' })
    const url = '/api/folders/batch/media-domain'
    expect((await requestLocalHttp(server, url, { method: 'PUT', body, headers: { 'content-type': 'application/json' } })).status).toBe(403)
    const response = await requestLocalHttp(server, url, { method: 'PUT', body, headers: { 'content-type': 'application/json', 'X-AnimeShelf-Owner': '1' } })
    expect(response.status).toBe(200)
    expect((await response.json()).results).toEqual(expect.arrayContaining([{ id: id('Animation'), ok: true }, { id: 999999, ok: false, error: '条目已不存在' }]))
    expect((await list('anime')).map(row => row.name)).toEqual(['Bare'])
    expect((await list('live_action')).map(row => row.name).sort()).toEqual(['Animation', 'Live'])
  })
  it('root classification follows display metadata without writing child overrides', async () => {
    const root = makeFolderDb(db).getByLibrary(libraryId).find(row => row.parent_id == null)!
    setDisplayMetadataFolder(db, root.id, id('Live'))
    expect(resolveFolderMediaDomain(db, root.id)?.media_domain).toBe('live_action')
    await setOverride(root.id, 'unknown')
    setDisplayMetadataFolder(db, root.id, id('Animation'))
    expect(resolveFolderMediaDomain(db, root.id)?.media_domain).toBe('unknown')
    await setOverride(root.id, null)
    expect(resolveFolderMediaDomain(db, root.id)?.media_domain).toBe('anime')
    expect(makeFolderDb(db).getById(id('Animation'))?.media_domain_override).toBeNull()
    expect(makeFolderDb(db).getById(id('Live'))?.media_domain_override).toBeNull()
  })
  it('preserves manual intent through metadata binding, scan upsert, reopen and restore', async () => {
    await setOverride(id('Live'), 'unknown')
    const favoriteEvidence = JSON.stringify(candidateDomainEvidence('bangumi', { bgmId: 17, type: 2 }))
    sqlRun(db, `INSERT INTO season_favorites(item_id,title,media_type,media_domain_override,media_domain_evidence)
      VALUES('manual-bangumi-17','Independent favorite','anime','unknown',?)`, favoriteEvidence)
    const { bindTMDB } = await import('../../../modules/metadata/server/metadata')
    await bindTMDB(id('Live'), { tmdbId: 99, mediaType: 'movie', title: 'Live', originalTitle: null, year: 2020, rating: null, genres: [], genreIds: [18], synopsis: null, seasons: null, posterUrl: null, posterPath: null }, db)
    makeFolderDb(db).upsertTree(libraryId, rows.map(row => row.path))
    db.close(); db = createDb(path.join(directory, 'fixture.db')); instance.db = db
    expect(resolveFolderMediaDomain(db, id('Live'))).toMatchObject({ media_domain: 'unknown', media_domain_source: 'manual' })
    expect(classifyFavorite(sqlGet<any>(db, "SELECT * FROM season_favorites WHERE item_id='manual-bangumi-17'")!)).toMatchObject({ media_domain: 'unknown', media_domain_source: 'manual' })
    const restored = createDb(':memory:')
    try {
      restoreDatabaseTables(restored, db)
      expect(resolveFolderMediaDomain(restored, id('Live'))).toMatchObject({ media_domain: 'unknown', media_domain_source: 'manual' })
      const favorite = sqlGet<any>(restored, "SELECT * FROM season_favorites WHERE item_id='manual-bangumi-17'")!
      expect(favorite).toMatchObject({ media_domain_override: 'unknown', media_domain_evidence: favoriteEvidence })
      expect(classifyFavorite(favorite)).toMatchObject({ media_domain: 'unknown', media_domain_source: 'manual' })
      expect(sqlAll(restored, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(sqlAll(restored, 'PRAGMA foreign_key_check')).toEqual([])
    } finally { restored.close() }
  })
  it('does not apply stale provider or movie/TV evidence to a replacement binding', () => {
    const folder = makeFolderDb(db).getById(id('Live'))!
    for (const evidence of [candidateDomainEvidence('tmdb', { tmdbId: 88, mediaType: 'movie', genreIds: [16] }), candidateDomainEvidence('tmdb', { tmdbId: 99, mediaType: 'tv', genreIds: [16] })]) {
      sqlRun(db, "UPDATE folders SET source='tmdb', anilist_id=99, tmdb_media_type='movie', media_domain_evidence=? WHERE id=?", [JSON.stringify(evidence), folder.id])
      expect(presentFolders(db, [makeFolderDb(db).getById(folder.id)!], directory)[0]).toMatchObject({ media_domain: 'unknown', media_domain_reason: 'insufficient' })
    }
  })
})
