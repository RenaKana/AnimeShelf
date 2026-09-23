import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDb } from '../../../server/db/schema'

describe('collection presentation persistence', () => {
  let db: ReturnType<typeof createDb> | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('creates a root-scoped presentation table without semantic catalog foreign keys', () => {
    db = createDb(':memory:')

    const columns = db.prepare('PRAGMA table_info(media_collection_presentation)').all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.map(column => column.name)).toEqual([
      'root_folder_id', 'entry_key', 'display_title', 'position',
    ])
    expect(columns.find(column => column.name === 'root_folder_id')?.notnull).toBe(1)
    expect(columns.find(column => column.name === 'entry_key')?.notnull).toBe(1)

    const foreignKeys = db.prepare('PRAGMA foreign_key_list(media_collection_presentation)').all()
    expect(foreignKeys).toEqual([
      expect.objectContaining({
        table: 'folders',
        from: 'root_folder_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ])
  })

  it('persists across database reopen, enforces key/order constraints, and cascades only with its root', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-collection-presentation-'))
    const databasePath = path.join(directory, 'presentation.db')
    try {
      db = createDb(databasePath)
      db.exec(`
        INSERT INTO libraries (name, root_path, type) VALUES ('Anime', 'D:\\Anime', 'anime');
        INSERT INTO folders (library_id, name, path, pinned) VALUES (1, 'Collection', 'D:\\Anime\\Collection', 1);
        INSERT INTO media_collection_presentation (root_folder_id, entry_key, display_title, position)
          VALUES (1, 'item:anilist:100', 'Personal title', 3);
      `)
      expect(() => db!.prepare(`
        INSERT INTO media_collection_presentation (root_folder_id, entry_key, position)
        VALUES (1, 'item:anilist:100', 4)
      `).run()).toThrow()
      expect(() => db!.prepare(`
        INSERT INTO media_collection_presentation (root_folder_id, entry_key, position)
        VALUES (1, 'item:anilist:101', -1)
      `).run()).toThrow()
      db.close()
      db = undefined

      db = createDb(databasePath)
      expect(db.prepare(`
        SELECT root_folder_id, entry_key, display_title, position
        FROM media_collection_presentation
      `).all()).toEqual([{
        root_folder_id: 1,
        entry_key: 'item:anilist:100',
        display_title: 'Personal title',
        position: 3,
      }])

      db.prepare('DELETE FROM folders WHERE id = 1').run()
      expect(db.prepare('SELECT COUNT(*) AS count FROM media_collection_presentation').get()).toEqual({ count: 0 })
    } finally {
      db?.close()
      db = undefined
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
