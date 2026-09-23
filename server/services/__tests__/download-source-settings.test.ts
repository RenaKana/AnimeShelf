import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb } from '../../db/schema'
import { makeSettingsDb } from '../../db/settings'
import { createApplication } from '../../application'
import { manifests } from '../../../.generated/modules'
import { DOWNLOAD_SOURCES_KEY } from '../../../shared/download-sources'
import { requestLocalHttp } from './http-test-client'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

describe('retired download source configuration', () => {
  it('preserves legacy values, retires dedicated routes, and rejects mixed generic writes', async () => {
    const db = createDb(':memory:')
    db.exec('CREATE TABLE IF NOT EXISTS module_config(module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
    for (const module of manifests) db.exec(`INSERT INTO module_config VALUES('${module.id}', ${module.id === 'download' ? 1 : 0})`)
    const settings = makeSettingsDb(db)
    const legacyValue = '{"version":1,"sources":[{"id":"bangumi","url":"https://legacy.example/"}]}'
    settings.set(DOWNLOAD_SOURCES_KEY, legacyValue)
    settings.set('tmdb_key', 'private-test-key')
    const application = await createApplication({ database: db, backgroundTasks: false, distDir: 'absent-test-output' })
    const server: Server = await new Promise(resolve => { const value = application.app.listen(0, '127.0.0.1', () => resolve(value)) })
    cleanup.push(async () => {
      await application.stop()
      await new Promise<void>(resolve => server.close(() => resolve()))
      db.close()
    })

    const owner = { 'X-AnimeShelf-Owner': '1' }
    for (const method of ['GET', 'PUT']) {
      const response = await requestLocalHttp(server, '/api/settings/download-sources', {
        method,
        headers: method === 'PUT' ? { ...owner, 'Content-Type': 'application/json' } : owner,
        body: method === 'PUT' ? '{}' : undefined,
      })
      expect(response.status, method).toBe(404)
    }
    const denied = { Authorization: 'Bearer synthetic' }
    expect((await requestLocalHttp(server, '/api/download/sources', { headers: denied })).status).toBe(403)
    expect((await requestLocalHttp(server, '/api/download/resources?source=bangumi', { headers: denied })).status).toBe(403)

    const sources = await (await requestLocalHttp(server, '/api/download/sources', { headers: owner })).json<any>()
    expect(sources.sources).toEqual([
      { id: 'bangumi', name: 'Bangumi.moe', url: 'https://bangumi.moe/' },
      { id: 'acgrip', name: 'ACG.RIP', url: 'https://acg.rip/' },
      { id: 'dmhy', name: '动漫花园', url: 'https://share.dmhy.org/' },
      { id: 'nyaa', name: 'Nyaa', url: 'https://nyaa.si/', note: '遵守原站限流，按实际响应显示状态' },
    ])
    expect(sources.sources.map((source: { id: string }) => source.id)).not.toContain('acgnx')
    expect(settings.get(DOWNLOAD_SOURCES_KEY)).toBe(legacyValue)

    const mixedBody = JSON.stringify({ [DOWNLOAD_SOURCES_KEY]: 'attacker-value', tmdb_key: 'must-not-write', unrelated: 'must-not-write' })
    const mixed = await requestLocalHttp(server, '/api/settings', {
      method: 'PUT', headers: { ...owner, 'Content-Type': 'application/json' }, body: mixedBody,
    })
    expect(mixed.status).toBe(400)
    expect(settings.get(DOWNLOAD_SOURCES_KEY)).toBe(legacyValue)
    expect(settings.get('tmdb_key')).toBe('private-test-key')
    expect(settings.get('unrelated')).toBeUndefined()

    const publicSettings = await (await requestLocalHttp(server, '/api/settings')).json<Record<string, string>>()
    expect(publicSettings).not.toHaveProperty(DOWNLOAD_SOURCES_KEY)
    expect(publicSettings).not.toHaveProperty('tmdb_key')
    expect(publicSettings.tmdb_key_configured).toBe('1')

  })
})
