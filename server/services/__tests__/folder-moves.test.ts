import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Database } from 'node-sqlite3-wasm'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeFolderDb } from '../../db/folders'
import { makeFileDb } from '../../db/files'
import { makeLibraryDb } from '../../db/libraries'
import { makeTagDb } from '../../db/tags'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'
import { FolderMoveService, browseMoveDirectories, completedMoveLocations } from '../folder-moves'
import { setBatchMediaDomain } from '../batch-media-domain'
import { assertLibraryAvailable } from '../library-maintenance'
import { restoreDatabaseTables } from '../../db/restore-tables'
import { createFolderMovesRouter } from '../../routes/folder-moves'
import { requestLocalHttp } from './http-test-client'
import { rebuildLibraryMediaCatalog } from '../../core/catalog-access'
import { serializeFilesystemIdentity } from '../filesystem-history'

describe('durable folder moves', () => {
  let temp: string, crossTemp: string | undefined, db: Database, service: FolderMoveService
  let sourceLibrary: ReturnType<ReturnType<typeof makeLibraryDb>['create']>, targetLibrary: typeof sourceLibrary
  let statements: Array<ReturnType<Database['prepare']>> = []
  function openFixture() {
    db = createDb(path.join(temp, 'fixture.db'))
    const prepare = db.prepare.bind(db)
    db.prepare = ((...args: Parameters<Database['prepare']>) => { const statement = prepare(...args); statements.push(statement); return statement }) as Database['prepare']
    bindTestModuleCapabilities(db)
  }
  function closeFixture() {
    // Legacy catalog/tag helpers leave prepared statements open. Finalize those
    // in the harness so a same-process reopen models a fresh process accurately.
    for (const statement of statements) if (!statement.isFinalized) statement.finalize()
    statements = []
    if (db.isOpen) db.close()
  }
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-moves-'))
    openFixture()
    for (const name of ['source', 'target']) fs.mkdirSync(path.join(temp, name))
    sourceLibrary = makeLibraryDb(db).create('Source', path.join(temp, 'source'), 'anime')
    targetLibrary = makeLibraryDb(db).create('Target', path.join(temp, 'target'), 'movie')
    service = new FolderMoveService(db)
  })
  afterEach(async () => {
    vi.restoreAllMocks(); await service.stop(); closeFixture()
    for (const directory of [temp, crossTemp].filter(Boolean) as string[]) {
      const absolute = path.resolve(directory)
      if (!path.basename(absolute).startsWith('animeshelf-moves-') || ![path.resolve(os.tmpdir()), path.resolve('.artifacts')].includes(path.dirname(absolute))) throw new Error('Unsafe cleanup')
      fs.rmSync(absolute, { recursive: true, force: true })
    }
    crossTemp = undefined
  })
  function fixture(name = 'Show') {
    const source = path.join(sourceLibrary.root_path, name)
    fs.mkdirSync(path.join(source, 'Season 1'), { recursive: true })
    fs.writeFileSync(path.join(source, 'Season 1', '01.mkv'), 'test-video-content')
    fs.writeFileSync(path.join(source, 'cover.jpg'), 'test-art')
    fs.writeFileSync(path.join(source, 'Season 1', '01.ass'), 'test-subtitle')
    const folders = makeFolderDb(db)
    folders.upsertTree(sourceLibrary.id, [sourceLibrary.root_path, source, path.join(source, 'Season 1')])
    const row = folders.getByLibrary(sourceLibrary.id).find(item => item.path === source)!
    const season = folders.getByLibrary(sourceLibrary.id).find(item => item.path === path.join(source, 'Season 1'))!
    makeFileDb(db).upsertMany(sourceLibrary.id, [{ path: path.join(source, 'Season 1', '01.mkv'), name: '01.mkv', folder_id: season.id, size: 18, ext: 'mkv', date_modified: Math.floor(Date.now() / 1000) }])
    db.run("UPDATE folders SET synopsis='Keep synopsis',media_domain_override='anime',has_poster=1 WHERE id=?", row.id)
    const tag = makeTagDb(db).create(`Inherited ${name}`)
    const root = folders.getByLibrary(sourceLibrary.id).find(item => item.path === sourceLibrary.root_path)!
    makeTagDb(db).link(tag.id, 'folder', root.id)
    return { id: row.id, expectedPath: source, tagId: tag.id, seasonId: season.id }
  }
  function input(item: ReturnType<typeof fixture>, relative = '') { return { items: [{ id: item.id, expectedPath: item.expectedPath }], targetLibraryId: targetLibrary.id, targetRelativePath: relative } }
  async function move(item: ReturnType<typeof fixture>, relative = '') { const job = await service.create(input(item, relative), randomUUID()); await service.wait(); return service.get(job.id) }
  function crossVolume() {
    const root = path.resolve('.artifacts')
    if (process.platform !== 'win32' || !fs.existsSync(root) || fs.statSync(root).dev === fs.statSync(temp).dev) return false
    crossTemp = fs.mkdtempSync(path.join(root, 'animeshelf-moves-cross-'))
    targetLibrary = makeLibraryDb(db).create('Cross volume', crossTemp, 'movie')
    return true
  }
  it('moves the entire tree into an existing child, retains IDs, metadata and inherited tags', async () => {
    const item = fixture(); fs.mkdirSync(path.join(targetLibrary.root_path, 'Series'))
    const before = db.all('SELECT id FROM files')
    const result = await move(item, 'Series')
    expect(result.items[0].phase).toBe('completed')
    const destination = path.join(targetLibrary.root_path, 'Series', 'Show')
    expect(fs.existsSync(item.expectedPath)).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'cover.jpg'), 'utf8')).toBe('test-art')
    expect(fs.readFileSync(path.join(destination, 'Season 1', '01.ass'), 'utf8')).toBe('test-subtitle')
    expect(db.get('SELECT path,library_id,synopsis,media_domain_override,has_poster FROM folders WHERE id=?', item.id)).toMatchObject({ path: destination, library_id: targetLibrary.id, synopsis: 'Keep synopsis', media_domain_override: 'anime', has_poster: 1 })
    expect(db.all('SELECT id FROM files')).toEqual(before)
    expect(makeTagDb(db).tagsForTarget('folder', item.id).map(tag => tag.id)).toContain(item.tagId)
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(db.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
    expect(completedMoveLocations(db)).toContainEqual({ from: item.expectedPath, to: destination })
  })
  it('performs a real cross-volume copy, verifies contents and removes the source only after commit', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture()
    const result = await move(item)
    expect(result.items[0]).toMatchObject({ crossVolume: true, phase: 'completed' })
    expect(fs.readFileSync(path.join(targetLibrary.root_path, 'Show', 'Season 1', '01.mkv'), 'utf8')).toBe('test-video-content')
    expect(fs.existsSync(item.expectedPath)).toBe(false)
    expect(fs.readdirSync(sourceLibrary.root_path).filter(name => name.startsWith('.animeshelf-'))).toEqual([])
    expect(db.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
  })
  it('skips overlap, rejects collisions and continues unrelated items without overwriting', async () => {
    const one = fixture('One'), two = fixture('Two')
    fs.mkdirSync(path.join(targetLibrary.root_path, 'One')); fs.writeFileSync(path.join(targetLibrary.root_path, 'One', 'keep'), 'original')
    const job = await service.create({ ...input(one), items: [one, one, two, { id: two.seasonId, expectedPath: path.join(two.expectedPath, 'Season 1') }] }, randomUUID())
    await service.wait(); const result = service.get(job.id)
    expect(result.items.map(item => item.phase)).toEqual(['failed', 'completed', 'skipped'])
    expect(fs.readFileSync(path.join(targetLibrary.root_path, 'One', 'keep'), 'utf8')).toBe('original')
    expect(fs.existsSync(one.expectedPath)).toBe(true)
  })
  it('keeps idempotency keys stable and does not create a duplicate move on response loss', async () => {
    const item = fixture(), key = randomUUID()
    const job = await service.create(input(item), key); await service.wait()
    expect((await service.create(input(item), key)).id).toBe(job.id)
    expect(service.list()).toHaveLength(1)
    await expect(service.create({ ...input(item), targetRelativePath: 'Elsewhere' }, key)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' })
  })
  it('rolls disk and database back when catalog rebuilding fails', async () => {
    const item = fixture()
    bindTestModuleCapabilities(db, { catalog: { rebuildLibrary() { throw new Error('injected database error') } } })
    const result = await move(item)
    expect(result.items[0].phase).toBe('failed')
    expect(fs.existsSync(item.expectedPath)).toBe(true)
    expect(fs.existsSync(path.join(targetLibrary.root_path, 'Show'))).toBe(false)
    expect(db.get('SELECT library_id,path FROM folders WHERE id=?', item.id)).toEqual({ library_id: sourceLibrary.id, path: item.expectedPath })
  })
  it('pauses on an altered source copy and leaves the original intact', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture()
    const utimes = fs.promises.utimes.bind(fs.promises)
    let changed = false
    vi.spyOn(fs.promises, 'utimes').mockImplementation(async (...args) => {
      await utimes(...args)
      if (!changed) { changed = true; fs.writeFileSync(path.join(item.expectedPath, 'cover.jpg'), 'external-change') }
    })
    const result = await move(item)
    expect(result.items[0]).toMatchObject({ phase: 'failed', code: 'CONTENT_CHANGED' })
    expect(result.status).toBe('paused')
    expect(fs.readFileSync(path.join(item.expectedPath, 'cover.jpg'), 'utf8')).toBe('external-change')
    expect(db.get('SELECT library_id FROM folders WHERE id=?', item.id)).toEqual({ library_id: sourceLibrary.id })
  })
  it('reports cleanup pending instead of success and resumes verified cleanup', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture()
    const unlink = fs.promises.unlink.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'unlink').mockImplementation(async file => {
      if (String(file).includes('.animeshelf-move-source-')) throw Object.assign(new Error('busy source file'), { code: 'EBUSY' })
      return unlink(file)
    })
    const result = await move(item)
    expect(result.items[0].phase).toBe('cleanup_pending')
    expect(() => assertLibraryAvailable(db)).toThrow('未完成')
    stub.mockRestore()
    await service.resume(result.id); await service.wait()
    expect(service.get(result.id).items[0].phase).toBe('completed')
  })
  it('does not replay old migration logs when restoring another database', async () => {
    const item = fixture(); const job = await move(item)
    const backup = createDb(':memory:')
    try { new FolderMoveService(backup); backup.exec('BEGIN; PRAGMA defer_foreign_keys=ON'); restoreDatabaseTables(backup, db); backup.exec('COMMIT'); expect(backup.get('SELECT count(*) AS n FROM folder_move_jobs')).toEqual({ n: 0 }); expect(service.get(job.id).items[0].phase).toBe('completed') }
    finally { backup.close() }
  })
  it('validates owner requests and confines directory browsing to the selected library', async () => {
    const app = express(); app.use(express.json()); app.use('/api/folder-moves', createFolderMovesRouter(db, service))
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      expect((await requestLocalHttp(server, '/api/folder-moves/preview', { method: 'POST', body: JSON.stringify(input(fixture())), headers: { 'content-type': 'application/json' } })).status).toBe(403)
      await expect(browseMoveDirectories(db, targetLibrary.id, '../source')).rejects.toMatchObject({ code: 'INVALID_TARGET' })
      expect((await browseMoveDirectories(db, targetLibrary.id)).relativePath).toBe('')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('rejects roots, missing sources, linked subtrees, self destinations and stale paths', async () => {
    const item = fixture()
    const root = makeFolderDb(db).getByLibrary(sourceLibrary.id).find(row => row.parent_id == null)!
    expect((await service.preview({ ...input(item), items: [{ id: root.id, expectedPath: root.path }] })).items[0].code).toBe('SOURCE_PROTECTED')
    expect((await service.preview({ ...input(item), items: [{ id: item.id, expectedPath: `${item.expectedPath}-old` }] })).items[0].code).toBe('STALE_SOURCE')
    expect((await service.preview({ ...input(item), targetLibraryId: sourceLibrary.id, targetRelativePath: 'Show/Season 1' })).items[0].code).toBe('DESTINATION_INSIDE_SOURCE')
    fs.symlinkSync(targetLibrary.root_path, path.join(item.expectedPath, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.preview(input(item))).items[0].code).toBe('UNSAFE_PATH')
    fs.unlinkSync(path.join(item.expectedPath, 'link'))
    fs.renameSync(item.expectedPath, `${item.expectedPath}-elsewhere`)
    expect((await service.preview(input(item))).items[0].phase).toBe('failed')
  })
  it('continues after an injected permission error and retries collisions after a fresh preview', async () => {
    const one = fixture('One'), two = fixture('Two')
    const rename = fs.promises.rename.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === one.expectedPath) throw Object.assign(new Error('injected permission denied'), { code: 'EACCES' })
      return rename(from, to)
    })
    const job = await service.create({ ...input(one), items: [one, two] }, randomUUID()); await service.wait()
    expect(service.get(job.id).items.map(item => item.phase)).toEqual(['failed', 'completed'])
    stub.mockRestore(); await service.resume(job.id, true); await service.wait()
    expect(service.get(job.id).items.map(item => item.phase)).toEqual(['completed', 'completed'])
    const three = fixture('Three'), collision = path.join(targetLibrary.root_path, 'Three')
    fs.mkdirSync(collision)
    const failed = await move(three); expect(failed.items[0].code).toBe('DESTINATION_EXISTS')
    fs.rmdirSync(collision); await service.resume(failed.id, true); await service.wait()
    expect(service.get(failed.id).items[0].phase).toBe('completed')
  })
  it('pauses the whole task when the target disappears after source staging, restoring the source', async () => {
    const one = fixture('One'), two = fixture('Two')
    const rename = fs.promises.rename.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(from) === one.expectedPath) fs.renameSync(targetLibrary.root_path, `${targetLibrary.root_path}-unavailable`)
    })
    const job = await service.create({ ...input(one), items: [one, two] }, randomUUID()); await service.wait()
    expect(service.get(job.id)).toMatchObject({ status: 'paused', items: [{ phase: 'failed', code: 'TARGET_INVALID' }, { phase: 'pending' }] })
    expect(fs.existsSync(one.expectedPath)).toBe(true); expect(fs.existsSync(two.expectedPath)).toBe(true)
    stub.mockRestore(); fs.renameSync(`${targetLibrary.root_path}-unavailable`, targetLibrary.root_path)
    await service.resume(job.id, true); await service.wait()
    expect(service.get(job.id).items.map(item => item.phase)).toEqual(['completed', 'completed'])
  })
  it('rolls back an injected cross-volume ENOSPC and processes the next item', async context => {
    if (!crossVolume()) return context.skip()
    const one = fixture('One'), two = fixture('Two')
    const statfs = fs.promises.statfs.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'statfs')
    stub.mockImplementationOnce(async (...args: any[]) => ({ ...(await statfs(args[0])), bavail: 0 }) as any)
    const job = await service.create({ ...input(one), items: [one, two] }, randomUUID()); await service.wait()
    expect(service.get(job.id).items.map(item => item.phase)).toEqual(['failed', 'completed'])
    expect(service.get(job.id).items[0].code).toBe('ENOSPC')
    expect(fs.existsSync(one.expectedPath)).toBe(true)
  })
  it('cancels at a safe copy boundary and can explicitly continue without duplicating files', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture()
    const utimes = fs.promises.utimes.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'utimes').mockImplementation(async (...args) => {
      await utimes(...args); service.cancel(service.list()[0].id)
    })
    const result = await move(item)
    expect(result.status).toBe('cancelled'); expect(result.items[0].phase).toBe('cancelled')
    expect(fs.existsSync(item.expectedPath)).toBe(true)
    expect(fs.readdirSync(targetLibrary.root_path)).toEqual([])
    stub.mockRestore(); await service.resume(result.id); await service.wait()
    expect(service.get(result.id).items[0].phase).toBe('completed')
  })
  it('rolls back the published cross-volume copy on database failure without losing source contents', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture()
    bindTestModuleCapabilities(db, { catalog: { rebuildLibrary() { throw new Error('injected commit failure') } } })
    const result = await move(item)
    expect(result.items[0].phase).toBe('failed')
    expect(fs.readFileSync(path.join(item.expectedPath, 'Season 1', '01.mkv'), 'utf8')).toBe('test-video-content')
    expect(fs.readdirSync(targetLibrary.root_path)).toEqual([])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
  })
  it('retains modified destination staging evidence instead of deleting a file merely because it owns the inode', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture(), two = fixture('Two')
    const utimes = fs.promises.utimes.bind(fs.promises)
    let modified = ''
    vi.spyOn(fs.promises, 'utimes').mockImplementation(async (...args) => {
      await utimes(...args)
      if (!modified) { modified = String(args[0]); fs.writeFileSync(modified, 'changed target content') }
    })
    const job = await service.create({ ...input(item), items: [item, two] }, randomUUID()); await service.wait()
    const result = service.get(job.id)
    expect(result.status).toBe('paused'); expect(result.items[0].phase).toBe('needs_attention')
    expect(result.items[1].phase).toBe('pending')
    expect(fs.readFileSync(modified, 'utf8')).toBe('changed target content')
    expect(fs.existsSync(item.expectedPath)).toBe(true)
    expect(result.items[0].recoveryPaths).toHaveLength(2)
  })
  it('does not mutate disk on restart; explicit reconciliation restores an interrupted publish before retry', async () => {
    const item = fixture()
    // Manufacture a crash after the persisted publish phase, before DB commit.
    const preview = await service.preview(input(item)), id = randomUUID()
    const target = preview.items[0].targetPath, sourceStage = path.join(sourceLibrary.root_path, `.animeshelf-move-source-${id}`)
    const evidence: any = { id, input: preview.input, status: 'running', cancelRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [{ ...preview.items[0], phase: 'published', sourceRoot: sourceLibrary.root_path, targetRoot: targetLibrary.root_path, sourceIdentity: serializeFilesystemIdentity(item.expectedPath, 'directory'), sourceStage, targetStage: path.join(targetLibrary.root_path, `.animeshelf-move-target-${id}`) }] }
    evidence.items[0].targetIdentity = evidence.items[0].sourceIdentity
    fs.renameSync(item.expectedPath, target)
    db.run('INSERT INTO folder_move_jobs(id,request_key,request_body,data,updated_at) VALUES(?,?,?,?,?)', [id, id, JSON.stringify(preview.input), JSON.stringify(evidence), evidence.updatedAt])
    await service.stop(); closeFixture(); openFixture(); service = new FolderMoveService(db)
    const rename = vi.spyOn(fs.promises, 'rename'), unlink = vi.spyOn(fs.promises, 'unlink')
    await service.recover()
    expect(rename).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled()
    expect(service.get(id).items[0].phase).toBe('needs_attention')
    expect(fs.existsSync(target)).toBe(true)
    await service.reconcile(id)
    expect(fs.existsSync(item.expectedPath)).toBe(true); expect(fs.existsSync(target)).toBe(false)
    await service.resume(id); await service.wait()
    expect(service.get(id).items[0].phase).toBe('completed')
  })
  it('rechecks committed copies after restart without blindly deleting them', async context => {
    if (!crossVolume()) return context.skip()
    const item = fixture(), unlink = fs.promises.unlink.bind(fs.promises)
    const stub = vi.spyOn(fs.promises, 'unlink').mockImplementation(async file => {
      if (String(file).includes('.animeshelf-move-source-')) throw new Error('injected cleanup interruption')
      return unlink(file)
    })
    const result = await move(item); stub.mockRestore()
    await service.stop(); closeFixture(); openFixture(); service = new FolderMoveService(db)
    const noDelete = vi.spyOn(fs.promises, 'unlink'); await service.recover(); expect(noDelete).not.toHaveBeenCalled()
    expect(service.get(result.id).items[0].phase).toBe('cleanup_pending')
    fs.writeFileSync(path.join(targetLibrary.root_path, 'Show', 'cover.jpg'), 'changed after crash')
    await service.resume(result.id); await service.wait()
    expect(service.get(result.id).items[0].phase).toBe('cleanup_pending')
    expect(noDelete).not.toHaveBeenCalled()
  })
  it('preserves manually locked catalog, canonical IDs, direct tags and cover binding', async () => {
    const item = fixture()
    db.run('UPDATE folders SET is_series=1,display_metadata_folder_id=? WHERE id=?', [item.seasonId, item.id])
    rebuildLibraryMediaCatalog(db, sourceLibrary.id)
    const mapping = db.get('SELECT id,media_item_id FROM folder_media_mappings WHERE folder_id=?', item.seasonId) as { id: number; media_item_id: number }
    expect(mapping).toBeTruthy()
    db.run("UPDATE folder_media_mappings SET manual_locked=1,detected_by='manual' WHERE id=?", mapping.id)
    const result = await move(item); expect(result.items[0].phase).toBe('completed')
    expect(db.get('SELECT media_item_id,manual_locked FROM folder_media_mappings WHERE folder_id=?', item.seasonId)).toMatchObject({ media_item_id: mapping.media_item_id, manual_locked: 1 })
    expect(db.get('SELECT library_id FROM media_items WHERE id=?', mapping.media_item_id)).toEqual({ library_id: targetLibrary.id })
    expect(db.get('SELECT display_metadata_folder_id FROM folders WHERE id=?', item.id)).toEqual({ display_metadata_folder_id: item.seasonId })
  })
  for (const cross of [false, true]) it(`recovers a real terminated process at publication (cross-volume=${cross})`, async context => {
    if (cross && !crossVolume()) return context.skip()
    const helper = path.resolve('server/services/__tests__/folder-move-crash.fixture.ts')
    const args = ['--import', 'tsx', helper]
    const crash = spawnSync(process.execPath, [...args, 'crash', temp, ...(crossTemp ? [path.join(crossTemp, 'process-target')] : [])], { encoding: 'utf8', timeout: 20000 })
    expect(crash.error ?? crash.stderr).toBeFalsy(); expect(crash.status).toBe(73)
    const recovery = spawnSync(process.execPath, [...args, 'recover', temp], { encoding: 'utf8', timeout: 20000 })
    expect(recovery.error ?? recovery.stderr).toBeFalsy(); expect(recovery.status).toBe(0)
    expect(JSON.parse(recovery.stdout)).toEqual({ recovered: true, crossVolume: cross })
  }, 45000)
  it('rolls back classification per library while allowing another library to succeed', async () => {
    const item = fixture(), second = fixture('Second')
    fs.mkdirSync(path.join(targetLibrary.root_path, 'Elsewhere'))
    makeFolderDb(db).upsertTree(targetLibrary.id, [targetLibrary.root_path, path.join(targetLibrary.root_path, 'Elsewhere')])
    const other = makeFolderDb(db).getByLibrary(targetLibrary.id).find(row => row.name === 'Elsewhere')!
    bindTestModuleCapabilities(db, { catalog: { rebuildLibrary(_db, id) { if (id === sourceLibrary.id) throw new Error('injected catalog failure') } } })
    const result = await setBatchMediaDomain(db, [item.id, second.id, other.id], 'unknown')
    expect(result.results.filter(item => !item.ok)).toHaveLength(2)
    expect(result.results).toContainEqual({ id: other.id, ok: true })
    expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', item.id)).toEqual({ media_domain_override: 'anime' })
    expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', other.id)).toEqual({ media_domain_override: 'unknown' })
  })
  it('updates only selected classifications, preserves children, reports invalid IDs and keeps the manual override after scan upsert', async () => {
    const item = fixture(), other = fixture('Other')
    const result = await setBatchMediaDomain(db, [item.id, 999999], 'live_action')
    expect(result.results).toContainEqual({ id: item.id, ok: true })
    expect(result.results).toContainEqual({ id: 999999, ok: false, error: '条目已不存在' })
    makeFolderDb(db).upsertTree(sourceLibrary.id, [item.expectedPath])
    expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', item.id)).toEqual({ media_domain_override: 'live_action' })
    expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', item.seasonId)).toEqual({ media_domain_override: null })
    expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', other.id)).toEqual({ media_domain_override: 'anime' })
    for (const override of ['anime', 'unknown', null]) { await setBatchMediaDomain(db, [item.id], override); expect(db.get('SELECT media_domain_override FROM folders WHERE id=?', item.id)).toEqual({ media_domain_override: override }) }
    await expect(setBatchMediaDomain(db, [], 'anime')).rejects.toMatchObject({ status: 400 })
  })
})
