import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'node-sqlite3-wasm'
import { createApplication } from '../../application'
import { createDb } from '../schema'

let directory: string

function schemaObjects(database: Database) {
  return database.all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY type, name")
}

describe('desktop edition database boundary', () => {
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'animeshelf-desktop-edition-')) })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('rejects a phone capture trigger before schema initialization changes the database', () => {
    const file = path.join(directory, 'phone.db')
    const fixture = new Database(file)
    fixture.exec(`
      CREATE TABLE libraries (id INTEGER PRIMARY KEY);
      CREATE TRIGGER mobile_capture_libraries AFTER INSERT ON libraries BEGIN SELECT 1; END;
    `)
    const before = schemaObjects(fixture)
    fixture.close()

    let failure: unknown
    try { createDb(file) } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'PHONE_EDITION_UNSUPPORTED', message: expect.stringContaining('手机端同步数据') })

    const unchanged = new Database(file, { readOnly: true, fileMustExist: true })
    try {
      expect(schemaObjects(unchanged)).toEqual(before)
      expect(unchanged.get("SELECT name FROM sqlite_master WHERE name IN ('folders', 'settings')")).toBeNull()
    } finally { unchanged.close() }
  })

  it('rejects a phone-enabled application database before application schema writes', async () => {
    const database = new Database(':memory:')
    database.exec('CREATE TABLE mobile_devices (id TEXT PRIMARY KEY)')
    const before = schemaObjects(database)
    try {
      await expect(createApplication({ database, manifests: [], loaders: {}, backgroundTasks: false }))
        .rejects.toMatchObject({ code: 'PHONE_EDITION_UNSUPPORTED' })
      expect(schemaObjects(database)).toEqual(before)
      expect(database.get("SELECT name FROM sqlite_master WHERE name IN ('libraries', 'settings')")).toBeNull()
    } finally { database.close() }
  })

  it('opens an ordinary desktop database', () => {
    const database = createDb(':memory:')
    try {
      expect(database.get("SELECT name FROM sqlite_master WHERE name = 'libraries'")).toEqual({ name: 'libraries' })
      expect(database.get("SELECT name FROM sqlite_master WHERE name GLOB 'mobile_*'")).toBeNull()
    } finally { database.close() }
  })
})
