import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'node-sqlite3-wasm'
import { createDb } from '../../db/schema'
import { makeFileDb } from '../../db/files'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { createLocalFilesRouter } from '../../routes/local-files'
import { openFolderInExplorer, revealFileInExplorer, validatePlayableFile, type ExplorerSpawn } from '../local-files'
import { requestLocalHttp } from './http-test-client'

function childThat(event: 'spawn' | 'error'): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  queueMicrotask(() => child.emit(event, event === 'error' ? new Error('spawn rejected') : undefined))
  return child
}

describe('local file actions', () => {
  let tempDir: string
  let root: string
  let folderPath: string
  let filePath: string
  let database: Database
  let folderId: number
  let fileId: number

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-local-files-'))
    root = path.join(tempDir, 'library')
    folderPath = path.join(root, 'Show')
    filePath = path.join(folderPath, 'episode-01.mkv')
    fs.mkdirSync(folderPath, { recursive: true })
    fs.writeFileSync(filePath, 'video')
    database = createDb(path.join(tempDir, 'test.db'))
    const library = makeLibraryDb(database).create('Anime', root, 'anime')
    const folderDb = makeFolderDb(database)
    folderDb.upsertTree(library.id, [root, folderPath])
    folderId = folderDb.getByLibrary(library.id).find(folder => folder.path === folderPath)!.id
    makeFileDb(database).upsertMany(library.id, [{
      path: filePath,
      folder_id: folderId,
      name: path.basename(filePath),
      size: 5,
      date_modified: 1,
      ext: 'mkv',
    }])
    fileId = (database.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number }).id
  })

  afterEach(() => {
    vi.restoreAllMocks()
    database.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('opens visible Explorer windows for database-resolved folders and files with shell disabled', async () => {
    const spawnExplorer = vi.fn<ExplorerSpawn>(() => childThat('spawn'))

    await expect(openFolderInExplorer(database, folderId, { spawn: spawnExplorer })).resolves.toEqual({ ok: true, path: fs.realpathSync(folderPath) })
    await expect(revealFileInExplorer(database, fileId, { spawn: spawnExplorer })).resolves.toEqual({ ok: true, path: fs.realpathSync(filePath) })

    expect(spawnExplorer).toHaveBeenNthCalledWith(1, 'explorer.exe', [fs.realpathSync(folderPath)], { shell: false, windowsHide: false })
    expect(spawnExplorer).toHaveBeenNthCalledWith(2, 'explorer.exe', [`/select,${fs.realpathSync(filePath)}`], { shell: false, windowsHide: false })
  })

  it('validates playback against both retained-missing markers and the real file', async () => {
    await expect(validatePlayableFile(database, fileId)).resolves.toBe(fs.realpathSync(filePath))
    database.prepare('UPDATE files SET path_missing=1 WHERE id=?').run(fileId)
    await expect(validatePlayableFile(database, fileId)).rejects.toMatchObject({ code: 'PATH_NOT_FOUND', status: 404 })
    database.prepare('UPDATE files SET path_missing=0 WHERE id=?').run(fileId)
    database.prepare('UPDATE folders SET path_missing=1 WHERE id=?').run(folderId)
    await expect(validatePlayableFile(database, fileId)).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' })
    database.prepare('UPDATE folders SET path_missing=0 WHERE id=?').run(folderId)
    fs.unlinkSync(filePath)
    await expect(validatePlayableFile(database, fileId)).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' })
  })

  it('rejects missing, outside-library, and symlink-boundary paths before spawning', async () => {
    const spawnExplorer = vi.fn<ExplorerSpawn>(() => childThat('spawn'))
    const missing = path.join(root, 'Missing')
    database.prepare('UPDATE folders SET path = ? WHERE id = ?').run([missing, folderId])
    await expect(openFolderInExplorer(database, folderId, { spawn: spawnExplorer })).rejects.toMatchObject({ code: 'PATH_NOT_FOUND', status: 404 })

    const outside = path.join(tempDir, 'outside')
    fs.mkdirSync(outside)
    database.prepare('UPDATE folders SET path = ? WHERE id = ?').run([outside, folderId])
    await expect(openFolderInExplorer(database, folderId, { spawn: spawnExplorer })).rejects.toMatchObject({ code: 'OUTSIDE_LIBRARY', status: 409 })

    const linked = path.join(root, 'linked')
    fs.symlinkSync(outside, linked, 'junction')
    database.prepare('UPDATE folders SET path = ? WHERE id = ?').run([linked, folderId])
    await expect(openFolderInExplorer(database, folderId, { spawn: spawnExplorer })).rejects.toMatchObject({ code: 'SYMLINK_BOUNDARY', status: 409 })
    expect(spawnExplorer).not.toHaveBeenCalled()
  })

  it('reports explorer startup errors', async () => {
    const spawnExplorer = vi.fn<ExplorerSpawn>(() => childThat('error'))
    await expect(openFolderInExplorer(database, folderId, { spawn: spawnExplorer })).rejects.toMatchObject({
      code: 'EXPLORER_START_FAILED',
      status: 500,
    })
  })

  it('enforces the owner header at the router boundary', async () => {
    const spawnExplorer = vi.fn<ExplorerSpawn>(() => childThat('spawn'))
    const app = express()
    app.use('/api/local-files', createLocalFilesRouter(() => database, { spawn: spawnExplorer }))
    const server: Server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    try {
      expect((await requestLocalHttp(server, `/api/local-files/folder/${folderId}/open`, { method: 'POST' })).status).toBe(403)
      expect((await requestLocalHttp(server, '/api/local-files/folder/not-a-number/open', { method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } })).status).toBe(400)
      const response = await requestLocalHttp(server, `/api/local-files/file/${fileId}/reveal`, { method: 'POST', headers: { 'X-AnimeShelf-Owner': '1' } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, path: fs.realpathSync(filePath) })
      expect(spawnExplorer).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
