import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, ensureSystemTags } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { scanLibrary } from '../scanner'
import { requestLocalHttp } from './http-test-client'
import { bindTestModuleCapabilities } from './module-capabilities-fixture'

const mockedInstance = vi.hoisted(() => ({ db: undefined as any }))
vi.mock('../../db/instance', () => mockedInstance)

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server: http.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise(resolve => server.close(() => resolve()))
}

function everythingRow(target: string): { path: string; name: string } {
  return { path: path.win32.dirname(target), name: path.win32.basename(target) }
}

function fileTime(stat: fs.Stats): string {
  return String(Math.floor(stat.mtimeMs * 10_000 + 116_444_736_000_000_000))
}

describe('library type persistence through a real isolated scan', () => {
  let db: any
  let databasePath: string
  let tempRoot: string
  let mediaRoot: string
  let seriesRoot: string
  let videoPath: string
  let apiServer: http.Server | undefined
  let everythingServer: http.Server | undefined
  let everythingRequests = 0
  let invalidateMatches: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-library-type-real-scan-'))
    mediaRoot = path.join(tempRoot, 'Media')
    seriesRoot = path.join(mediaRoot, 'Show')
    videoPath = path.join(seriesRoot, '01.mkv')
    fs.mkdirSync(seriesRoot, { recursive: true })
    fs.writeFileSync(videoPath, 'synthetic media')

    const inventory = {
      folders: [mediaRoot, seriesRoot].map(everythingRow),
      files: [{ ...everythingRow(videoPath), size: String(fs.statSync(videoPath).size), date_modified: fileTime(fs.statSync(videoPath)) }],
    }
    everythingServer = http.createServer((request, response) => {
      everythingRequests++
      const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
      const rows = query.get('search')?.includes('folder:') ? inventory.folders : inventory.files
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ totalResults: rows.length, results: rows }))
    })
    await listen(everythingServer)
    const everythingAddress = everythingServer.address() as AddressInfo
    const everythingUrl = `http://127.0.0.1:${everythingAddress.port}`

    databasePath = path.join(tempRoot, 'animeshelf.db')
    db = createDb(databasePath)
    mockedInstance.db = db
    ensureSystemTags(db)
    invalidateMatches = vi.fn()
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false, invalidateLibraryMatches: invalidateMatches })
    const library = makeLibraryDb(db).create('隔离媒体库', mediaRoot, 'anime', everythingUrl)

    const librariesRouter = (await import('../../routes/libraries')).default
    const app = express()
    app.use(express.json())
    app.use('/api/libraries', librariesRouter)
    apiServer = http.createServer(app)
    await listen(apiServer)
    expect(library.type).toBe('anime')
  })

  afterEach(async () => {
    await close(apiServer)
    await close(everythingServer)
    apiServer = undefined
    everythingServer = undefined
    if (db?.isOpen) db.close()
    mockedInstance.db = undefined
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('keeps live-action type after PUT, real scan, and database reopen', async () => {
    const library = makeLibraryDb(db).getAll()[0]
    const response = await requestLocalHttp(apiServer!, `/api/libraries/${library.id}`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'live_action' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: library.id, type: 'live_action' })

    const updated = makeLibraryDb(db).getById(library.id)!
    const scan = await scanLibrary(updated, db)
    expect(scan).toMatchObject({ added: 1, updated: 0, removed: 0, changed: true, errors: [] })
    expect(makeLibraryDb(db).getById(library.id)?.type).toBe('live_action')
    expect(everythingRequests).toBe(2)

    db.close()
    db = createDb(databasePath)
    mockedInstance.db = db
    bindTestModuleCapabilities(db, { activeModules: [], catalog: false, invalidateLibraryMatches: invalidateMatches })
    const reopened = makeLibraryDb(db).getById(library.id)!
    expect(reopened.type).toBe('live_action')
    const rescan = await scanLibrary(reopened, db)
    expect(rescan).toMatchObject({ added: 0, updated: 0, removed: 0, changed: false, errors: [] })
    expect(makeLibraryDb(db).getById(library.id)?.type).toBe('live_action')
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(invalidateMatches).toHaveBeenCalled()
  })
})
