import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import {
  getCanonicalMediaCatalogForRoot,
  rebuildLibraryMediaCatalog,
  setManualMediaCatalog,
} from '../server/media-catalog'
import { requestLocalHttp, type TestHttpRequestInit, type TestHttpResponse } from '../../../server/services/__tests__/http-test-client'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => null } }))
vi.mock('../../../server/db/instance', () => mockedInstance)

describe('collection reset routes', () => {
  let db: ReturnType<typeof createDb>
  let server: any
  let libraryId: number
  let rootId: number
  let seasonId: number
  let excludedId: number
  let nestedRootId: number
  let nestedSeasonId: number
  let otherRootId: number

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    bindTestModuleCapabilities(db)
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    libraryId = library.id
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [
      'D:\\Anime',
      'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Show A Season 1',
      'D:\\Anime\\Collection\\Show B Season 2',
      'D:\\Anime\\Collection\\Nested Collection',
      'D:\\Anime\\Collection\\Nested Collection\\Nested Season 1',
      'D:\\Anime\\Other Collection',
      'D:\\Anime\\Other Collection\\Other Season 1',
    ])
    const rows = folderDb.getByLibrary(library.id)
    const root = rows.find(folder => folder.path === 'D:\\Anime\\Collection')!
    const season = rows.find(folder => folder.path.endsWith('Collection\\Show A Season 1'))!
    const excluded = rows.find(folder => folder.path.endsWith('Collection\\Show B Season 2'))!
    const nestedRoot = rows.find(folder => folder.path.endsWith('Collection\\Nested Collection'))!
    const nestedSeason = rows.find(folder => folder.path.endsWith('Nested Collection\\Nested Season 1'))!
    const otherRoot = rows.find(folder => folder.path === 'D:\\Anime\\Other Collection')!
    const otherSeason = rows.find(folder => folder.path.endsWith('Other Collection\\Other Season 1'))!
    rootId = root.id
    seasonId = season.id
    excludedId = excluded.id
    nestedRootId = nestedRoot.id
    nestedSeasonId = nestedSeason.id
    otherRootId = otherRoot.id

    db.prepare('UPDATE folders SET pinned = 1 WHERE id IN (?, ?, ?)').run([rootId, nestedRootId, otherRootId])
    db.prepare(`
      UPDATE folders
      SET source = 'bangumi', anilist_id = CASE id
        WHEN ? THEN 1001 WHEN ? THEN 1002 WHEN ? THEN 2001 ELSE 3001 END,
        has_poster = 1, rating = 8.5, synopsis = 'keep metadata'
      WHERE id IN (?, ?, ?, ?)
    `).run([seasonId, excludedId, nestedSeasonId, seasonId, excludedId, nestedSeasonId, otherSeason.id])
    makeFileDb(db).upsertMany(library.id, [
      { path: `${season.path}\\episode.mkv`, folder_id: seasonId, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${excluded.path}\\episode.mkv`, folder_id: excludedId, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${nestedSeason.path}\\episode.mkv`, folder_id: nestedSeasonId, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${otherSeason.path}\\episode.mkv`, folder_id: otherSeason.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
    ])
    rebuildLibraryMediaCatalog(db, library.id)
    setManualMediaCatalog(db, nestedSeasonId, { kind: 'season', seasonNumbers: [8] })
    setManualMediaCatalog(db, otherSeason.id, { kind: 'season', seasonNumbers: [9] })

    const target = getCanonicalMediaCatalogForRoot(db, rootId)
    const seasonMapping = target.mappings.find(mapping => mapping.folder_id === seasonId)!
    const excludedItemId = target.mappings.find(mapping => mapping.folder_id === excludedId)!.media_item_id
    db.prepare(`
      INSERT INTO folder_media_catalog_exclusions (folder_id, manual_kind, manual_season_numbers)
      VALUES (?, 'season', '[2]')
    `).run(excludedId)
    db.prepare(`
      INSERT INTO media_work_group_exclusions (root_folder_id, media_item_id)
      VALUES (?, ?)
    `).run([rootId, excludedItemId])
    db.prepare(`
      INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
      VALUES (?, 'item:bangumi:1001', 'Wrong display', 7)
    `).run(rootId)
    db.prepare('UPDATE media_items SET manual_locked = 1 WHERE id = ?').run(seasonMapping.media_item_id)

    db.prepare(`
      INSERT INTO folder_media_catalog_exclusions (folder_id, manual_kind, manual_season_numbers)
      VALUES (?, 'season', '[8]')
    `).run(nestedSeasonId)
    db.prepare(`
      INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
      VALUES (?, 'item:bangumi:2001', 'Nested display', 2)
    `).run(nestedRootId)

    const [router, catalogRouter] = await Promise.all([
      import('../../../server/routes/folders').then(module => module.default),
      import('../server/folders').then(module => module.default),
    ])
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.use('/api/folders', router)
    app.use('/api/folders', catalogRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  function request(path: string, init: TestHttpRequestInit = {}): Promise<TestHttpResponse> {
    return requestLocalHttp(server, path, init)
  }

  async function resetToken(folderId = rootId): Promise<string> {
    const response = await request(`/api/folders/${folderId}`)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    return body.collection_reset.snapshot_version
  }

  function postReset(folderId: number, expectedSnapshotVersion: string, headers: Record<string, string> = {}) {
    return request(`/api/folders/${folderId}/collection-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ confirm: true, expected_snapshot_version: expectedSnapshotVersion }),
    })
  }

  function outsideRootState() {
    return {
      series: db.prepare('SELECT * FROM media_series WHERE root_folder_id <> ? ORDER BY id').all(rootId),
      entries: db.prepare(`
        SELECT e.* FROM folder_media_entries e JOIN media_series s ON s.id = e.series_id
        WHERE s.root_folder_id <> ? ORDER BY e.id
      `).all(rootId),
      items: db.prepare('SELECT * FROM media_items WHERE root_folder_id <> ? ORDER BY id').all(rootId),
      sources: db.prepare(`
        SELECT s.* FROM media_item_sources s JOIN media_items i ON i.id = s.media_item_id
        WHERE i.root_folder_id <> ? ORDER BY s.id
      `).all(rootId),
      groups: db.prepare('SELECT * FROM media_work_groups WHERE root_folder_id <> ? ORDER BY id').all(rootId),
      members: db.prepare(`
        SELECT m.* FROM media_work_group_members m JOIN media_work_groups g ON g.id = m.work_group_id
        WHERE g.root_folder_id <> ? ORDER BY m.id
      `).all(rootId),
      groupExclusions: db.prepare('SELECT * FROM media_work_group_exclusions WHERE root_folder_id <> ? ORDER BY id').all(rootId),
      mappings: db.prepare('SELECT * FROM folder_media_mappings WHERE root_folder_id <> ? ORDER BY id').all(rootId),
      folderExclusions: db.prepare(`
        SELECT e.* FROM folder_media_catalog_exclusions e
        WHERE e.folder_id IN (?, ?) ORDER BY e.folder_id
      `).all([nestedSeasonId, otherRootId]),
      presentation: db.prepare('SELECT * FROM media_collection_presentation WHERE root_folder_id <> ? ORDER BY root_folder_id, entry_key').all(rootId),
    }
  }

  it('fully resets only the requested pinned collection and rebuilds it from current physical evidence', async () => {
    const physicalBefore = {
      folders: db.prepare(`
        SELECT id, parent_id, name, path, is_series, pinned, anilist_id, source,
               has_poster, rating, synopsis
        FROM folders ORDER BY id
      `).all(),
      files: db.prepare('SELECT * FROM files ORDER BY id').all(),
    }
    const outsideBefore = outsideRootState()

    const detail = await request(`/api/folders/${rootId}`)
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as any
    expect(detailBody.collection_reset?.snapshot_version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(detailBody.collection_artwork).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seasonId }),
      expect.objectContaining({ id: excludedId }),
    ]))

    const response = await request(`/api/folders/${rootId}/collection-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirm: true,
        expected_snapshot_version: detailBody.collection_reset.snapshot_version,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.collection_reset).toMatchObject({
      root_folder_id: rootId,
      before_snapshot_version: detailBody.collection_reset.snapshot_version,
      after_snapshot_version: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(body.media_catalog_v2.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: seasonId, kind: 'season', season_number: 1, manual_locked: 0 }),
      expect.objectContaining({ folder_id: excludedId, kind: 'season', season_number: 2, manual_locked: 0 }),
    ]))
    expect(body.media_catalog_v2.items.every((item: any) => item.manual_locked === 0)).toBe(true)
    expect(body.media_catalog_v2.work_groups.every((group: any) =>
      group.manual_locked === 0 && group.members.every((member: any) => member.manual_locked === 0))).toBe(true)
    expect(body.media_catalog_summary.manual_count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_collection_presentation WHERE root_folder_id = ?').get(rootId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_work_group_exclusions WHERE root_folder_id = ?').get(rootId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_catalog_exclusions WHERE folder_id = ?').get(excludedId)).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM folder_media_mappings
      WHERE root_folder_id = ? AND manual_locked = 1
    `).get(rootId)).toEqual({ count: 0 })
    expect(outsideRootState()).toEqual(outsideBefore)
    expect({
      folders: db.prepare(`
        SELECT id, parent_id, name, path, is_series, pinned, anilist_id, source,
               has_poster, rating, synopsis
        FROM folders ORDER BY id
      `).all(),
      files: db.prepare('SELECT * FROM files ORDER BY id').all(),
    }).toEqual(physicalBefore)
  })

  it('versions presentation and exclusions and rejects stale or unsafe requests', async () => {
    const first = await resetToken()
    db.prepare(`
      UPDATE media_collection_presentation SET display_title = 'Changed elsewhere'
      WHERE root_folder_id = ?
    `).run(rootId)
    const afterPresentation = await resetToken()
    expect(afterPresentation).not.toBe(first)
    db.prepare(`
      UPDATE folder_media_catalog_exclusions SET manual_season_numbers = '[7]'
      WHERE folder_id = ?
    `).run(excludedId)
    const afterExclusion = await resetToken()
    expect(afterExclusion).not.toBe(afterPresentation)
    const stale = await postReset(rootId, first)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'COLLECTION_RESET_STALE' })

    const child = await postReset(seasonId, afterExclusion)
    expect(child.status).toBe(409)
    expect(await child.json()).toMatchObject({ code: 'COLLECTION_RESET_REQUIRES_PINNED_ROOT' })

    const untrusted = await postReset(rootId, afterExclusion, { origin: 'https://example.com' })
    expect(untrusted.status).toBe(403)
    expect(await untrusted.json()).toMatchObject({ code: 'LOCAL_REQUEST_REQUIRED' })

    const malformed = await request(`/api/folders/${rootId}/collection-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: false, expected_snapshot_version: afterExclusion, extra: true }),
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_COLLECTION_RESET_INPUT' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_collection_presentation WHERE root_folder_id = ?').get(rootId)).toEqual({ count: 1 })
  })

  it('rolls the complete reset back when scoped reconstruction fails', async () => {
    const before = {
      series: db.prepare('SELECT * FROM media_series ORDER BY id').all(),
      entries: db.prepare('SELECT * FROM folder_media_entries ORDER BY id').all(),
      items: db.prepare('SELECT * FROM media_items ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM media_item_sources ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM media_work_groups ORDER BY id').all(),
      members: db.prepare('SELECT * FROM media_work_group_members ORDER BY id').all(),
      groupExclusions: db.prepare('SELECT * FROM media_work_group_exclusions ORDER BY id').all(),
      mappings: db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all(),
      folderExclusions: db.prepare('SELECT * FROM folder_media_catalog_exclusions ORDER BY folder_id').all(),
      presentation: db.prepare('SELECT * FROM media_collection_presentation ORDER BY root_folder_id, entry_key').all(),
    }
    const token = await resetToken()
    db.exec(`
      CREATE TRIGGER reject_collection_reset_rebuild
      BEFORE INSERT ON media_items
      WHEN NEW.root_folder_id = ${rootId}
      BEGIN
        SELECT RAISE(ABORT, 'forced reset rebuild failure');
      END;
    `)

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await postReset(rootId, token)
    errorLog.mockRestore()

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'MEDIA_CATALOG_OPERATION_FAILED' })
    expect({
      series: db.prepare('SELECT * FROM media_series ORDER BY id').all(),
      entries: db.prepare('SELECT * FROM folder_media_entries ORDER BY id').all(),
      items: db.prepare('SELECT * FROM media_items ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM media_item_sources ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM media_work_groups ORDER BY id').all(),
      members: db.prepare('SELECT * FROM media_work_group_members ORDER BY id').all(),
      groupExclusions: db.prepare('SELECT * FROM media_work_group_exclusions ORDER BY id').all(),
      mappings: db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all(),
      folderExclusions: db.prepare('SELECT * FROM folder_media_catalog_exclusions ORDER BY folder_id').all(),
      presentation: db.prepare('SELECT * FROM media_collection_presentation ORDER BY root_folder_id, entry_key').all(),
    }).toEqual(before)
  })

  it('fails closed when another root owns the same provider source without sharing rows', async () => {
    const foreignItem = db.prepare(`
      SELECT id FROM media_items WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(otherRootId) as { id: number }
    db.prepare(`
      INSERT INTO media_item_sources (media_item_id, source, external_id, is_primary)
      VALUES (?, 'bangumi', '1001', 0)
    `).run(foreignItem.id)
    const before = outsideRootState()
    const token = await resetToken()

    const response = await postReset(rootId, token)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'COLLECTION_RESET_SOURCE_SCOPE_CONFLICT' })
    expect(outsideRootState()).toEqual(before)
  })

  it('fails closed when a target-scope folder has a manual entry owned by another root', async () => {
    const foreignSeries = db.prepare(`
      SELECT id FROM media_series WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(otherRootId) as { id: number }
    db.prepare(`
      INSERT INTO folder_media_entries (
        folder_id, series_id, kind, season_number, confidence,
        detected_by, manual_locked
      ) VALUES (?, ?, 'season', 6, 1, 'manual', 1)
    `).run([seasonId, foreignSeries.id])
    const before = {
      series: db.prepare('SELECT * FROM media_series ORDER BY id').all(),
      entries: db.prepare('SELECT * FROM folder_media_entries ORDER BY id').all(),
      items: db.prepare('SELECT * FROM media_items ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM media_work_groups ORDER BY id').all(),
      mappings: db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all(),
    }
    const token = await resetToken()

    const response = await postReset(rootId, token)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'COLLECTION_RESET_SCOPE_CONFLICT' })
    expect({
      series: db.prepare('SELECT * FROM media_series ORDER BY id').all(),
      entries: db.prepare('SELECT * FROM folder_media_entries ORDER BY id').all(),
      items: db.prepare('SELECT * FROM media_items ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM media_work_groups ORDER BY id').all(),
      mappings: db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all(),
    }).toEqual(before)
  })

  it('fails closed when a target-scope folder has a canonical mapping owned by another root', async () => {
    const foreignSeries = db.prepare(`
      SELECT id FROM media_series WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(otherRootId) as { id: number }
    const foreignItem = db.prepare(`
      SELECT id FROM media_items WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(otherRootId) as { id: number }
    db.prepare(`
      INSERT INTO folder_media_mappings (
        folder_id, media_item_id, root_folder_id, series_id, content_role,
        kind, season_number, confidence, detected_by, manual_locked
      ) VALUES (?, ?, ?, ?, 'main', 'season', 6, 1, 'manual', 1)
    `).run([seasonId, foreignItem.id, otherRootId, foreignSeries.id])
    const before = db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()
    const token = await resetToken()

    const response = await postReset(rootId, token)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'COLLECTION_RESET_SCOPE_CONFLICT' })
    expect(db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()).toEqual(before)
  })

  it('fails closed when a target-owned canonical mapping points into a nested pinned root', async () => {
    const targetSeries = db.prepare(`
      SELECT id FROM media_series WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(rootId) as { id: number }
    const targetItem = db.prepare(`
      SELECT id FROM media_items WHERE root_folder_id = ? ORDER BY id LIMIT 1
    `).get(rootId) as { id: number }
    db.prepare(`
      INSERT INTO folder_media_mappings (
        folder_id, media_item_id, root_folder_id, series_id, content_role,
        kind, season_number, confidence, detected_by, manual_locked
      ) VALUES (?, ?, ?, ?, 'main', 'season', 7, 1, 'manual', 1)
    `).run([nestedSeasonId, targetItem.id, rootId, targetSeries.id])
    const before = db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()
    const token = await resetToken()

    const response = await postReset(rootId, token)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'COLLECTION_RESET_SCOPE_CONFLICT' })
    expect(db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()).toEqual(before)
  })
})
