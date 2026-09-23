import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { getCanonicalMediaCatalogForRoot, rebuildLibraryMediaCatalog } from '../server/media-catalog'
import { requestLocalHttp, type TestHttpRequestInit, type TestHttpResponse } from '../../../server/services/__tests__/http-test-client'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => null } }))
vi.mock('../../../server/db/instance', () => mockedInstance)

describe('collection presentation routes', () => {
  let db: ReturnType<typeof createDb>
  let server: any
  let libraryId: number
  let rootId: number
  let childId: number
  let otherRootId: number
  let itemKey: string
  let groupKey: string
  let otherItemKey: string
  let sourceItemId: number
  let sourceGroupId: number
  let targetGroupId: number
  let otherGroupId: number

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
      'D:\\Anime\\Collection\\Show A',
      'D:\\Anime\\Collection\\Show A\\Season 1',
      'D:\\Anime\\Collection\\Show C',
      'D:\\Anime\\Collection\\Show C\\Season 1',
      'D:\\Anime\\Other Collection',
      'D:\\Anime\\Other Collection\\Show B',
      'D:\\Anime\\Other Collection\\Show B\\Season 1',
    ])
    const rows = folderDb.getByLibrary(library.id)
    const root = rows.find(folder => folder.path === 'D:\\Anime\\Collection')!
    const season = rows.find(folder => folder.path === 'D:\\Anime\\Collection\\Show A\\Season 1')!
    const targetSeason = rows.find(folder => folder.path === 'D:\\Anime\\Collection\\Show C\\Season 1')!
    const otherRoot = rows.find(folder => folder.path === 'D:\\Anime\\Other Collection')!
    const otherSeason = rows.find(folder => folder.path === 'D:\\Anime\\Other Collection\\Show B\\Season 1')!
    rootId = root.id
    childId = season.id
    otherRootId = otherRoot.id

    db.prepare('UPDATE folders SET pinned = 1 WHERE id IN (?, ?)').run([root.id, otherRoot.id])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ? WHERE id = ?").run([9101, season.id])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ? WHERE id = ?").run([9102, targetSeason.id])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ? WHERE id = ?").run([9201, otherSeason.id])
    makeFileDb(db).upsertMany(library.id, [
      { path: `${season.path}\\episode.mkv`, folder_id: season.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${targetSeason.path}\\episode.mkv`, folder_id: targetSeason.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${otherSeason.path}\\episode.mkv`, folder_id: otherSeason.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
    ])
    rebuildLibraryMediaCatalog(db, library.id)

    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id)!
    const otherSnapshot = getCanonicalMediaCatalogForRoot(db, otherRoot.id)!
    expect(snapshot.items.length).toBeGreaterThan(0)
    expect(snapshot.work_groups.length).toBeGreaterThanOrEqual(2)
    expect(otherSnapshot.items.length).toBeGreaterThan(0)
    const presentedItem = db.prepare(`
      SELECT i.item_key
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id = ?
      ORDER BY m.id LIMIT 1
    `).get(season.id) as { item_key: string }
    itemKey = `item:${presentedItem.item_key}`
    groupKey = `group:${snapshot.work_groups[0].group_key}`
    otherItemKey = `item:${otherSnapshot.items[0].item_key}`
    const sourceGroup = snapshot.work_groups[0]
    const targetGroup = snapshot.work_groups[1]
    sourceItemId = sourceGroup.item_ids[0]
    sourceGroupId = sourceGroup.id
    targetGroupId = targetGroup.id
    otherGroupId = otherSnapshot.work_groups[0].id

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

  function patchPresentation(folderId: number, updates: unknown[], headers: Record<string, string> = {}) {
    return request(`/api/folders/${folderId}/collection-presentation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ updates }),
    })
  }

  function putMemberGroup(folderId: number, itemId: number, groupId: number | null, headers: Record<string, string> = {}) {
    return request(`/api/folders/${folderId}/collection-members/${itemId}/group`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ groupId }),
    })
  }

  function storedRows() {
    return db.prepare(`
      SELECT entry_key AS key, display_title AS title, position
      FROM media_collection_presentation
      WHERE root_folder_id = ?
      ORDER BY entry_key
    `).all(rootId)
  }

  it('returns persisted overrides only with no-store caching', async () => {
    db.prepare(`
      INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
      VALUES (?, ?, ?, ?)
    `).run([rootId, itemKey, 'Saved title', 4])

    const response = await request(`/api/folders/${rootId}/collection-presentation`)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(await response.json()).toEqual({
      entries: [{ key: itemKey, title: 'Saved title', position: 4 }],
    })
  })

  it('patches only provided fields and removes entries after both fields reset', async () => {
    const initial = await patchPresentation(rootId, [
      { key: itemKey, title: '  Personal title  ', position: 2 },
      { key: groupKey, position: 1 },
    ])
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      entries: [
        { key: groupKey, title: null, position: 1 },
        { key: itemKey, title: 'Personal title', position: 2 },
      ],
    })

    const positionOnly = await patchPresentation(rootId, [{ key: itemKey, position: 0 }])
    expect(positionOnly.status).toBe(200)
    expect(storedRows()).toEqual(expect.arrayContaining([
      { key: itemKey, title: 'Personal title', position: 0 },
    ]))

    const clearPosition = await patchPresentation(rootId, [{ key: groupKey, position: null }])
    expect(clearPosition.status).toBe(200)
    expect(storedRows()).toEqual([{ key: itemKey, title: 'Personal title', position: 0 }])

    const clearItem = await patchPresentation(rootId, [{ key: itemKey, title: null, position: null }])
    expect(clearItem.status).toBe(200)
    expect(await clearItem.json()).toEqual({ entries: [] })
  })

  it('validates the complete batch before writing any update', async () => {
    const seeded = await patchPresentation(rootId, [{ key: itemKey, title: 'Before', position: 1 }])
    expect(seeded.status).toBe(200)

    const invalid = await patchPresentation(rootId, [
      { key: itemKey, title: 'Must roll back', position: 9 },
      { key: 'item:not-current', position: 3 },
    ])

    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ code: 'COLLECTION_PRESENTATION_SCOPE_MISMATCH' })
    expect(storedRows()).toEqual([{ key: itemKey, title: 'Before', position: 1 }])
  })

  it('rejects malformed batches, duplicate keys, unsupported group titles, and excess updates', async () => {
    const invalidCases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { updates: [{ key: itemKey, title: 'Valid' }], extra: true }, code: 'INVALID_COLLECTION_PRESENTATION_INPUT' },
      { body: { updates: [{ key: itemKey, title: 'Valid', extra: true }] }, code: 'INVALID_COLLECTION_PRESENTATION_UPDATE' },
      { body: { updates: [{ key: itemKey, position: -1 }] }, code: 'INVALID_COLLECTION_PRESENTATION_POSITION' },
      { body: { updates: [{ key: itemKey, position: 1.5 }] }, code: 'INVALID_COLLECTION_PRESENTATION_POSITION' },
      { body: { updates: [{ key: itemKey, title: '   ' }] }, code: 'INVALID_COLLECTION_PRESENTATION_TITLE' },
      { body: { updates: [{ key: itemKey, title: 'x'.repeat(201) }] }, code: 'INVALID_COLLECTION_PRESENTATION_TITLE' },
      { body: { updates: [{ key: itemKey }, { key: itemKey, position: 1 }] }, code: 'DUPLICATE_COLLECTION_PRESENTATION_KEY' },
      { body: { updates: [{ key: groupKey, title: 'Wrong API' }] }, code: 'COLLECTION_PRESENTATION_GROUP_TITLE_UNSUPPORTED' },
      { body: { updates: Array.from({ length: 2001 }, (_, position) => ({ key: `item:${position}`, position })) }, code: 'COLLECTION_PRESENTATION_TOO_MANY_UPDATES' },
    ]

    for (const { body, code } of invalidCases) {
      const response = await request(`/api/folders/${rootId}/collection-presentation`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code })
    }
    expect(storedRows()).toEqual([])
  })

  it('requires the exact pinned root, rejects cross-root keys, and enforces the local mutation guard', async () => {
    const childRead = await request(`/api/folders/${childId}/collection-presentation`)
    expect(childRead.status).toBe(409)
    expect(await childRead.json()).toMatchObject({ code: 'COLLECTION_PRESENTATION_REQUIRES_PINNED_ROOT' })

    const wrongRoot = await patchPresentation(rootId, [{ key: otherItemKey, position: 1 }])
    expect(wrongRoot.status).toBe(409)
    expect(await wrongRoot.json()).toMatchObject({ code: 'COLLECTION_PRESENTATION_SCOPE_MISMATCH' })

    const untrusted = await patchPresentation(rootId, [{ key: itemKey, position: 1 }], {
      origin: 'https://example.com',
    })
    expect(untrusted.status).toBe(403)
    expect(await untrusted.json()).toMatchObject({ code: 'LOCAL_REQUEST_REQUIRED' })
    expect(storedRows()).toEqual([])
  })

  it('does not mutate semantic catalog rows and keeps overrides across a canonical rebuild', async () => {
    const beforeItems = db.prepare('SELECT id, root_folder_id, item_key, title FROM media_items ORDER BY id').all()
    const beforeGroups = db.prepare('SELECT id, root_folder_id, group_key, title FROM media_work_groups ORDER BY id').all()
    const beforeFiles = db.prepare('SELECT id, folder_id, path FROM files ORDER BY id').all()

    const updated = await patchPresentation(rootId, [{ key: itemKey, title: 'Personal', position: 7 }])
    expect(updated.status).toBe(200)
    expect(db.prepare('SELECT id, root_folder_id, item_key, title FROM media_items ORDER BY id').all()).toEqual(beforeItems)
    expect(db.prepare('SELECT id, root_folder_id, group_key, title FROM media_work_groups ORDER BY id').all()).toEqual(beforeGroups)
    expect(db.prepare('SELECT id, folder_id, path FROM files ORDER BY id').all()).toEqual(beforeFiles)

    rebuildLibraryMediaCatalog(db, libraryId)
    const response = await request(`/api/folders/${rootId}/collection-presentation`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      entries: [{ key: itemKey, title: 'Personal', position: 7 }],
    })
  })

  it('keeps the base presentation identity when a mapped item receives a custom label alias', async () => {
    const saved = await patchPresentation(rootId, [{ key: itemKey, title: 'TV title', position: 5 }])
    expect(saved.status).toBe(200)

    const custom = await request(`/api/folders/${childId}/media-catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'custom', customLabel: 'TV' }),
    })
    expect(custom.status).toBe(200)
    const mapped = db.prepare(`
      SELECT i.item_key, m.custom_label, m.manual_locked
      FROM folder_media_mappings m
      JOIN media_items i ON i.id = m.media_item_id
      WHERE m.folder_id = ?
      ORDER BY m.manual_locked DESC, m.id DESC LIMIT 1
    `).get(childId) as { item_key: string; custom_label: string | null; manual_locked: number }
    expect(mapped).toMatchObject({ custom_label: 'TV', manual_locked: 1 })
    expect(mapped.item_key).toBe(`custom:TV:${itemKey.slice('item:'.length)}`)

    const reordered = await patchPresentation(rootId, [{ key: itemKey, position: 2 }])
    expect(reordered.status).toBe(200)
    expect(await reordered.json()).toEqual({
      entries: [{ key: itemKey, title: 'TV title', position: 2 }],
    })
  })

  it('reads an empty pinned collection without building a canonical catalog', async () => {
    const [empty] = makeFolderDb(db).upsertTree(libraryId, ['D:\\Anime\\Empty Collection'])
    db.prepare('UPDATE folders SET pinned = 1 WHERE id = ?').run(empty.id)
    db.exec(`
      CREATE TRIGGER reject_unexpected_catalog_build
      BEFORE INSERT ON media_items
      BEGIN
        SELECT RAISE(ABORT, 'GET attempted a catalog build');
      END;
    `)

    const response = await request(`/api/folders/${empty.id}/collection-presentation`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entries: [] })
  })

  it('atomically moves a current item to another group and removes only its newly orphaned old group', async () => {
    const beforeGroups = db.prepare('SELECT id FROM media_work_groups WHERE root_folder_id = ? ORDER BY id').all(rootId) as Array<{ id: number }>

    const response = await putMemberGroup(rootId, sourceItemId, targetGroupId)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetGroupId,
        members: expect.arrayContaining([
          expect.objectContaining({ media_item_id: sourceItemId, manual_locked: 1 }),
        ]),
      }),
    ]))
    expect(db.prepare(`
      SELECT work_group_id, manual_locked
      FROM media_work_group_members WHERE media_item_id = ?
    `).get(sourceItemId)).toEqual({ work_group_id: targetGroupId, manual_locked: 1 })
    expect(db.prepare('SELECT 1 FROM media_work_group_exclusions WHERE root_folder_id = ? AND media_item_id = ?').get([rootId, sourceItemId])).toBeNull()
    expect(db.prepare('SELECT 1 FROM media_work_groups WHERE id = ?').get(sourceGroupId)).toBeNull()
    expect(db.prepare('SELECT id FROM media_work_groups WHERE root_folder_id = ? ORDER BY id').all(rootId)).toEqual(
      beforeGroups.filter(group => group.id !== sourceGroupId),
    )
  })

  it('detaches to a durable explicit exclusion that survives catalog rebuild', async () => {
    const response = await putMemberGroup(rootId, sourceItemId, null)

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT 1 FROM media_work_group_members WHERE media_item_id = ?').get(sourceItemId)).toBeNull()
    expect(db.prepare(`
      SELECT root_folder_id, media_item_id
      FROM media_work_group_exclusions WHERE root_folder_id = ? AND media_item_id = ?
    `).get([rootId, sourceItemId])).toEqual({ root_folder_id: rootId, media_item_id: sourceItemId })
    expect(db.prepare('SELECT 1 FROM media_work_groups WHERE id = ?').get(sourceGroupId)).toBeNull()

    rebuildLibraryMediaCatalog(db, libraryId)
    const snapshot = getCanonicalMediaCatalogForRoot(db, rootId)!
    expect(snapshot.ungrouped_item_ids).toContain(sourceItemId)
    expect(snapshot.work_groups.every(group => !group.item_ids.includes(sourceItemId))).toBe(true)
  })

  it('rejects cross-root membership moves before changing membership state', async () => {
    const beforeMember = db.prepare(`
      SELECT work_group_id, relation_role, manual_locked
      FROM media_work_group_members WHERE media_item_id = ?
    `).get(sourceItemId)
    const beforeGroups = db.prepare('SELECT id, group_key FROM media_work_groups ORDER BY id').all()
    const beforeExclusions = db.prepare('SELECT root_folder_id, media_item_id FROM media_work_group_exclusions ORDER BY root_folder_id, media_item_id').all()

    const response = await putMemberGroup(rootId, sourceItemId, otherGroupId)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'MEDIA_WORK_GROUP_SCOPE_MISMATCH' })
    expect(db.prepare(`
      SELECT work_group_id, relation_role, manual_locked
      FROM media_work_group_members WHERE media_item_id = ?
    `).get(sourceItemId)).toEqual(beforeMember)
    expect(db.prepare('SELECT id, group_key FROM media_work_groups ORDER BY id').all()).toEqual(beforeGroups)
    expect(db.prepare('SELECT root_folder_id, media_item_id FROM media_work_group_exclusions ORDER BY root_folder_id, media_item_id').all()).toEqual(beforeExclusions)
  })

  it('atomically saves organization, rejects stale revisions and validates local origin', async () => {
    const initial = await request(`/api/folders/${rootId}/collection-organization`)
    expect(initial.status).toBe(200)
    const before = await initial.json()
    const organization = { ...before.organization, orderSource: 'user', watchEntries: [...before.organization.watchEntries].reverse(),
      groups: [{ id: 'stage-x', title: 'X', memberKeys: before.organization.watchEntries.map((entry: { targetKey: string }) => entry.targetKey) }] }
    const patch = (headers = {}, revision = before.revision) => request(`/api/folders/${rootId}/collection-organization`, {
      method:'PATCH', headers:{'content-type':'application/json',...headers}, body:JSON.stringify({organization,expectedRevision:revision}),
    })
    expect((await patch({origin:'https://example.com'})).status).toBe(403)
    const saved = await patch()
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({organization,revision:1})
    expect((await patch()).status).toBe(409)
    expect(await (await request(`/api/folders/${rootId}/collection-organization`)).json()).toEqual({organization,revision:1})
  })

  it('rolls back organization when durable database writes fail', async () => {
    const before = await (await request(`/api/folders/${rootId}/collection-organization`)).json()
    db.exec("CREATE TRIGGER reject_organization BEFORE INSERT ON media_collection_organization BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END")
    const result = await request(`/api/folders/${rootId}/collection-organization`, {method:'PATCH',headers:{'content-type':'application/json'},
      body:JSON.stringify({organization:{...before.organization,orderSource:'user'},expectedRevision:before.revision})})
    expect(result.status).toBe(500)
    expect(await (await request(`/api/folders/${rootId}/collection-organization`)).json()).toEqual(before)
  })

  it('requires the exact pinned root and trusted local caller for membership moves', async () => {
    const wrongRoot = await putMemberGroup(childId, sourceItemId, targetGroupId)
    expect(wrongRoot.status).toBe(409)
    expect(await wrongRoot.json()).toMatchObject({ code: 'COLLECTION_PRESENTATION_REQUIRES_PINNED_ROOT' })

    const untrusted = await putMemberGroup(rootId, sourceItemId, targetGroupId, { origin: 'https://example.com' })
    expect(untrusted.status).toBe(403)
    expect(await untrusted.json()).toMatchObject({ code: 'LOCAL_REQUEST_REQUIRED' })
    expect(db.prepare('SELECT work_group_id FROM media_work_group_members WHERE media_item_id = ?').get(sourceItemId)).toEqual({
      work_group_id: sourceGroupId,
    })
  })
})
