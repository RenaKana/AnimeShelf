import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'node-sqlite3-wasm'

const everything = vi.hoisted(() => ({ files: vi.fn(), folders: vi.fn() }))
vi.mock('../everything', () => ({ VIDEO_EXTS: ['mkv', 'mp4'], EverythingClient: class { searchFiles = everything.files; searchFolders = everything.folders } }))

describe('persistent disk rename and restore reconciliation', () => {
  let directory: string, databasePath: string, root: string, source: string, episode: string, backup: string
  let db: Database, folderId: number, libraryId: number, oldDataDir: string | undefined

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-recovery-'))
    oldDataDir = process.env.ANIMESHELF_DATA_DIR
    process.env.ANIMESHELF_DATA_DIR = directory
    vi.resetModules()
    const { openAppDb } = await import('../../db/schema')
    databasePath = path.join(directory, 'animeshelf.db')
    db = await openAppDb()
    ;(await import('../../db/instance')).initializeDatabase(db)
    root = path.join(directory, 'library'); source = path.join(root, 'Original')
    fs.mkdirSync(path.join(source, 'Season 1'), { recursive: true })
    episode = path.join(source, 'Season 1', '01.mkv'); fs.writeFileSync(episode, 'media')
    const { makeLibraryDb } = await import('../../db/libraries')
    const { makeFolderDb } = await import('../../db/folders')
    const { makeFileDb } = await import('../../db/files')
    libraryId = makeLibraryDb(db).create('Test', root, 'anime').id
    const folders = makeFolderDb(db)
    folders.upsertTree(libraryId, [root, source, path.dirname(episode)])
    folderId = folders.getByLibrary(libraryId).find(folder => folder.path === source)!.id
    const child = folders.getByLibrary(libraryId).find(folder => folder.path === path.dirname(episode))!
    makeFileDb(db).upsertMany(libraryId, [{ folder_id: child.id, path: episode, name: '01.mkv', size: 5, date_modified: Math.floor(fs.statSync(episode).mtimeMs / 1000), ext: 'mkv' }])
    db.prepare("UPDATE folders SET anilist_id=123, source='bangumi', synopsis='Keep me', media_domain_override='unknown', media_domain_evidence='[]' WHERE id=?").run(folderId)
    db.prepare("INSERT INTO tags (name, color, kind) VALUES ('Keep', '#fff', 'custom')").run()
    db.prepare("INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (1, 'folder', ?)").run(folderId)
    backup = path.join(directory, 'before.db')
    ;(await import('../../db/maintenance')).createDatabaseSnapshot(db, databasePath, backup)
    everything.files.mockResolvedValue([]); everything.folders.mockResolvedValue([root])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await (await import('../../db/schema')).closeAppDb(db)
    if (db.isOpen) db.close()
    if (oldDataDir === undefined) delete process.env.ANIMESHELF_DATA_DIR
    else process.env.ANIMESHELF_DATA_DIR = oldDataDir
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('preserves a display alias through two renames, restart, and two undos', async () => {
    const operations = await import('../folder-operations')
    db.prepare("UPDATE folders SET name='Custom title', renamed=1 WHERE id=?").run(folderId)
    await operations.renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    await operations.renameFolderOnDisk(db, folderId, { name: 'Third', expectedPath: path.join(root, 'Second') })
    const schema = await import('../../db/schema')
    await schema.closeAppDb(db); db = await schema.openAppDb()
    ;(await import('../../db/instance')).initializeDatabase(db)
    for (const current of ['Third', 'Second']) {
      const latest = operations.getFolderRenameHistory(db, folderId).items.find(entry => entry.canUndo)!
      expect(latest).toBeTruthy()
      await operations.undoFolderRename(db, folderId, { operationId: latest.operationId, expectedPath: path.join(root, current) })
    }
    expect(fs.readFileSync(episode, 'utf8')).toBe('media')
    expect(db.prepare('SELECT name, renamed, path, synopsis FROM folders WHERE id=?').get(folderId)).toEqual({ name: 'Custom title', renamed: 1, path: source, synopsis: 'Keep me' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links').get()).toEqual({ count: 1 })
  })

  it('requires later child renames to be undone before their parent', async () => {
    const op = await import('../folder-operations')
    await op.renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    const parentOp = op.getFolderRenameHistory(db, folderId).items[0]
    const child = db.prepare('SELECT id, path FROM folders WHERE parent_id=?').get(folderId) as { id: number; path: string }
    await op.renameFolderOnDisk(db, child.id, { name: 'Season 2', expectedPath: child.path })
    await expect(op.undoFolderRename(db, folderId, { operationId: parentOp.operationId, expectedPath: path.join(root, 'Second') })).rejects.toMatchObject({ code: 'UNDO_UNAVAILABLE' })
    const childOp = op.getFolderRenameHistory(db, child.id).items.find(item => item.canUndo)!
    await op.undoFolderRename(db, child.id, { operationId: childOp.operationId, expectedPath: path.join(root, 'Second', 'Season 2') })
    await op.undoFolderRename(db, folderId, { operationId: parentOp.operationId, expectedPath: path.join(root, 'Second') })
    expect(fs.existsSync(episode)).toBe(true)
  })

  it('recovers a proved disk-complete/database-pending operation on restart', async () => {
    const history = await import('../filesystem-history')
    history.beginRenameHistory(db, folderId, root, source, path.join(root, 'Second'))
    fs.renameSync(source, path.join(root, 'Second'))
    await (await import('../folder-operations')).recoverPendingFolderRenames(db)
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: path.join(root, 'Second') })
    expect(history.readHistory(db)[0].status).toBe('applied')
  })

  it('blocks mutation when an interrupted operation has ambiguous identity or content', async () => {
    const history = await import('../filesystem-history')
    history.beginRenameHistory(db, folderId, root, source, path.join(root, 'Second'))
    fs.renameSync(source, path.join(root, 'Second')); fs.writeFileSync(path.join(root, 'Second', 'unexpected'), 'x')
    const op = await import('../folder-operations')
    await op.recoverPendingFolderRenames(db)
    expect(history.readHistory(db)[0].status).toBe('needs_attention')
    await expect(op.renameFolderOnDisk(db, folderId, { name: 'Third', expectedPath: source })).rejects.toMatchObject({ code: 'FILESYSTEM_RECOVERY_REQUIRED' })
  })

  it.skipIf(process.platform !== 'win32')('recovers both interruption stages of a case-only rename', async () => {
    const history = await import('../filesystem-history')
    const op = await import('../folder-operations')
    const target = path.join(root, 'ORIGINAL')
    const pending = history.beginRenameHistory(db, folderId, root, source, target)
    const staging = path.join(root, `.animeshelf-rename-${pending.operation_id}`)
    fs.renameSync(source, staging)
    await op.recoverPendingFolderRenames(db)
    expect(fs.readdirSync(root)).toContain('Original')
    expect(history.readHistory(db)[0].status).toBe('rolled_back')
    history.beginRenameHistory(db, folderId, root, source, target)
    fs.renameSync(source, staging); fs.renameSync(staging, target)
    await op.recoverPendingFolderRenames(db)
    expect(history.readHistory(db)[0].status).toBe('applied')
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: target })
  })

  it.skipIf(process.platform !== 'win32')('keeps IDs when Everything reports the old casing after rename', async () => {
    const foldersBefore = db.prepare('SELECT id FROM folders ORDER BY id').all()
    const filesBefore = db.prepare('SELECT id FROM files ORDER BY id').all()
    await (await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'ORIGINAL', expectedPath: source })
    everything.folders.mockResolvedValue([root, source, path.dirname(episode)])
    everything.files.mockResolvedValue([{ path: episode, size: 5, dateModified: Math.floor(fs.statSync(episode).mtimeMs / 1000) }])
    const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(libraryId) as any
    expect((await (await import('../scanner')).scanLibrary(lib, db)).removed).toBe(0)
    expect(db.prepare('SELECT id FROM folders ORDER BY id').all()).toEqual(foldersBefore)
    expect(db.prepare('SELECT id FROM files ORDER BY id').all()).toEqual(filesBefore)
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: path.join(root, 'ORIGINAL') })
  })

  it('requires confirmation when a renamed old path is occupied by a matching copy', async () => {
    const destination = path.join(root, 'Second')
    await (await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    fs.cpSync(destination, source, { recursive: true, preserveTimestamps: true })
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    expect(preview.entries.find(entry => entry.folderId === folderId)?.status).toBe('unresolved')
    await expect((await import('../backup')).applyRestorePreview(preview.previewId)).rejects.toMatchObject({ code: 'RESTORE_RESOLUTION_REQUIRED' })
    inspection.resolveRestorePreview(db, preview.previewId, [{ folderId, path: destination }])
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: destination })
  })

  it('requires resolution for an unscanned empty library whose root is missing', async () => {
    const emptyRoot = path.join(directory, 'empty-missing')
    const emptyId = (await import('../../db/libraries')).makeLibraryDb(db).create('Empty', emptyRoot, 'anime').id
    const emptyBackup = path.join(directory, 'empty.db')
    ;(await import('../../db/maintenance')).createDatabaseSnapshot(db, databasePath, emptyBackup)
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, emptyBackup)
    const entry = preview.entries.find(item => item.fromPath === emptyRoot)!
    expect(entry.status).toBe('unresolved')
    inspection.resolveRestorePreview(db, preview.previewId, [{ folderId: entry.folderId, keepMissing: true }])
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    expect(db.prepare('SELECT path_missing FROM folders WHERE library_id=?').get(emptyId)).toEqual({ path_missing: 1 })
    expect(db.all('PRAGMA database_list').map(row => row.name)).toEqual(['main'])
    const recoveredRoot = path.join(directory, 'empty-recovered'); fs.mkdirSync(recoveredRoot)
    db.prepare("UPDATE folders SET media_domain_override='live_action' WHERE id=?").run(entry.folderId)
    await (await import('../folder-operations')).relinkFolder(db, entry.folderId, { expectedPath: emptyRoot, path: recoveredRoot })
    expect(db.prepare('SELECT media_domain_override FROM folders WHERE id=?').get(entry.folderId)).toEqual({ media_domain_override: 'live_action' })
    expect(db.prepare('SELECT root_path FROM libraries WHERE id=?').get(emptyId)).toEqual({ root_path: recoveredRoot })
    expect(db.prepare('SELECT path, path_missing FROM folders WHERE id=?').get(entry.folderId)).toEqual({ path: recoveredRoot, path_missing: 0 })
  })

  it('refuses relinking a missing subtree under a different parent', async () => {
    const otherParent = path.join(root, 'Other'); fs.mkdirSync(otherParent)
    const destination = path.join(otherParent, 'Moved'); fs.renameSync(source, destination)
    db.prepare('UPDATE folders SET path_missing=1 WHERE id=?').run(folderId)
    await expect((await import('../folder-operations')).relinkFolder(db, folderId, { path: destination, expectedPath: source })).rejects.toMatchObject({ code: 'PARENT_PATH_MISMATCH' })
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: source })
  })

  it('accepts an explicitly confirmed replacement library root during preflight', async () => {
    const relocatedRoot = path.join(directory, 'relocated-library')
    fs.renameSync(root, relocatedRoot)
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    const entry = preview.entries.find(item => item.fromPath === root)!
    expect(entry.status).toBe('unresolved')
    const resolved = inspection.resolveRestorePreview(db, preview.previewId, [{ folderId: entry.folderId, path: relocatedRoot }])
    expect(resolved.unresolved).toBe(0)
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    expect(db.prepare('SELECT root_path FROM libraries WHERE id=?').get(libraryId)).toEqual({ root_path: relocatedRoot })
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: path.join(relocatedRoot, 'Original') })
  })

  it('rolls disk and pending history back when the path transaction fails', async () => {
    db.exec("CREATE TRIGGER fail_path BEFORE UPDATE OF path ON folders BEGIN SELECT RAISE(ABORT, 'injected path error'); END")
    await expect((await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })).rejects.toThrow('injected path error')
    expect(fs.existsSync(source)).toBe(true)
    expect((await import('../filesystem-history')).readHistory(db)[0].status).toBe('rolled_back')
  })

  it('restores old metadata while retaining current disk paths and local history', async () => {
    const oldBackup = new (await import('node-sqlite3-wasm')).Database(backup)
    oldBackup.exec('ALTER TABLE folders DROP COLUMN path_missing; DROP TABLE filesystem_operation_history')
    oldBackup.close()
    const op = await import('../folder-operations')
    await op.renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    db.prepare("UPDATE folders SET synopsis='Changed' WHERE id=?").run(folderId)
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    expect(preview.unresolved).toBe(0)
    expect(preview.entries.find(entry => entry.folderId === folderId)?.status).toBe('coordinated')
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    expect(db.prepare('SELECT path, synopsis FROM folders WHERE id=?').get(folderId)).toEqual({ path: path.join(root, 'Second'), synopsis: 'Keep me' })
    expect(db.prepare('SELECT media_domain_override, media_domain_evidence FROM folders WHERE id=?').get(folderId)).toEqual({ media_domain_override: 'unknown', media_domain_evidence: '[]' })
    expect(fs.existsSync(path.join(root, 'Second', 'Season 1', '01.mkv'))).toBe(true)
    expect(op.getFolderRenameHistory(db, folderId).items[0].canUndo).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links').get()).toEqual({ count: 1 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('requires explicit association for historical renames without an operation journal', async () => {
    const destination = path.join(root, 'Legacy name'); fs.renameSync(source, destination)
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(folderId) as any
    ;(await import('../folder-operations')).updateSubtreeLocation(db, folder, destination)
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    expect(preview.unresolved).toBeGreaterThan(0)
    expect(preview.entries.find(entry => entry.folderId === folderId)?.candidates).toContain(destination)
    await expect((await import('../backup')).applyRestorePreview(preview.previewId)).rejects.toMatchObject({ code: 'RESTORE_RESOLUTION_REQUIRED' })
    const resolved = inspection.resolveRestorePreview(db, preview.previewId, [{ folderId, path: destination }])
    expect(resolved.unresolved).toBe(0)
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: destination })
  })

  it('preserves IDs after a rename when Everything still reports old paths or omits the subtree', async () => {
    const before = db.prepare('SELECT id FROM folders ORDER BY id').all()
    await (await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    everything.folders.mockResolvedValue([root, source, path.dirname(episode)])
    everything.files.mockResolvedValue([{ path: episode, size: 5, dateModified: Math.floor(fs.statSync(path.join(root, 'Second', 'Season 1', '01.mkv')).mtimeMs / 1000) }])
    const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(libraryId) as any
    const scan = (await import('../scanner')).scanLibrary
    expect((await scan(lib, db)).removed).toBe(0)
    expect(db.prepare('SELECT id FROM folders ORDER BY id').all()).toEqual(before)
    everything.folders.mockResolvedValue([]); everything.files.mockResolvedValue([])
    expect((await scan(lib, db)).removed).toBe(0)
    expect(db.prepare('SELECT id FROM folders ORDER BY id').all()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links').get()).toEqual({ count: 1 })
  })

  it('protects explicitly retained missing records and tags from scanning', async () => {
    fs.renameSync(source, path.join(root, 'Elsewhere'))
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    inspection.resolveRestorePreview(db, preview.previewId, [{ folderId, keepMissing: true }])
    await (await import('../backup')).applyRestorePreview(preview.previewId)
    const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(libraryId) as any
    const result = await (await import('../scanner')).scanLibrary(lib, db)
    expect(result.removed).toBe(0)
    expect(db.prepare('SELECT path_missing, synopsis FROM folders WHERE id=?').get(folderId)).toEqual({ path_missing: 1, synopsis: 'Keep me' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links').get()).toEqual({ count: 1 })
  })

  it('rejects previews after directory replacement or database path changes', async () => {
    const inspection = await import('../restore-preview')
    const preview = inspection.inspectRestore(db, backup)
    db.prepare("UPDATE folders SET path=path || '-changed' WHERE id=?").run(folderId)
    expect(() => inspection.validatedRestore(db, preview.previewId)).toThrow('已变化')
    db.prepare('UPDATE folders SET path=? WHERE id=?').run([source, folderId])
    const next = inspection.inspectRestore(db, backup)
    fs.renameSync(source, path.join(root, 'Moved')); fs.mkdirSync(source)
    expect(() => inspection.validatedRestore(db, next.previewId)).toThrow('已变化')
  })

  it('keeps the original database if reconciliation fails inside restore transaction', async () => {
    await (await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })
    const preview = (await import('../restore-preview')).inspectRestore(db, backup)
    db.exec("CREATE TRIGGER fail_restore_path BEFORE UPDATE OF path ON folders BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END")
    await expect((await import('../backup')).applyRestorePreview(preview.previewId)).rejects.toThrow('injected restore failure')
    expect(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId)).toEqual({ path: path.join(root, 'Second') })
    expect((await import('../filesystem-history')).readHistory(db)[0].status).toBe('applied')
  })

  it('prevents a concurrent rename while a scan is collecting its snapshot', async () => {
    let release!: (value: unknown[]) => void
    everything.files.mockReturnValue(new Promise(resolve => { release = resolve }))
    const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(libraryId) as any
    const scan = (await import('../scanner')).scanLibrary(lib, db)
    await expect((await import('../folder-operations')).renameFolderOnDisk(db, folderId, { name: 'Second', expectedPath: source })).rejects.toMatchObject({ code: 'LIBRARY_BUSY' })
    release([]); await scan
    expect(fs.existsSync(source)).toBe(true)
  })
})
