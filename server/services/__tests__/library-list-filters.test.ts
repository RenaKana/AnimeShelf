import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { makeTagDb } from '../../db/tags'
import { requestLocalHttp } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
vi.mock('../../db/instance', () => mockedInstance)

function ensureInventoryStateColumns(db: any): void {
  for (const table of ['folders', 'files']) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
    if (!columns.has('path_missing')) db.exec(`ALTER TABLE ${table} ADD COLUMN path_missing INTEGER NOT NULL DEFAULT 0`)
    if (!columns.has('filesystem_identity')) db.exec(`ALTER TABLE ${table} ADD COLUMN filesystem_identity TEXT`)
    if (!columns.has('missing_source')) db.exec(`ALTER TABLE ${table} ADD COLUMN missing_source TEXT`)
  }
}

describe('folder library-list filtering', () => {
  let db: any
  let server: any
  let libraryAId: number
  let libraryBId: number
  let showAId: number
  let showBId: number
  let showCId: number
  let missingSeriesId: number
  let missingWrapperId: number
  let showAFileId: number

  beforeAll(async () => {
    db = createDb(':memory:')
    ensureInventoryStateColumns(db)
    mockedInstance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false })

    const libraries = makeLibraryDb(db)
    const libraryA = libraries.create('Anime A', 'D:\\AnimeA', 'anime')
    const libraryB = libraries.create('Anime B', 'D:\\AnimeB', 'anime')
    libraryAId = libraryA.id
    libraryBId = libraryB.id

    const folders = makeFolderDb(db)
    folders.upsertTree(libraryA.id, [
      'D:\\AnimeA',
      'D:\\AnimeA\\Show A',
      'D:\\AnimeA\\Show A\\Missing wrapper',
      'D:\\AnimeA\\Show B',
      'D:\\AnimeA\\Missing series',
    ])
    folders.upsertTree(libraryB.id, ['D:\\AnimeB', 'D:\\AnimeB\\Show C'])
    const rows = db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>
    showAId = rows.find(row => row.path === 'D:\\AnimeA\\Show A')!.id
    showBId = rows.find(row => row.path === 'D:\\AnimeA\\Show B')!.id
    showCId = rows.find(row => row.path === 'D:\\AnimeB\\Show C')!.id
    missingSeriesId = rows.find(row => row.path === 'D:\\AnimeA\\Missing series')!.id
    missingWrapperId = rows.find(row => row.path === 'D:\\AnimeA\\Show A\\Missing wrapper')!.id
    db.prepare(`
      UPDATE folders
      SET is_series = CASE WHEN id IN (?, ?, ?, ?) THEN 1 ELSE 0 END,
          path_missing = CASE WHEN id IN (?, ?) THEN 1 ELSE 0 END
    `).run([showAId, showBId, showCId, missingSeriesId, missingSeriesId, missingWrapperId])
    db.prepare('UPDATE folders SET filesystem_identity = ?, missing_source = ? WHERE id = ?')
      .run(['private-folder-identity', 'scan', showAId])

    const fileDb = makeFileDb(db)
    const files = [
      { folder_id: showAId, path: 'D:\\AnimeA\\Show A\\01.mkv', name: '01.mkv', size: 10, date_modified: 1, ext: 'mkv' },
      { folder_id: showAId, path: 'D:\\AnimeA\\Show A\\missing.mkv', name: 'missing.mkv', size: 100, date_modified: 1, ext: 'mkv' },
      { folder_id: showBId, path: 'D:\\AnimeA\\Show B\\01.mkv', name: '01.mkv', size: 20, date_modified: 1, ext: 'mkv' },
      { folder_id: showCId, path: 'D:\\AnimeB\\Show C\\01.mkv', name: '01.mkv', size: 30, date_modified: 1, ext: 'mkv' },
    ]
    fileDb.upsertMany(libraryA.id, files.slice(0, 2))
    fileDb.upsertMany(libraryA.id, files.slice(2, 3))
    fileDb.upsertMany(libraryB.id, files.slice(3))
    const showAFiles = db.prepare('SELECT id, name FROM files WHERE folder_id = ? ORDER BY id').all(showAId) as Array<{ id: number; name: string }>
    showAFileId = showAFiles.find(file => file.name === '01.mkv')!.id
    const missingFileId = showAFiles.find(file => file.name === 'missing.mkv')!.id
    db.prepare('UPDATE files SET path_missing = 1 WHERE id = ?').run(missingFileId)
    db.prepare('UPDATE files SET filesystem_identity = ?, missing_source = ? WHERE id = ?')
      .run(['private-file-identity', 'scan', showAFileId])

    const tags = makeTagDb(db)
    const libraryTag = tags.create('Library A')
    const favoriteTag = tags.create('Favorite')
    const watching = tags.create('状态:在看')
    const complete = tags.create('状态:看完')
    const following = tags.create('追番中')
    const libraryARoot = rows.find(row => row.path === 'D:\\AnimeA')!.id
    tags.link(libraryTag.id, 'folder', libraryARoot)
    tags.link(favoriteTag.id, 'folder', showAId)
    tags.link(watching.id, 'folder', showAId)
    tags.link(complete.id, 'folder', showBId)
    tags.link(following.id, 'folder', showCId)

    const [folderRouter, fileRouter] = await Promise.all([
      import('../../routes/folders').then(module => module.default),
      import('../../routes/files').then(module => module.default),
    ])
    const app = express()
    app.set('query parser', 'extended')
    app.use('/api/folders', folderRouter)
    app.use('/api/files', fileRouter)
    server = await new Promise<any>(resolve => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running))
    })
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  async function list(query: string): Promise<any[]> {
    const response = await requestLocalHttp(server, `/api/folders?${query}`)
    expect(response.status).toBe(200)
    return response.json()
  }

  it('ORs repeated libraries and statuses while ANDing filter dimensions', async () => {
    const libraries = await list(`type=series&libraryId=${libraryAId}&libraryId=${libraryBId}`)
    expect(libraries).toHaveLength(4)
    expect(libraries.map(folder => folder.id)).toEqual(expect.arrayContaining([showAId, showBId, missingSeriesId, showCId]))

    const statuses = await list(`type=series&status=${encodeURIComponent('状态:在看')}&status=${encodeURIComponent('状态:看完')}`)
    expect(statuses).toHaveLength(2)
    expect(statuses.map(folder => folder.id)).toEqual(expect.arrayContaining([showAId, showBId]))

    const dimensions = await list(`type=series&tag=Favorite&status=${encodeURIComponent('状态:在看')}&status=${encodeURIComponent('状态:看完')}`)
    expect(dimensions.map(folder => folder.id)).toEqual([showAId])
  })

  it('matches repeated effective ancestor tags with any by default and all on request', async () => {
    const any = await list('type=series&tag=Library%20A&tag=Favorite')
    expect(any).toHaveLength(3)
    expect(any.map(folder => folder.id)).toEqual(expect.arrayContaining([showAId, showBId, missingSeriesId]))

    const all = await list('type=series&tag=Library%20A&tag=Favorite&tagMatch=all')
    expect(all.map(folder => folder.id)).toEqual([showAId])

    const scalar = await list(`type=series&libraryId=${libraryAId}&tag=Favorite`)
    expect(scalar.map(folder => folder.id)).toEqual([showAId])
  })

  it('rejects invalid IDs, nested values, and invalid tag matching modes', async () => {
    for (const query of ['libraryId=', 'libraryId=0', 'libraryId=1.5', 'libraryId=1&libraryId=bad', 'tag[name]=Favorite', 'tagMatch=some']) {
      const response = await requestLocalHttp(server, `/api/folders?${query}`)
      expect(response.status, query).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_FOLDER_QUERY' })
    }
  })

  it('keeps missing series visible with zero available totals and hides missing wrappers from browse children', async () => {
    const rows = await list(`type=series&libraryId=${libraryAId}`)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: showAId, file_count: 1, size: 10, path_missing: 0 }),
      expect.objectContaining({ id: missingSeriesId, file_count: 0, size: 0, path_missing: 1 }),
    ]))
    expect(rows.some(folder => folder.id === missingWrapperId)).toBe(false)

    const detail = await requestLocalHttp(server, `/api/folders/${showAId}`)
    expect(detail.status).toBe(200)
    const body = await detail.json()
    expect(body.children.some((folder: any) => folder.id === missingWrapperId)).toBe(false)
    const recovery = await requestLocalHttp(server, `/api/folders/${missingWrapperId}`)
    expect(recovery.status).toBe(200)
    expect(await recovery.json()).toMatchObject({ id: missingWrapperId, path_missing: 1 })
  })

  it('returns file missing markers without exposing persistence-only identity fields', async () => {
    const listBody = await list(`type=series&libraryId=${libraryAId}`)
    expect(JSON.stringify(listBody)).not.toMatch(/filesystem_identity|missing_source/)
    expect(listBody.every(folder => folder.owned_season_numbers === null)).toBe(true)

    const folderResponse = await requestLocalHttp(server, `/api/folders/${showAId}`)
    const folderBody = await folderResponse.json()
    expect(folderBody.files).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'missing.mkv', path_missing: 1 })]))
    expect(JSON.stringify(folderBody)).not.toMatch(/filesystem_identity|missing_source/)

    const fileResponse = await requestLocalHttp(server, `/api/files/${showAFileId}`)
    expect(fileResponse.status).toBe(200)
    expect(JSON.stringify(await fileResponse.json())).not.toMatch(/filesystem_identity|missing_source/)
  })
})
