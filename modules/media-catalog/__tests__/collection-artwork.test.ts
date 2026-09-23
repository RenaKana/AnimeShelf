import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { makeFileDb } from '../../../server/db/files'
import { rebuildLibraryMediaCatalog } from '../server/media-catalog'
import { getCollectionArtwork } from '../server/collection-artwork'

describe('collection artwork', () => {
  let db: ReturnType<typeof createDb>
  let posterDir: string
  let rootId: number
  let workId: number
  let nestedWorkId: number
  beforeEach(() => {
    db = createDb(':memory:')
    posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-collection-art-'))
    const library = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime')
    const paths = ['D:\\Anime', 'D:\\Anime\\Collection', 'D:\\Anime\\Collection\\Second Season',
      'D:\\Anime\\Collection\\Second Season\\Hanamonogatari',
      'D:\\Anime\\Collection\\Nested Collection', 'D:\\Anime\\Collection\\Nested Collection\\Other Work']
    const created = makeFolderDb(db).upsertTree(library.id, paths)
    const rows = paths.map(folderPath => created.find(folder => folder.path === folderPath)!)
    rootId = rows[1].id
    workId = rows[3].id
    nestedWorkId = rows[5].id
    db.prepare('UPDATE folders SET pinned = 1 WHERE id IN (?, ?)').run([rootId, rows[4].id])
    for (const [id, sourceId] of [[workId, 20593], [nestedWorkId, 999]]) {
      db.prepare("UPDATE folders SET source = 'anilist', anilist_id = ?, has_poster = 1 WHERE id = ?").run([sourceId, id])
      fs.writeFileSync(path.join(posterDir, `al_${sourceId}.jpg`), `poster-${sourceId}`)
    }
    makeFileDb(db).upsertMany(library.id, [rows[3], rows[5]].map(folder => ({ folder_id: folder.id, path: `${folder.path}\\01.mkv`, name: '01.mkv', ext: 'mkv', size: 1, date_modified: 1 })))
    rebuildLibraryMediaCatalog(db, library.id)
  })
  afterEach(() => { db.close(); fs.rmSync(posterDir, { recursive: true, force: true }) })

  it('provides deep work posters without exposing a nested collection or mutating the catalog', () => {
    const before = db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()
    const artwork = getCollectionArtwork(db, rootId, posterDir)
    expect(artwork).toContainEqual({ id: workId, poster_version: expect.stringMatching(/^al-20593-/) })
    expect(artwork.some(row => row.id === nestedWorkId)).toBe(false)
    expect(db.prepare('SELECT * FROM folder_media_mappings ORDER BY id').all()).toEqual(before)
    expect(getCollectionArtwork(db, workId, posterDir)).toEqual([])
  })

  it('reuses stable versions and reports missing cache assets without guessing another work poster', () => {
    const first = getCollectionArtwork(db, rootId, posterDir)
    expect(getCollectionArtwork(db, rootId, posterDir)).toEqual(first)
    fs.unlinkSync(path.join(posterDir, 'al_20593.jpg'))
    expect(getCollectionArtwork(db, rootId, posterDir)).toContainEqual({ id: workId, poster_version: null })
  })
})
