import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFileDb } from '../../../server/db/files'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { getCanonicalMediaCatalogForRoot, rebuildLibraryMediaCatalog } from '../server/media-catalog'
import { requestLocalHttp, type TestHttpRequestInit, type TestHttpResponse } from '../../../server/services/__tests__/http-test-client'
import { bindTestModuleCapabilities } from '../../../server/services/__tests__/module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any, settingsDb: { get: () => null } }))
vi.mock('../../../server/db/instance', () => mockedInstance)

describe('media catalog candidate routes', () => {
  let db: any
  let server: any
  let rootId: number
  let extrasId: number

  beforeAll(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    bindTestModuleCapabilities(db)
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [
      'D:\\Anime',
      'D:\\Anime\\Show',
      'D:\\Anime\\Show\\SPs',
    ])
    const rows = folderDb.getByLibrary(library.id)
    rootId = rows.find(folder => folder.path === 'D:\\Anime\\Show')!.id
    extrasId = rows.find(folder => folder.path === 'D:\\Anime\\Show\\SPs')!.id
    db.prepare('UPDATE folders SET is_series = 1 WHERE id = ?').run(rootId)
    makeFileDb(db).upsertMany(library.id, [{
      path: 'D:\\Anime\\Show\\SPs\\sp.mkv',
      folder_id: extrasId,
      name: 'sp.mkv',
      size: 1,
      date_modified: 1,
      ext: 'mkv',
    }])
    rebuildLibraryMediaCatalog(db, library.id)

    const [router, catalogRouter] = await Promise.all([
      import('../../../server/routes/folders').then(module => module.default),
      import('../server/folders').then(module => module.default),
    ])
    const app = express()
    app.use(express.json())
    app.use('/api/folders', router)
    app.use('/api/folders', catalogRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  async function request(path: string, init: TestHttpRequestInit = {}): Promise<TestHttpResponse> {
    return requestLocalHttp(server, path, init)
  }

  it('returns candidates from detail and update responses, including an exclusion reason', async () => {
    const detail = await request(`/api/folders/${rootId}`)
    expect(detail.status).toBe(200)
    const detailBody = await detail.json()
    expect(detailBody.media_catalog_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extrasId, reason: 'extras' }),
    ]))

    const excluded = await request(`/api/folders/${extrasId}/media-catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excluded: true }),
    })
    expect(excluded.status).toBe(200)
    const excludedBody = await excluded.json()
    expect(excludedBody.media_catalog_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: extrasId, reason: 'excluded', folder_name: 'SPs' }),
    ]))
  })

  it('updates the series title through a dedicated endpoint and keeps it after rebuild', async () => {
    const updated = await request(`/api/folders/${rootId}/media-catalog-title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  Custom Show  ' }),
    })
    expect(updated.status).toBe(200)
    const updatedBody = await updated.json()
    expect(updatedBody.media_catalog_summary.series_title).toBe('Custom Show')

    const rebuilt = await request(`/api/folders/${rootId}/rebuild-media-catalog`, { method: 'POST' })
    expect(rebuilt.status).toBe(200)
    const rebuiltBody = await rebuilt.json()
    expect(rebuiltBody.media_catalog_summary.series_title).toBe('Custom Show')

    const invalid = await request(`/api/folders/${rootId}/media-catalog-title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(invalid.status).toBe(400)
  })
})

describe('media catalog work-group mutation routes', () => {
  let db: any
  let server: any
  let rootId: number
  let targetGroupId: number
  let sourceGroupId: number
  let targetItemId: number
  let sourceItemId: number

  beforeEach(async () => {
    db = createDb(':memory:')
    mockedInstance.db = db
    bindTestModuleCapabilities(db)
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const folderDb = makeFolderDb(db)
    folderDb.upsertTree(library.id, [
      'D:\\Anime', 'D:\\Anime\\Collection',
      'D:\\Anime\\Collection\\Show A',
      'D:\\Anime\\Collection\\Show A\\Season 1',
      'D:\\Anime\\Collection\\Show A\\OVA',
      'D:\\Anime\\Collection\\Show B',
      'D:\\Anime\\Collection\\Show B\\Season 1',
    ])
    const rows = folderDb.getByLibrary(library.id)
    const root = rows.find(folder => folder.path === 'D:\\Anime\\Collection')!
    const seasonA = rows.find(folder => folder.path === 'D:\\Anime\\Collection\\Show A\\Season 1')!
    const ovaA = rows.find(folder => folder.path === 'D:\\Anime\\Collection\\Show A\\OVA')!
    const seasonB = rows.find(folder => folder.path === 'D:\\Anime\\Collection\\Show B\\Season 1')!
    db.prepare('UPDATE folders SET is_series = 0, pinned = 1 WHERE id = ?').run(root.id)
    makeFileDb(db).upsertMany(library.id, [
      { path: `${seasonA.path}\\episode.mkv`, folder_id: seasonA.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${ovaA.path}\\episode.mkv`, folder_id: ovaA.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
      { path: `${seasonB.path}\\episode.mkv`, folder_id: seasonB.id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' },
    ])
    db.prepare("UPDATE folders SET source = 'anilist', anilist_id = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?, ?)")
      .run([seasonA.id, 9201, ovaA.id, 9203, 9202, seasonA.id, ovaA.id, seasonB.id])
    rebuildLibraryMediaCatalog(db, library.id)
    const snapshot = getCanonicalMediaCatalogForRoot(db, root.id) as any
    const target = snapshot.work_groups.find((group: any) => group.title === 'Show A')
    const source = snapshot.work_groups.find((group: any) => group.title === 'Show B')
    rootId = root.id
    targetGroupId = target.id
    sourceGroupId = source.id
    targetItemId = target.item_ids.find((itemId: number) =>
      snapshot.items.find((item: any) => item.id === itemId)?.title === 'OVA') ?? target.item_ids[0]
    sourceItemId = source.item_ids[0]

    const [router, catalogRouter] = await Promise.all([
      import('../../../server/routes/folders').then(module => module.default),
      import('../server/folders').then(module => module.default),
    ])
    const app = express()
    app.use(express.json())
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

  async function request(path: string, init: TestHttpRequestInit = {}): Promise<TestHttpResponse> {
    return requestLocalHttp(server, path, init)
  }

  it('renames a work group through the scoped title endpoint and keeps it after rebuild', async () => {
    const updated = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  路由人工组  ' }),
    })
    expect(updated.status).toBe(200)
    const body = await updated.json()
    expect(body.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetGroupId, title: '路由人工组', manual_locked: 1 }),
    ]))

    const rebuilt = await request(`/api/folders/${rootId}/rebuild-media-catalog`, { method: 'POST' })
    expect(rebuilt.status).toBe(200)
    const rebuiltBody = await rebuilt.json()
    expect(rebuiltBody.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: targetGroupId, title: '路由人工组', manual_locked: 1 }),
    ]))

    const invalid = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(invalid.status).toBe(400)

    for (const title of [{ title: '对象' }, ['数组'], 123]) {
      const invalidType = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/title`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      expect(invalidType.status).toBe(400)
      expect(await invalidType.json()).toMatchObject({ code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })
    }
  })

  it('accepts a custom manual label through the catalog endpoint', async () => {
    const customFolder = db.prepare('SELECT id FROM folders WHERE path = ?').get('D:\\Anime\\Collection\\Show A\\Season 1') as any
    const response = await request(`/api/folders/${customFolder.id}/media-catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'custom', customLabel: '  业  ' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.media_catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: customFolder.id, kind: 'custom', custom_label: '业', manual_locked: 1 }),
    ]))
    expect(body.media_catalog_v2.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: customFolder.id, kind: 'custom', custom_label: '业', content_role: 'main' }),
    ]))

    const invalid = await request(`/api/folders/${customFolder.id}/media-catalog`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'custom', customLabel: '   ' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_CUSTOM_LABEL' })
  })

  it('merges, detaches, and splits members through scoped mutation endpoints', async () => {
    const merged = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceGroupId }),
    })
    expect(merged.status).toBe(200)
    const mergedBody = await merged.json()
    expect(mergedBody.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetGroupId,
        manual_locked: 1,
        members: expect.arrayContaining([
          expect.objectContaining({ media_item_id: targetItemId, manual_locked: 1 }),
          expect.objectContaining({ media_item_id: sourceItemId, manual_locked: 1 }),
        ]),
      }),
    ]))
    expect(mergedBody.media_catalog_v2.work_groups.some((group: any) => group.id === sourceGroupId)).toBe(false)

    const splitSetup = await request(`/api/folders/${rootId}`)
    expect(splitSetup.status).toBe(200)
    const current = await splitSetup.json()
    const target = current.media_catalog_v2.work_groups.find((group: any) => group.id === targetGroupId)
    const splitItemId = target.members[0].media_item_id
    for (const title of [{ title: '对象' }, ['数组'], 123]) {
      const invalidType = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaItemIds: [splitItemId], title }),
      })
      expect(invalidType.status).toBe(400)
      expect(await invalidType.json()).toMatchObject({ code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })
    }
    const split = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemIds: [splitItemId], title: '路由拆分组' }),
    })
    expect(split.status).toBe(200)
    const splitBody = await split.json()
    expect(splitBody.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '路由拆分组', manual_locked: 1, item_ids: [splitItemId] }),
    ]))
  })

  it('detaches one item into an explicit ungrouped state and rejects a wrong folder scope', async () => {
    for (const title of [{ title: '对象' }, ['数组'], 123]) {
      const invalidType = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/detach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaItemId: targetItemId, title }),
      })
      expect(invalidType.status).toBe(400)
      expect(await invalidType.json()).toMatchObject({ code: 'INVALID_MEDIA_WORK_GROUP_TITLE' })
    }

    const detached = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/detach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemId: targetItemId }),
    })
    expect(detached.status).toBe(200)
    const detachedBody = await detached.json()
    expect(detachedBody.media_catalog_v2.ungrouped_item_ids).toEqual([targetItemId])
    expect(detachedBody.media_catalog_v2.work_groups.every((group: any) => !group.item_ids.includes(targetItemId))).toBe(true)

    const invalid = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId + 100000}/title`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '越界组' }),
    })
    expect(invalid.status).toBe(404)
  })

  it('attaches an ungrouped item to an existing group through the scoped endpoint', async () => {
    const detached = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/detach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemId: targetItemId }),
    })
    expect(detached.status).toBe(200)

    const attached = await request(`/api/folders/${rootId}/media-work-groups/${targetGroupId}/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemId: targetItemId }),
    })
    expect(attached.status).toBe(200)
    const body = await attached.json()
    expect(body.media_catalog_v2.ungrouped_item_ids).toEqual([])
    expect(body.media_catalog_v2.work_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: targetGroupId,
        item_ids: expect.arrayContaining([targetItemId]),
        members: expect.arrayContaining([
          expect.objectContaining({ media_item_id: targetItemId, manual_locked: 1 }),
        ]),
      }),
    ]))
  })
})
