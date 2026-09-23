import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'node-sqlite3-wasm'
import { createDb } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { makeFolderDb } from '../../db/folders'
import { makeFileDb } from '../../db/files'
import { scanLibrary } from '../scanner'
import type { Library } from '../../types'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'
import { FolderMoveService } from '../folder-moves'
import { randomUUID } from 'node:crypto'

const everything = vi.hoisted(() => ({
  files: [] as Array<{ path: string; size: number; dateModified: number }>,
  folders: [] as string[],
}))

vi.mock('../everything', () => ({
  VIDEO_EXTS: ['mkv', 'mp4'],
  EverythingClient: class {
    async searchFiles() { return everything.files }
    async searchFolders() { return everything.folders }
  },
}))

function indexDisk(root: string): void {
  const folders: string[] = []
  const files: Array<{ path: string; size: number; dateModified: number }> = []
  const visit = (directory: string) => {
    folders.push(directory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && /\.(?:mkv|mp4)$/i.test(entry.name)) {
        const stat = fs.statSync(target)
        files.push({ path: target, size: stat.size, dateModified: Math.floor(stat.mtimeMs / 1000) })
      }
    }
  }
  visit(root)
  everything.folders = folders
  everything.files = files
}

function writeVideo(target: string, content = 'video'): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

describe.runIf(process.platform === 'win32')('scanner reconciliation', () => {
  let temp: string
  let root: string
  let db: Database
  let lib: Library

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-scan-'))
    root = path.join(temp, 'library')
    fs.mkdirSync(root)
    db = createDb(':memory:')
    lib = makeLibraryDb(db).create('Test', root, 'anime')
    everything.files = []
    everything.folders = [root]
  })

  afterEach(() => {
    if (db.isOpen) db.close()
    fs.rmSync(temp, { recursive: true, force: true })
  })

  it('makes no database changes for an offline root or stale indexed path', async () => {
    const unavailable = path.join(temp, 'offline')
    const unavailableLib = makeLibraryDb(db).create('Offline', unavailable, 'anime')
    const before = db.prepare('SELECT * FROM folders ORDER BY id').all()
    await expect(scanLibrary(unavailableLib, db)).resolves.toMatchObject({
      code: 'LIBRARY_ROOT_UNAVAILABLE', retryable: true, changed: false,
    })
    expect(db.prepare('SELECT * FROM folders ORDER BY id').all()).toEqual(before)

    everything.files = [{ path: path.join(root, 'gone.mkv'), size: 5, dateModified: 1 }]
    everything.folders = [root]
    await expect(scanLibrary(lib, db)).resolves.toMatchObject({
      code: 'EVERYTHING_STALE_INDEX', retryable: true, changed: false,
    })
    expect(db.prepare('SELECT * FROM folders ORDER BY id').all()).toEqual(before)
  })

  it('keeps folder and file timestamps stable on a repeated no-op scan', async () => {
    writeVideo(path.join(root, 'Show', '01.mkv'))
    indexDisk(root)
    expect((await scanLibrary(lib, db)).changed).toBe(true)
    db.exec("UPDATE folders SET updated_at='2000-01-01 00:00:00'; UPDATE files SET updated_at='2000-01-01 00:00:00'")

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ added: 0, updated: 0, moved: 0, missing: 0, restored: 0, changed: false })
    expect(db.prepare('SELECT DISTINCT updated_at FROM folders').all()).toEqual([{ updated_at: '2000-01-01 00:00:00' }])
    expect(db.prepare('SELECT DISTINCT updated_at FROM files').all()).toEqual([{ updated_at: '2000-01-01 00:00:00' }])
  })
  it('retains moved IDs while Everything still returns old source paths and omits the new destination', async () => {
    const source = path.join(root, 'Move me')
    writeVideo(path.join(source, 'Season 1', '01.mkv'))
    indexDisk(root); await scanLibrary(lib, db)
    const before = db.all('SELECT id,path FROM folders WHERE path != ?', root) as unknown as { id: number; path: string }[]
    const fileIds = db.all('SELECT id FROM files')
    const folder = before.find(row => row.path === source)!
    const targetRoot = path.join(temp, 'destination'); fs.mkdirSync(targetRoot)
    const target = makeLibraryDb(db).create('Destination', targetRoot, 'anime')
    const moves = new FolderMoveService(db)
    try {
      const job = await moves.create({ items: [{ id: folder.id, expectedPath: source }], targetLibraryId: target.id, targetRelativePath: '' }, randomUUID())
      await moves.wait(); expect(moves.get(job.id).items[0].phase).toBe('completed')
      const sourceScan = await scanLibrary(lib, db)
      expect(sourceScan.missing).toBe(0); expect(sourceScan.code).toBeUndefined()
      everything.files = []; everything.folders = [targetRoot]
      const targetScan = await scanLibrary(target, db)
      expect(targetScan.missing).toBe(0); expect(targetScan.code).toBeUndefined()
      for (const row of before) expect(db.get('SELECT id,library_id,path_missing FROM folders WHERE id=?', row.id)).toEqual({ id: row.id, library_id: target.id, path_missing: 0 })
      expect(db.all('SELECT id FROM files')).toEqual(fileIds)
      expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    } finally { await moves.stop() }
  })

  it('preserves IDs, tags, metadata, and manual catalog rows across an external parent rename', async () => {
    const oldShow = path.join(root, 'Show')
    const episode = path.join(oldShow, 'Season 1', '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    await scanLibrary(lib, db)
    const show = db.prepare('SELECT * FROM folders WHERE path=?').get(oldShow) as any
    const season = db.prepare('SELECT * FROM folders WHERE path=?').get(path.dirname(episode)) as any
    const file = db.prepare('SELECT * FROM files WHERE path=?').get(episode) as any
    db.prepare("UPDATE folders SET anilist_id=42, source='bangumi', synopsis='keep', media_domain_override='unknown', media_domain_evidence='[]' WHERE id=?").run(show.id)
    db.prepare("INSERT INTO tags(name,color,kind) VALUES('keep','#fff','custom')").run()
    const tagId = (db.prepare("SELECT id FROM tags WHERE name='keep'").get() as any).id
    db.prepare("INSERT INTO tag_links(tag_id,target_type,target_id) VALUES(?,'folder',?)").run([tagId, show.id])
    const seriesId = db.prepare("INSERT INTO media_series(library_id,root_folder_id,series_key,title,manual_locked) VALUES(?,?,?,?,1)")
      .run([lib.id, show.id, `folder:${show.id}`, 'Manual']).lastInsertRowid
    db.prepare("INSERT INTO folder_media_entries(folder_id,series_id,kind,season_number,source,confidence,detected_by,manual_locked) VALUES(?,?,'season',1,NULL,1,'manual',1)")
      .run([season.id, seriesId])

    const renamed = path.join(root, 'Renamed')
    fs.renameSync(oldShow, renamed)
    indexDisk(root)
    const result = await scanLibrary(lib, db)

    expect(result.moved).toBe(3)
    expect(db.prepare('SELECT media_domain_override,media_domain_evidence FROM folders WHERE id=?').get(show.id)).toEqual({ media_domain_override: 'unknown', media_domain_evidence: '[]' })
    expect(db.prepare('SELECT id,path,anilist_id,source,synopsis,path_missing FROM folders WHERE id=?').get(show.id)).toEqual({
      id: show.id, path: renamed, anilist_id: 42, source: 'bangumi', synopsis: 'keep', path_missing: 0,
    })
    expect(db.prepare('SELECT id,path,parent_id FROM folders WHERE id=?').get(season.id)).toEqual({
      id: season.id, path: path.join(renamed, 'Season 1'), parent_id: show.id,
    })
    expect(db.prepare('SELECT id,path FROM files WHERE id=?').get(file.id)).toEqual({ id: file.id, path: path.join(renamed, 'Season 1', '01.mkv') })
    expect(db.prepare("SELECT COUNT(*) AS count FROM tag_links WHERE target_type='folder' AND target_id=?").get(show.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT season_number,manual_locked FROM folder_media_entries WHERE folder_id=?').get(season.id)).toEqual({ season_number: 1, manual_locked: 1 })
  })

  it('raises two seasons out of an obsolete wrapper without changing their 47 file IDs', async () => {
    const show = path.join(root, 'Dandadan')
    const wrapper = path.join(show, 'Wrapper')
    const s1 = path.join(wrapper, 'S1')
    const s2 = path.join(wrapper, 'S2')
    for (let index = 1; index <= 47; index++) writeVideo(path.join(index <= 23 ? s1 : s2, `${String(index).padStart(2, '0')}.mkv`), String(index))
    indexDisk(root)
    await scanLibrary(lib, db)
    const beforeFolders = new Map((db.prepare('SELECT path,id FROM folders').all() as any[]).map(row => [row.path, row.id]))
    const beforeFiles = new Map((db.prepare('SELECT name,id FROM files').all() as any[]).map(row => [row.name, row.id]))
    const showId = beforeFolders.get(show)!
    const s1Id = beforeFolders.get(s1)!
    const s2Id = beforeFolders.get(s2)!
    const seriesId = db.prepare("INSERT INTO media_series(library_id,root_folder_id,series_key,title,manual_locked) VALUES(?,?,?,?,1)")
      .run([lib.id, showId, `manual:${showId}`, 'Dandadan']).lastInsertRowid
    db.prepare("INSERT INTO folder_media_entries(folder_id,series_id,kind,season_number,source,confidence,detected_by,manual_locked) VALUES(?,?,'season',1,NULL,1,'manual',1)")
      .run([s1Id, seriesId])

    fs.renameSync(s1, path.join(show, 'S1'))
    fs.renameSync(s2, path.join(show, 'S2'))
    fs.rmdirSync(wrapper)
    indexDisk(root)
    const result = await scanLibrary(lib, db)

    expect(result.moved).toBe(49)
    expect(db.prepare('SELECT id,parent_id,path_missing FROM folders WHERE id=?').get(s1Id)).toEqual({ id: s1Id, parent_id: showId, path_missing: 0 })
    expect(db.prepare('SELECT id,parent_id,path_missing FROM folders WHERE id=?').get(s2Id)).toEqual({ id: s2Id, parent_id: showId, path_missing: 0 })
    expect(db.prepare('SELECT path_missing FROM folders WHERE id=?').get(beforeFolders.get(wrapper)!)).toEqual({ path_missing: 1 })
    expect(new Map((db.prepare('SELECT name,id FROM files').all() as any[]).map(row => [row.name, row.id]))).toEqual(beforeFiles)
    expect(db.prepare('SELECT season_number,manual_locked FROM folder_media_entries WHERE folder_id=?').get(s1Id)).toEqual({ season_number: 1, manual_locked: 1 })
  })

  it('keeps ambiguous identity-less duplicates as missing instead of merging them', async () => {
    const fixed = new Date('2020-01-01T00:00:00Z')
    for (const name of ['A', 'B']) {
      const file = path.join(root, name, 'Season', '01.mkv')
      writeVideo(file, 'same')
      fs.utimesSync(file, fixed, fixed)
    }
    indexDisk(root)
    await scanLibrary(lib, db)
    const oldIds = (db.prepare("SELECT id FROM folders WHERE name IN ('A','B') ORDER BY id").all() as any[]).map(row => row.id)
    db.exec('UPDATE folders SET filesystem_identity=NULL; UPDATE files SET filesystem_identity=NULL')
    fs.renameSync(path.join(root, 'A'), path.join(root, 'C'))
    fs.renameSync(path.join(root, 'B'), path.join(root, 'D'))
    indexDisk(root)

    const result = await scanLibrary(lib, db)

    expect(db.prepare(`SELECT id,path_missing FROM folders WHERE id IN (${oldIds.join(',')}) ORDER BY id`).all()).toEqual(oldIds.map(id => ({ id, path_missing: 1 })))
    expect(db.prepare("SELECT COUNT(*) AS count FROM folders WHERE name IN ('C','D') AND path_missing=0").get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 4 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM files WHERE path_missing=1').get()).toEqual({ count: 2 })
    expect(result).toMatchObject({ ambiguous: expect.any(Number), warnings: [expect.stringContaining('手动重新关联')] })
    expect(result.ambiguous).toBeGreaterThan(0)
  })

  it('does not report child ambiguity after a unique moved parent rebases identical season manifests', async () => {
    const oldShow = path.join(root, 'Old Show')
    const fixed = new Date('2022-01-01T00:00:00Z')
    for (const season of ['S1', 'S2']) {
      const file = path.join(oldShow, season, '01.mkv')
      writeVideo(file, 'same')
      fs.utimesSync(file, fixed, fixed)
    }
    indexDisk(root)
    await scanLibrary(lib, db)
    const ids = new Map((db.prepare('SELECT path,id FROM folders WHERE path LIKE ? ORDER BY path').all(`${oldShow}%`) as any[])
      .map(row => [row.path, row.id]))
    db.exec('UPDATE folders SET filesystem_identity=NULL; UPDATE files SET filesystem_identity=NULL')
    const movedShow = path.join(root, 'Moved Show')
    fs.renameSync(oldShow, movedShow)
    indexDisk(root)

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ moved: 5, missing: 0, ambiguous: 0, warnings: [] })
    expect(db.prepare('SELECT id,path FROM folders WHERE id=?').get(ids.get(oldShow)!)).toEqual({ id: ids.get(oldShow), path: movedShow })
    expect(db.prepare('SELECT id,path FROM folders WHERE id=?').get(ids.get(path.join(oldShow, 'S1'))!)).toEqual({ id: ids.get(path.join(oldShow, 'S1')), path: path.join(movedShow, 'S1') })
    expect(db.prepare('SELECT id,path FROM folders WHERE id=?').get(ids.get(path.join(oldShow, 'S2'))!)).toEqual({ id: ids.get(path.join(oldShow, 'S2')), path: path.join(movedShow, 'S2') })
  })

  it('retains missing metadata and series classification, then restores the same IDs on reappearance', async () => {
    const show = path.join(root, 'Show')
    const episode = path.join(show, '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    await scanLibrary(lib, db)
    const folder = db.prepare('SELECT * FROM folders WHERE path=?').get(show) as any
    const file = db.prepare('SELECT * FROM files WHERE path=?').get(episode) as any
    db.prepare("UPDATE folders SET synopsis='keep' WHERE id=?").run(folder.id)
    db.prepare("INSERT INTO tags(name,color,kind) VALUES('missing','#fff','custom')").run()
    const tagId = (db.prepare("SELECT id FROM tags WHERE name='missing'").get() as any).id
    db.prepare("INSERT INTO tag_links(tag_id,target_type,target_id) VALUES(?,'folder',?)").run([tagId, folder.id])
    const outside = path.join(temp, 'outside')
    fs.renameSync(show, outside)
    indexDisk(root)

    const missing = await scanLibrary(lib, db)
    expect(missing.missing).toBe(2)
    expect(db.prepare('SELECT id,is_series,path_missing,synopsis FROM folders WHERE id=?').get(folder.id)).toEqual({
      id: folder.id, is_series: 1, path_missing: 1, synopsis: 'keep',
    })
    expect(db.prepare('SELECT id,path_missing FROM files WHERE id=?').get(file.id)).toEqual({ id: file.id, path_missing: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links WHERE target_id=?').get(folder.id)).toEqual({ count: 1 })

    fs.renameSync(outside, show)
    indexDisk(root)
    const restored = await scanLibrary(lib, db)
    expect(restored.restored).toBe(2)
    expect(db.prepare('SELECT id,path_missing FROM folders WHERE id=?').get(folder.id)).toEqual({ id: folder.id, path_missing: 0 })
    expect(db.prepare('SELECT id,path_missing FROM files WHERE id=?').get(file.id)).toEqual({ id: file.id, path_missing: 0 })
  })

  it('preserves IDs when a folder moves between registered libraries', async () => {
    const targetRoot = path.join(temp, 'target')
    fs.mkdirSync(targetRoot)
    const targetLib = makeLibraryDb(db).create('Target', targetRoot, 'anime')
    const source = path.join(root, 'Show')
    const episode = path.join(source, '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    await scanLibrary(lib, db)
    const folderId = (db.prepare('SELECT id FROM folders WHERE path=?').get(source) as any).id
    const fileId = (db.prepare('SELECT id FROM files WHERE path=?').get(episode) as any).id
    db.prepare("UPDATE folders SET media_domain_override='live_action' WHERE id=?").run(folderId)

    const target = path.join(targetRoot, 'Show')
    fs.renameSync(source, target)
    indexDisk(targetRoot)
    await scanLibrary(targetLib, db)

    expect(db.prepare('SELECT media_domain_override FROM folders WHERE id=?').get(folderId)).toEqual({ media_domain_override: 'live_action' })
    expect(db.prepare('SELECT id,library_id,path FROM folders WHERE id=?').get(folderId)).toEqual({ id: folderId, library_id: targetLib.id, path: target })
    expect(db.prepare('SELECT id,library_id,path FROM files WHERE id=?').get(fileId)).toEqual({ id: fileId, library_id: targetLib.id, path: path.join(target, '01.mkv') })
  })

  it('keeps identities and tags attached when two external directories swap paths', async () => {
    const left = path.join(root, 'Left')
    const right = path.join(root, 'Right')
    writeVideo(path.join(left, 'left.mkv'), 'left')
    writeVideo(path.join(right, 'right.mkv'), 'right')
    indexDisk(root)
    await scanLibrary(lib, db)
    const leftFolder = db.prepare('SELECT id FROM folders WHERE path=?').get(left) as any
    const rightFolder = db.prepare('SELECT id FROM folders WHERE path=?').get(right) as any
    const leftFile = db.prepare("SELECT id FROM files WHERE name='left.mkv'").get() as any
    const rightFile = db.prepare("SELECT id FROM files WHERE name='right.mkv'").get() as any
    db.prepare("INSERT INTO tags(name,color,kind) VALUES('left identity','#fff','custom')").run()
    const tagId = (db.prepare("SELECT id FROM tags WHERE name='left identity'").get() as any).id
    db.prepare("INSERT INTO tag_links(tag_id,target_type,target_id) VALUES(?,'folder',?)").run([tagId, leftFolder.id])
    const holding = path.join(root, 'Holding')
    fs.renameSync(left, holding)
    fs.renameSync(right, left)
    fs.renameSync(holding, right)
    indexDisk(root)

    const result = await scanLibrary(lib, db)

    expect(result.moved).toBe(4)
    expect(db.prepare('SELECT id,path FROM folders WHERE id=?').get(leftFolder.id)).toEqual({ id: leftFolder.id, path: right })
    expect(db.prepare('SELECT id,path FROM folders WHERE id=?').get(rightFolder.id)).toEqual({ id: rightFolder.id, path: left })
    expect(db.prepare('SELECT id,path FROM files WHERE id=?').get(leftFile.id)).toEqual({ id: leftFile.id, path: path.join(right, 'left.mkv') })
    expect(db.prepare('SELECT id,path FROM files WHERE id=?').get(rightFile.id)).toEqual({ id: rightFile.id, path: path.join(left, 'right.mkv') })
    expect(db.prepare("SELECT target_id FROM tag_links WHERE target_type='folder' AND tag_id=?").get(tagId)).toEqual({ target_id: leftFolder.id })
  })

  it('does not steal an existing same-content legacy folder from another library', async () => {
    const otherRoot = path.join(temp, 'other-library')
    const otherShow = path.join(otherRoot, 'Same')
    const fixed = new Date('2021-01-01T00:00:00Z')
    const otherFile = path.join(otherShow, '01.mkv')
    writeVideo(otherFile, 'same')
    fs.utimesSync(otherFile, fixed, fixed)
    const otherLib = makeLibraryDb(db).create('Other', otherRoot, 'anime')
    indexDisk(otherRoot)
    await scanLibrary(otherLib, db)
    const otherId = (db.prepare('SELECT id FROM folders WHERE path=?').get(otherShow) as any).id
    db.prepare('UPDATE folders SET filesystem_identity=NULL WHERE id=?').run(otherId)
    db.prepare('UPDATE files SET filesystem_identity=NULL WHERE library_id=?').run(otherLib.id)

    const incoming = path.join(root, 'Incoming')
    const incomingFile = path.join(incoming, '01.mkv')
    writeVideo(incomingFile, 'same')
    fs.utimesSync(incomingFile, fixed, fixed)
    indexDisk(root)
    await scanLibrary(lib, db)

    expect(db.prepare('SELECT id,library_id,path,path_missing FROM folders WHERE id=?').get(otherId)).toEqual({
      id: otherId, library_id: otherLib.id, path: otherShow, path_missing: 0,
    })
    const current = db.prepare('SELECT id,library_id FROM folders WHERE path=?').get(incoming) as any
    expect(current.library_id).toBe(lib.id)
    expect(current.id).not.toBe(otherId)
  })

  it('rejects an Everything snapshot that omits existing disk entries despite a complete reported total', async () => {
    const show = path.join(root, 'Omitted')
    writeVideo(path.join(show, '01.mkv'))
    indexDisk(root)
    await scanLibrary(lib, db)
    const beforeFolders = db.prepare('SELECT * FROM folders ORDER BY id').all()
    const beforeFiles = db.prepare('SELECT * FROM files ORDER BY id').all()
    everything.folders = [root]
    everything.files = []

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ code: 'EVERYTHING_STALE_INDEX', retryable: true, changed: false })
    expect(db.prepare('SELECT * FROM folders ORDER BY id').all()).toEqual(beforeFolders)
    expect(db.prepare('SELECT * FROM files ORDER BY id').all()).toEqual(beforeFiles)
  })

  it('rolls back reconciliation on catalog failure and when the scan becomes stale before commit', async () => {
    const show = path.join(root, 'Show')
    writeVideo(path.join(show, '01.mkv'))
    indexDisk(root)
    await scanLibrary(lib, db)
    const before = db.prepare('SELECT id,path,path_missing,filesystem_identity FROM folders ORDER BY id').all()
    fs.renameSync(show, path.join(root, 'Renamed'))
    indexDisk(root)
    bindTestModuleCapabilities(db, { catalog: { rebuildLibrary: () => { throw new Error('injected catalog failure') } } })

    await expect(scanLibrary(lib, db)).rejects.toThrow('injected catalog failure')
    expect(db.prepare('SELECT id,path,path_missing,filesystem_identity FROM folders ORDER BY id').all()).toEqual(before)

    bindTestModuleCapabilities(db, { catalog: false })
    let checks = 0
    const cancelled = await scanLibrary(lib, db, { isCurrent: () => ++checks < 5 })
    expect(cancelled).toMatchObject({ code: 'SCAN_CANCELLED', changed: false })
    expect(db.prepare('SELECT id,path,path_missing,filesystem_identity FROM folders ORDER BY id').all()).toEqual(before)
  })

  it('does not write when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const before = db.prepare('SELECT * FROM folders').all()
    expect(await scanLibrary(lib, db, { signal: controller.signal })).toMatchObject({ code: 'SCAN_CANCELLED', changed: false })
    expect(db.prepare('SELECT * FROM folders').all()).toEqual(before)
  })

  it('lets shutdown cancel filesystem collection before a transaction starts', async () => {
    writeVideo(path.join(root, 'Show', '01.mkv'))
    indexDisk(root)
    const controller = new AbortController()
    const abort = setImmediate(() => controller.abort())
    try {
      const result = await scanLibrary(lib, db, { signal: controller.signal })
      expect(result).toMatchObject({ code: 'SCAN_CANCELLED', changed: false })
      expect(db.all('SELECT id FROM folders')).toEqual([])
      expect(db.all('SELECT id FROM files')).toEqual([])
    } finally { clearImmediate(abort) }
  })

  it('does not start a write transaction for an unchanged complete snapshot', async () => {
    writeVideo(path.join(root, 'Show', '01.mkv'))
    indexDisk(root)
    await scanLibrary(lib, db)
    const exec = vi.spyOn(db, 'exec')
    try {
      expect(await scanLibrary(lib, db)).toMatchObject({ changed: false, errors: [] })
      expect(exec.mock.calls.flat()).not.toContain('BEGIN IMMEDIATE')
    } finally { exec.mockRestore() }
  })

  it('captures filesystem baselines before each directory read', async () => {
    const order: string[] = []
    const baselines: string[] = []
    const readdir = fs.promises.readdir.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((directory, options) => {
      order.push(`read:${String(directory)}`)
      return readdir(directory as any, options as any) as any
    })
    try {
      const result = await scanLibrary(lib, db, { captureFilesystemBaseline: target => {
        baselines.push(target)
        order.push(`baseline:${target}`)
      } })
      expect(result).toMatchObject({ errors: [], changed: true })
      for (const read of order.filter(entry => entry.startsWith('read:'))) {
        const directory = read.slice('read:'.length)
        const readIndex = order.indexOf(read)
        expect(baselines).toContain(directory)
        expect(order.slice(0, readIndex)).toContain(`baseline:${directory}`)
      }
    } finally { spy.mockRestore() }
  })

  it('can cancel a stalled directory read without waiting for the OS result', async () => {
    const controller = new AbortController()
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const readdir = vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(() => {
      entered()
      return new Promise(() => {})
    })
    try {
      const scan = scanLibrary(lib, db, { signal: controller.signal })
      await reading
      controller.abort()
      expect(await scan).toMatchObject({ code: 'SCAN_CANCELLED', changed: false })
      expect(db.all('SELECT id FROM folders')).toEqual([])
    } finally { readdir.mockRestore() }
  })

  it('releases statements after initial, repeated and changed scans', async () => {
    const episode = path.join(root, 'Show', '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    const prepare = db.prepare.bind(db)
    const statements: ReturnType<Database['prepare']>[] = []
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      statements.push(statement)
      return statement
    })
    try {
      for (let round = 0; round < 3; round++) {
        if (round === 2) { fs.appendFileSync(episode, ' changed'); indexDisk(root) }
        expect(await scanLibrary(lib, db)).toMatchObject({ errors: [], changed: round !== 1 })
        expect(statements.filter(statement => !statement.isFinalized)).toHaveLength(0)
      }
    } finally {
      spy.mockRestore()
      for (const statement of statements) if (!statement.isFinalized) statement.finalize()
    }
  })

  it('does not re-import a restore-retained missing subtree', async () => {
    const show = path.join(root, 'Restore retained')
    const episode = path.join(show, '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    await scanLibrary(lib, db)
    const folder = db.prepare('SELECT id FROM folders WHERE path=?').get(show) as any
    const file = db.prepare('SELECT id FROM files WHERE path=?').get(episode) as any
    db.prepare("UPDATE folders SET path_missing=1, missing_source='restore' WHERE id=?").run(folder.id)
    db.prepare('UPDATE files SET path_missing=1 WHERE id=?').run(file.id)

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ added: 0, moved: 0, missing: 0, restored: 0, changed: false })
    expect(db.prepare('SELECT path_missing,missing_source FROM folders WHERE id=?').get(folder.id)).toEqual({ path_missing: 1, missing_source: 'restore' })
    expect(db.prepare('SELECT path_missing FROM files WHERE id=?').get(file.id)).toEqual({ path_missing: 1 })
  })

  it('does not clear restore retention when the retained item is the library root', async () => {
    db.prepare("INSERT INTO folders(library_id,parent_id,name,path,path_missing,missing_source) VALUES(?,NULL,?,?,1,'restore')")
      .run([lib.id, path.basename(root), root])
    indexDisk(root)

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ added: 0, updated: 0, moved: 0, missing: 0, restored: 0, changed: false })
    expect(db.prepare('SELECT path_missing,missing_source FROM folders WHERE path=?').get(root)).toEqual({ path_missing: 1, missing_source: 'restore' })
  })

  it('preserves timestamps when an unchanged legacy scan only bootstraps filesystem identities', async () => {
    const show = path.join(root, 'Legacy')
    const episode = path.join(show, '01.mkv')
    writeVideo(episode)
    indexDisk(root)
    const folders = makeFolderDb(db)
    folders.upsertTree(lib.id, [root, show])
    const showRow = folders.getByLibrary(lib.id).find(folder => folder.path === show)!
    const stat = fs.statSync(episode)
    makeFileDb(db).upsertMany(lib.id, [{
      folder_id: showRow.id, path: episode, name: '01.mkv', size: stat.size,
      date_modified: Math.floor(stat.mtimeMs / 1000), ext: 'mkv',
    }])
    db.exec("UPDATE folders SET updated_at='2001-01-01 00:00:00'; UPDATE files SET updated_at='2001-01-01 00:00:00'")

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ added: 0, updated: 0, changed: false })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folders WHERE filesystem_identity IS NOT NULL').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM files WHERE filesystem_identity IS NOT NULL').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT DISTINCT updated_at FROM folders').all()).toEqual([{ updated_at: '2001-01-01 00:00:00' }])
    expect(db.prepare('SELECT DISTINCT updated_at FROM files').all()).toEqual([{ updated_at: '2001-01-01 00:00:00' }])
  })
})
