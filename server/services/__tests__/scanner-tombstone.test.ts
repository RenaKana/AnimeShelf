import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { makeFolderDb } from '../../db/folders'
import { deleteFolderOnDisk } from '../folder-operations'
import { scanLibrary } from '../scanner'

const snapshot = vi.hoisted(() => ({ folders: [] as string[], files: [] as { path: string; size: number; dateModified: number }[] }))
vi.mock('../../../modules/season/server/libhit', () => ({ invalidateLibHitCache: vi.fn() }))
vi.mock('../../db/instance', () => { throw new Error('Scanner regression must not import the real database') })
vi.mock('../everything', () => ({ VIDEO_EXTS: ['mkv', 'mp4'], EverythingClient: class {
  async searchFiles() { return snapshot.files }
  async searchFolders() { return snapshot.folders }
} }))
afterEach(() => vi.restoreAllMocks())

it.runIf(process.platform === 'win32')('does not re-import a retained delete tombstone or descendants after cleanup failure', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-tombstone-scan-'))
  const root = path.join(temp, 'library')
  const source = path.join(root, 'Deleted Show')
  const db = createDb(':memory:')
  try {
    fs.mkdirSync(path.join(source, 'Season 1'), { recursive: true })
    fs.writeFileSync(path.join(source, 'Season 1', '01.mkv'), 'fixture')
    const lib = makeLibraryDb(db).create('Tombstone regression', root, 'anime')
    const folders = makeFolderDb(db)
    folders.upsertTree(lib.id, [root, source, path.join(source, 'Season 1')])
    const folder = folders.getByLibrary(lib.id).find(row => row.path === source)!
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('fixture cleanup denied'), { code: 'EPERM' }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deleted = await deleteFolderOnDisk(db, folder.id, { expectedPath: source })
    expect(deleted.cleanupPending).toBe(true)
    const tombstone = deleted.cleanupPath!
    const staging = path.join(root, '.animeshelf-rename-test')
    // Everything may see internal staging paths even after the database deletion committed.
    snapshot.folders = [root, tombstone, path.join(tombstone, 'Season 1'), staging]
    snapshot.files = [
      { path: path.join(tombstone, 'Season 1', '01.mkv'), size: 7, dateModified: 1 },
      { path: path.join(staging, '02.mkv'), size: 7, dateModified: 1 },
    ]
    const result = await scanLibrary(lib, db)
    expect(result.added).toBe(0)
    expect(result.errors).toEqual([])
    expect(folders.getByLibrary(lib.id).map(row => row.path)).toEqual([root])
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM folder_media_mappings').get()).toEqual({ n: 0 })
    expect(fs.existsSync(path.join(tombstone, 'Season 1', '01.mkv'))).toBe(true)
  } finally {
    db.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
