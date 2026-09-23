import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('backup restore', () => {
  let tempDir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-backup-'))
    previousDataDir = process.env.ANIMESHELF_DATA_DIR
    process.env.ANIMESHELF_DATA_DIR = tempDir
    vi.resetModules()
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ANIMESHELF_DATA_DIR
    else process.env.ANIMESHELF_DATA_DIR = previousDataDir
    vi.resetModules()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the uploads directory on the first listed-backup restore', async () => {
    const database = await import('../../db/instance')
    const { createDb } = await import('../../db/schema')
    const db = createDb(path.join(tempDir, 'animeshelf.db'))
    database.initializeDatabase(db)
    const sourcePath = path.join(tempDir, 'source.db')
    const source = createDb(sourcePath)
    source.run("INSERT INTO settings(key, value) VALUES ('restore-source-value', 'desktop-backup')")
    source.close()

    expect(fs.existsSync(path.join(tempDir, 'backups', 'uploads'))).toBe(false)
    const { restoreFromPath } = await import('../backup')
    await expect(restoreFromPath(sourcePath)).resolves.toMatchObject({ tables: expect.any(Number) })
    expect(fs.existsSync(path.join(tempDir, 'backups', 'uploads'))).toBe(true)
    expect(database.settingsDb.get('restore-source-value')).toBe('desktop-backup')
    db.close()
  })

  it('rejects a full-edition backup before creating restore artifacts or changing desktop data', async () => {
    const database = await import('../../db/instance')
    const { createDb } = await import('../../db/schema')
    const db = createDb(path.join(tempDir, 'animeshelf.db'))
    database.initializeDatabase(db)
    database.settingsDb.set('keep-on-phone-backup-rejection', 'current')
    const before = db.all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY type, name")
    const sourcePath = path.join(tempDir, 'phone-source.db')
    const source = createDb(sourcePath)
    source.exec(`
      CREATE TABLE mobile_devices (id TEXT PRIMARY KEY);
      CREATE TRIGGER mobile_capture_devices AFTER INSERT ON mobile_devices BEGIN SELECT 1; END;
    `)
    source.close()

    const { restoreFromPath } = await import('../backup')
    await expect(restoreFromPath(sourcePath)).rejects.toMatchObject({
      code: 'PHONE_EDITION_UNSUPPORTED',
      message: expect.stringContaining('手机端同步数据'),
    })
    expect(database.settingsDb.get('keep-on-phone-backup-rejection')).toBe('current')
    expect(db.all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY type, name")).toEqual(before)
    expect(fs.existsSync(path.join(tempDir, 'backups', 'uploads'))).toBe(false)
    expect(fs.existsSync(path.join(tempDir, 'backups', 'auto'))).toBe(false)
    db.close()
  })

  it('creates an integrity-checked snapshot while the main database is open', async () => {
    const { Database } = await import('node-sqlite3-wasm')
    const database = await import('../../db/instance')
    const { createDb } = await import('../../db/schema')
    const db = createDb(path.join(tempDir, 'animeshelf.db'))
    database.initializeDatabase(db)
    const { settingsDb } = database
    const backupDir = path.join(tempDir, 'automatic')
    fs.mkdirSync(backupDir, { recursive: true })
    settingsDb.set('backup_dir_auto', backupDir)
    settingsDb.set('snapshot_test_value', 'kept')

    const { autoBackup } = await import('../backup')
    const snapshotPath = autoBackup()
    expect(snapshotPath).toBeTruthy()

    const snapshot = new Database(snapshotPath!, { fileMustExist: true, readOnly: true })
    expect(snapshot.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
    expect(snapshot.get("SELECT value FROM settings WHERE key = 'snapshot_test_value'")).toEqual({ value: 'kept' })
    snapshot.close()
    db.close()
  })

  it('rolls back the restore if its private reader fails to close before commit', async () => {
    const { Database } = await import('node-sqlite3-wasm')
    const { createDb } = await import('../../db/schema')
    const instance = await import('../../db/instance')
    const db = createDb(path.join(tempDir, 'animeshelf.db'))
    instance.initializeDatabase(db)
    instance.settingsDb.set('close-test', 'current')
    const sourcePath = path.join(tempDir, 'source.db')
    const source = createDb(sourcePath)
    source.run("INSERT INTO settings(key, value) VALUES ('close-test', 'restored')")
    source.close()
    const { restoreFromPath } = await import('../backup')
    const originalClose = Database.prototype.close
    let injected = false
    const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function(this: InstanceType<typeof Database>) {
      const file = String((this.get('PRAGMA database_list') as { file: string }).file)
      if (!injected && path.basename(file).startsWith('restore-')) {
        injected = true
        throw new Error('private reader close failed')
      }
      originalClose.call(this)
    })
    try {
      await expect(restoreFromPath(sourcePath)).rejects.toThrow('private reader close failed')
      expect(injected).toBe(true)
      expect(instance.settingsDb.get('close-test')).toBe('current')
    } finally { close.mockRestore(); db.close() }
  })
})
