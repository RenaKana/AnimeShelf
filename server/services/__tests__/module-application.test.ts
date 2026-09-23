import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../../db/schema'
import { createApplication } from '../../application'
import { manifests } from '../../../.generated/modules'
import { requestLocalHttp } from './http-test-client'
import { makeLibraryDb } from '../../db/libraries'
import { makeFolderDb } from '../../db/folders'
import { makeFileDb } from '../../db/files'
import { sqlGet } from '../../db/sql'
import type { ExternalApiRouteContribution } from '../../core/external-api-contributions'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function start(enabled: string[]) {
  const db = createDb(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS module_config(module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
  for (const m of manifests) { const statement = db.prepare('INSERT INTO module_config VALUES (?,?)'); try { statement.run([m.id, enabled.includes(m.id) ? 1 : 0]) } finally { statement.finalize() } }
  const app = await createApplication({ database: db, backgroundTasks: false, distDir: 'nonexistent-test-build' })
  const server: Server = await new Promise(resolve => { const server = app.app.listen(0, '127.0.0.1', () => resolve(server)) })
  cleanup.push(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); await app.stop(); await closed; db.close() })
  return { app, db, server }
}

describe('assembled module application', () => {
  it('renames, moves and deletes real media through core HTTP with every optional module off', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-core-http-files-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const { db, server } = await start([])
    const sourceRoot = path.join(root, 'source'), targetRoot = path.join(root, 'target'), show = path.join(sourceRoot, 'Show')
    fs.mkdirSync(show, { recursive: true }); fs.mkdirSync(targetRoot)
    const episode = path.join(show, '01.mkv'); fs.writeFileSync(episode, 'test-media')
    const libraries = makeLibraryDb(db), folders = makeFolderDb(db)
    const source = libraries.create('Source', sourceRoot, 'anime'), target = libraries.create('Target', targetRoot, 'anime')
    folders.upsertTree(source.id, [sourceRoot, show]); folders.upsertTree(target.id, [targetRoot])
    const folder = folders.getByLibrary(source.id).find(f => f.path === show)!
    makeFileDb(db).upsertMany(source.id, [{ path: episode, folder_id: folder.id, name: '01.mkv', ext: 'mkv', size: 10, date_modified: 1 }])
    const send = (suffix: string, method: string, body: object) => { const json = JSON.stringify(body); return requestLocalHttp(server, `/api/folders/${folder.id}${suffix}`, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(json)) }, body: json }) }
    expect((await send('/rename', 'PUT', { name: 'Renamed', expectedPath: show })).status).toBe(200)
    const renamed = path.join(sourceRoot, 'Renamed')
    expect(fs.existsSync(path.join(renamed, '01.mkv'))).toBe(true)
    expect((await send('/move', 'PUT', { targetLibraryId: target.id, expectedPath: renamed })).status).toBe(200)
    const moved = path.join(targetRoot, 'Renamed')
    expect(fs.readFileSync(path.join(moved, '01.mkv'), 'utf8')).toBe('test-media')
    expect(sqlGet(db, 'SELECT library_id FROM folders WHERE id=?', folder.id)).toEqual({ library_id: target.id })
    expect((await send('', 'DELETE', { expectedPath: moved })).status).toBe(200)
    expect(fs.existsSync(moved)).toBe(false)
    expect(sqlGet(db, 'SELECT id FROM folders WHERE id=?', folder.id)).toBeNull()
  })
  it('starts every installed module with the legacy and generic routes', async () => {
    const { app, server } = await start(manifests.map(m => m.id))
    expect(app.modules.snapshot().modules.filter(m => !m.active)).toEqual([])
    expect(app.modules.contributions<ExternalApiRouteContribution>('externalApi.routes').map(value => value.moduleId).sort()).toEqual(['media-catalog', 'season'])
    for (const url of ['/api/metadata/search', '/api/season/calendar', '/api/download/sources', '/api/external-access']) {
      expect((await requestLocalHttp(server, url)).status, url).toBe(200)
    }
  })
  it('keeps removed feature routes unavailable even when legacy settings exist', async () => {
    const { db, server } = await start([])
    db.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('ai_base_url','https://example.org/v1'),('ai_model','test-model'),('ai_api_key','private-key'),('find_anime_web_provider','tavily')")
    for (const url of ['/api/find-anime/capabilities', '/api/settings/find-anime', '/api/settings/ai-provider', '/api/settings/media-catalog-ai', '/api/folders/media-catalog-ai/tasks']) {
      expect((await requestLocalHttp(server, url)).status, url).toBe(404)
    }
  })
  it('runs core with all optional modules off and keeps pinned folders reachable', async () => {
    const { db, server } = await start([])
    db.exec("INSERT INTO libraries(id,name,root_path,type) VALUES(1,'Core','D:\\Core','anime')")
    db.exec("INSERT INTO folders(id,library_id,parent_id,name,path,pinned) VALUES(1,1,NULL,'Retained collection','D:\\Core\\Show',1)")
    db.exec("INSERT INTO files(id,library_id,folder_id,path,name,ext) VALUES(1,1,1,'D:\\Core\\Show\\01.mkv','01.mkv','mkv')")
    expect((await requestLocalHttp(server, '/api/health')).status).toBe(200)
    const folders = await (await requestLocalHttp(server, '/api/folders?libraryId=1&type=series')).json()
    expect(folders.map((f: any) => f.id)).toContain(1)
    const detail = await (await requestLocalHttp(server, '/api/folders/1')).json()
    expect(detail).toMatchObject({ media_catalog: [], media_catalog_summary: null, media_catalog_v2: null })
    expect(detail.files).toHaveLength(1)
    for (const url of ['/api/wallpapers','/api/season/calendar','/api/metadata/search','/api/download/sources','/api/external-access']) expect((await requestLocalHttp(server, url)).status, url).toBe(404)
  })
  it('mounts wallpaper endpoints and saves next-boot configuration only', async () => {
    const { server } = await start(['wallpapers'])
    expect((await requestLocalHttp(server, '/api/wallpapers')).status).toBe(200)
    const saved = await requestLocalHttp(server, '/api/modules', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }, body: JSON.stringify({ enabled: { wallpapers: false } }) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ restartRequired: true })
    expect((await requestLocalHttp(server, '/api/wallpapers')).status).toBe(200)
  })
  it('rejects bearer tokens, hostile origins/hosts, and ownerless mutations', async () => {
    const { server } = await start([])
    const invalidHeaders: Record<string, string>[] = [{ Authorization: 'Bearer external-token' }, { Origin: 'https://example.org' }, { Host: 'example.org' }]
    for (const headers of invalidHeaders) expect((await requestLocalHttp(server, '/api/modules', { headers })).status).toBe(403)
    expect((await requestLocalHttp(server, '/api/modules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":{}}' })).status).toBe(403)
    expect((await requestLocalHttp(server, '/api/modules')).status).toBe(200)
  })
})
