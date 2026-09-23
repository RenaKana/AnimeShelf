import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, ensureSystemTags } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { scanLibrary } from '../scanner'
import type { Library } from '../../types'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const libhitMock = vi.hoisted(() => ({ invalidateLibHitCache: vi.fn() }))
const snapshot = vi.hoisted(() => ({
  files: [] as Array<{ path: string; size: number; dateModified: number }>,
  folders: [] as string[],
}))

vi.mock('../everything', () => {
  const searchFiles = vi.fn().mockImplementation(async () => snapshot.files)
  const searchFolders = vi.fn().mockImplementation(async () => snapshot.folders)
  return {
    VIDEO_EXTS: ['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'flv', 'ts', 'webm'],
    EverythingClient: vi.fn().mockImplementation(function (this: any, baseUrl: string) {
      this.baseUrl = baseUrl
      this.searchFiles = searchFiles
      this.searchFolders = searchFolders
    }),
    resetMocks: () => {
      searchFiles.mockReset().mockImplementation(async () => snapshot.files)
      searchFolders.mockReset().mockImplementation(async () => snapshot.folders)
    },
  }
})

async function resetEverythingMocks() {
  const mod = (await import('../everything')) as unknown as { resetMocks: () => void }
  mod.resetMocks()
}

function writeVideo(target: string, content = 'video') {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  const stat = fs.statSync(target)
  return { path: target, size: stat.size, dateModified: Math.floor(stat.mtimeMs / 1000) }
}

describe.runIf(process.platform === 'win32')('scanLibrary', () => {
  let db: any
  let lib: Library
  let temp: string
  let root: string

  beforeEach(async () => {
    await resetEverythingMocks()
    libhitMock.invalidateLibHitCache.mockClear()
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-scanner-base-'))
    root = path.join(temp, 'Anime')
    fs.mkdirSync(root)
    const series = path.join(root, '进击的巨人')
    snapshot.files = [
      writeVideo(path.join(series, 'S01E01.mkv'), '1000'),
      writeVideo(path.join(series, 'S01E02.mkv'), '1000'),
      writeVideo(path.join(root, '千与千寻 (2001).mkv'), '2000'),
    ]
    snapshot.folders = [root, series]
    db = createDb(':memory:')
    ensureSystemTags(db)
    lib = makeLibraryDb(db).create('动漫', root, 'anime')
    bindTestModuleCapabilities(db, { invalidateLibraryMatches: libhitMock.invalidateLibHitCache })
  })

  afterEach(() => {
    if (db?.isOpen) db.close()
    fs.rmSync(temp, { recursive: true, force: true })
  })

  it('builds folder tree, files, series marks and change-aware counts', async () => {
    const first = await scanLibrary(lib, db)
    expect(first).toMatchObject({ added: 3, removed: 0, changed: true })
    const folders = db.prepare('SELECT * FROM folders ORDER BY path').all()
    expect(folders).toHaveLength(2)
    const series = folders.find((folder: any) => folder.name === '进击的巨人')
    const rootFolder = folders.find((folder: any) => folder.path === root)
    expect(series.is_series).toBe(1)
    expect(series.parent_id).toBe(rootFolder.id)
    expect(rootFolder.is_series).toBe(0)
    expect(db.prepare("SELECT folder_id FROM files WHERE name='千与千寻 (2001).mkv'").get()).toEqual({ folder_id: rootFolder.id })

    const second = await scanLibrary(lib, db)
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0, changed: false })
    expect(libhitMock.invalidateLibHitCache).toHaveBeenCalledTimes(1)
  })

  it('marks vanished files missing and clears the active series flag without deleting rows', async () => {
    await scanLibrary(lib, db)
    fs.rmSync(path.join(root, '进击的巨人'), { recursive: true })
    snapshot.files = snapshot.files.filter(file => file.path.endsWith('千与千寻 (2001).mkv'))
    snapshot.folders = [root]

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ removed: 0, missing: 3 })
    const series = db.prepare("SELECT * FROM folders WHERE name='进击的巨人'").get()
    expect(series).toMatchObject({ is_series: 1, path_missing: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM files WHERE path_missing=1").get()).toEqual({ count: 2 })
  })

  it('retains missing files, folders, and their tag links', async () => {
    await scanLibrary(lib, db)
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get('状态:未看')
    const file = db.prepare("SELECT * FROM files WHERE name = 'S01E01.mkv'").get()
    const folder = db.prepare("SELECT * FROM folders WHERE name = '进击的巨人'").get()
    db.prepare('INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, ?, ?)').run([tag.id, 'file', file.id])
    db.prepare('INSERT INTO tag_links (tag_id, target_type, target_id) VALUES (?, ?, ?)').run([tag.id, 'folder', folder.id])
    fs.rmSync(path.join(root, '进击的巨人'), { recursive: true })
    fs.rmSync(path.join(root, '千与千寻 (2001).mkv'))
    snapshot.files = []
    snapshot.folders = [root]

    const result = await scanLibrary(lib, db)

    expect(result).toMatchObject({ removed: 0, missing: 4 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 3 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM folders').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_links').get()).toEqual({ count: 2 })
  })

  it('marks a direct child as the main folder when it and a nested extras folder contain files', async () => {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root)
    const fate = path.join(root, 'Fate')
    const extras = path.join(fate, 'Sp')
    snapshot.files = [writeVideo(path.join(fate, 'Fate01.mkv')), writeVideo(path.join(extras, 'sp.mkv'))]
    snapshot.folders = [root, fate, extras]
    await scanLibrary(lib, db)
    expect(db.prepare('SELECT path,is_series FROM folders ORDER BY path').all()).toEqual(expect.arrayContaining([
      { path: root, is_series: 0 }, { path: fate, is_series: 1 }, { path: extras, is_series: 0 },
    ]))
  })

  it('marks main folders below a recognized base folder', async () => {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root)
    const base = path.join(root, 'Series')
    const first = path.join(base, '番剧1')
    const second = path.join(base, '番剧2')
    snapshot.files = [writeVideo(path.join(first, '01.mkv')), writeVideo(path.join(second, '01.mkv'))]
    snapshot.folders = [root, base, first, second]
    await scanLibrary(lib, db)
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(base)).toEqual({ is_series: 0 })
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(first)).toEqual({ is_series: 1 })
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(second)).toEqual({ is_series: 1 })
  })

  it('marks only the aggregate folder in a multi-season structure', async () => {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root)
    const fate = path.join(root, 'Fate Series')
    const ubw = path.join(fate, 'UBW')
    const zero = path.join(fate, 'Zero')
    snapshot.files = [writeVideo(path.join(ubw, 'ubw01.mkv')), writeVideo(path.join(zero, 'zero01.mkv'))]
    snapshot.folders = [root, fate, ubw, zero]
    await scanLibrary(lib, db)
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(fate)).toEqual({ is_series: 1 })
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(ubw)).toEqual({ is_series: 0 })
    expect(db.prepare('SELECT is_series FROM folders WHERE path=?').get(zero)).toEqual({ is_series: 0 })
  })

  it('rebuilds the persistent media catalog after series marking', async () => {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root)
    const demo = path.join(root, 'Demo')
    const season = path.join(demo, 'Season 2')
    snapshot.files = [writeVideo(path.join(season, 'S02E01.mkv'))]
    snapshot.folders = [root, demo, season]
    await scanLibrary(lib, db)
    expect(db.prepare(`
      SELECT e.kind, e.season_number, f.path AS folder_path
      FROM folder_media_entries e JOIN folders f ON f.id = e.folder_id
      ORDER BY f.path
    `).all()).toEqual([{ kind: 'season', season_number: 2, folder_path: season }])
  })
})
