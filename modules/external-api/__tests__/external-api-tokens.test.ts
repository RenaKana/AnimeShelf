import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../../../server/db/schema'
import { makeExternalApiStore } from '../server/external-api-tokens'

const databases: ReturnType<typeof createDb>[] = []
function fixture() {
  const db = createDb(':memory:')
  databases.push(db)
  let now = Date.parse('2026-09-05T12:00:00Z')
  return { db, store: makeExternalApiStore(db, () => now), advance: () => { now += 3600_000 } }
}
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('external API token storage', () => {
  it('starts disabled on a separate fixed port', () => {
    expect(fixture().store.getConfig()).toEqual({ enabled: false, port: 3003 })
  })
  it('creates read-only tokens by default and persists only their hash', () => {
    const { db, store } = fixture()
    const issued = store.createToken({ name: '本机脚本' })
    expect(issued.token).toMatch(/^as_[A-Za-z0-9_-]{43}$/)
    expect(issued.token_info.role).toBe('read')
    expect(store.authenticate(issued.token)?.id).toBe(issued.token_info.id)
    const rows = db.prepare('SELECT * FROM external_api_tokens').all()
    expect(JSON.stringify(rows)).not.toContain(issued.token)
    expect(JSON.stringify(store.listTokens())).not.toContain('token_hash')
    expect(JSON.stringify(store.listTokens())).not.toContain(issued.token)
    expect(store.authenticate('not-a-token')).toBeNull()
  })
  it('takes role downgrades and disable/revoke into account on every request', () => {
    const { store } = fixture()
    const issued = store.createToken({ name: '管理脚本', role: 'files' })
    store.updateToken(issued.token_info.id, { role: 'read' })
    expect(store.authenticate(issued.token)?.role).toBe('read')
    store.updateToken(issued.token_info.id, { role: 'disabled' })
    expect(store.authenticate(issued.token)).toBeNull()
    store.updateToken(issued.token_info.id, { role: 'edit' })
    expect(store.authenticate(issued.token)?.role).toBe('edit')
    store.revokeToken(issued.token_info.id)
    expect(store.authenticate(issued.token)).toBeNull()
    expect(() => store.updateToken(issued.token_info.id, { role: 'files' })).toThrow()
  })
  it('expires at the exact deadline', () => {
    const { store, advance } = fixture()
    const issued = store.createToken({ name: '临时', expires_at: '2026-09-05T13:00:00Z' })
    expect(store.authenticate(issued.token)).not.toBeNull()
    advance()
    expect(store.authenticate(issued.token)).toBeNull()
  })
  it('rejects invalid roles, unknown keys and invalid expiry/config', () => {
    const { store } = fixture()
    for (const input of [{ name: '' }, { name: 'x', role: 'admin' }, { name: 'x', token: 'chosen' }, { name: 'x', expires_at: 'garbage' }, { name: 'x', expires_at: '2020-01-01' }]) {
      expect(() => store.createToken(input as any)).toThrow()
    }
    for (const config of [{ enabled: 'true', port: 3003 }, { enabled: true, port: 0 }, { enabled: true, port: 65536 }, { enabled: true, port: 3003, host: '0.0.0.0' }]) {
      expect(() => store.setConfig(config as any)).toThrow()
    }
    expect(store.getConfig()).toEqual({ enabled: false, port: 3003 })
  })
  it('persists credentials and config through a real database close/reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-external-token-'))
    const filename = path.join(directory, 'test.db')
    let db = createDb(filename)
    try {
      const store = makeExternalApiStore(db)
      const issued = store.createToken({ name: 'Integration', role: 'edit' })
      store.setConfig({ enabled: true, port: 13003 })
      db.close()
      db = createDb(filename)
      const reopened = makeExternalApiStore(db)
      expect(reopened.getConfig()).toEqual({ enabled: true, port: 13003 })
      expect(reopened.authenticate(issued.token)?.role).toBe('edit')
      expect(JSON.stringify(db.prepare('SELECT * FROM external_api_tokens').all())).not.toContain(issued.token)
      expect(fs.readFileSync(filename).includes(Buffer.from(issued.token))).toBe(false)
    } finally {
      try { db.close() } catch { /* do not mask the original reopen assertion */ }
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
