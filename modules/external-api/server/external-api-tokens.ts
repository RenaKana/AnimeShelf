import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Database } from 'node-sqlite3-wasm'
import { as } from '../../../server/db/schema'
import type { ExternalApiConfig, ExternalApiRole, ExternalApiTokenCreated, ExternalApiTokenInfo, ExternalApiTokenInput } from '../../../shared/external-api'

export class ExternalApiError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_INPUT') { super(message) }
}

type StoredToken = ExternalApiTokenInfo & { token_hash: string }
const roles: ExternalApiRole[] = ['files', 'edit', 'read', 'disabled']
const info = ({ id, name, prefix, role, created_at, expires_at, last_used_at, revoked_at }: StoredToken): ExternalApiTokenInfo =>
  ({ id, name, prefix, role, created_at, expires_at, last_used_at, revoked_at })

function objectWithKeys(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new ExternalApiError('请求包含无效或不支持的字段')
  }
  return input as Record<string, unknown>
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExternalApiError('令牌名称须为 1–80 个字符')
  }
  return value.trim()
}

function roleOf(value: unknown): ExternalApiRole {
  if (!roles.includes(value as ExternalApiRole)) throw new ExternalApiError('无效的权限级别')
  return value as ExternalApiRole
}

function expiryOf(value: unknown, now: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now) {
    throw new ExternalApiError('有效期必须为未来的 ISO 日期时间，或 null（不过期）')
  }
  return new Date(value).toISOString()
}

export function validateExternalApiConfig(input: unknown): ExternalApiConfig {
  const config = objectWithKeys(input, ['enabled', 'port'])
  if (typeof config.enabled !== 'boolean' || typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new ExternalApiError('请设置启用状态和 1024–65535 之间的端口')
  }
  return { enabled: config.enabled, port: config.port }
}

export function makeExternalApiStore(db: Database, now: () => number = Date.now) {
  // sqlite3-wasm keeps locks for unfinalized statements, including one-row reads.
  // Release each statement so disabling/restarting the application can reopen its DB.
  type Statement = ReturnType<Database['prepare']>
  const query = <T>(sql: string, read: (statement: Statement) => T): T => {
    const statement = db.prepare(sql)
    try { return read(statement) } finally { statement.finalize() }
  }
  const get = <T>(sql: string, params: Parameters<Statement['get']>[0] = []): T => query(sql, statement => as<T>(statement.get(params)))
  const run = (sql: string, params: Parameters<Statement['run']>[0]) => query(sql, statement => statement.run(params))
  const byId = (id: string): StoredToken => {
    const row = get<StoredToken | null>('SELECT * FROM external_api_tokens WHERE id = ?', id)
    if (!row) throw new ExternalApiError('令牌不存在', 404, 'TOKEN_NOT_FOUND')
    return row
  }
  return {
    getConfig(): ExternalApiConfig {
      const row = get<{ enabled: number; port: number }>('SELECT enabled, port FROM external_api_config WHERE id = 1')
      return { enabled: row.enabled === 1, port: row.port }
    },
    setConfig(input: ExternalApiConfig): ExternalApiConfig {
      const config = validateExternalApiConfig(input)
      run('UPDATE external_api_config SET enabled = ?, port = ? WHERE id = 1', [config.enabled ? 1 : 0, config.port])
      return config
    },
    listTokens(): ExternalApiTokenInfo[] {
      return query('SELECT * FROM external_api_tokens ORDER BY created_at DESC, id', statement => as<StoredToken[]>(statement.all()).map(info))
    },
    createToken(input: ExternalApiTokenInput): ExternalApiTokenCreated {
      const values = objectWithKeys(input, ['name', 'role', 'expires_at'])
      const name = nameOf(values.name)
      const role = roleOf(values.role ?? 'read')
      const expires_at = values.expires_at === undefined ? null : expiryOf(values.expires_at, now())
      const active = get<{ count: number }>('SELECT COUNT(*) AS count FROM external_api_tokens WHERE revoked_at IS NULL')
      if (active.count >= 100) throw new ExternalApiError('最多保留 100 个未撤销令牌', 409, 'TOKEN_LIMIT')
      // Cryptographic random tokens, not user passwords. Plaintext exists only in this response.
      // https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandombytessize-callback
      const token = `as_${randomBytes(32).toString('base64url')}`
      const id = randomUUID()
      run('INSERT INTO external_api_tokens (id, name, prefix, token_hash, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, name, token.slice(0, 11), createHash('sha256').update(token).digest('hex'), role, new Date(now()).toISOString(), expires_at])
      return { token, token_info: info(byId(id)) }
    },
    updateToken(id: string, input: Partial<ExternalApiTokenInput>): ExternalApiTokenInfo {
      const values = objectWithKeys(input, ['name', 'role', 'expires_at'])
      if (!Object.keys(values).length) throw new ExternalApiError('请提供要修改的字段')
      const row = byId(id)
      if (row.revoked_at) throw new ExternalApiError('已撤销的令牌不能恢复', 409, 'TOKEN_REVOKED')
      const name = values.name === undefined ? row.name : nameOf(values.name)
      const role = values.role === undefined ? row.role : roleOf(values.role)
      const expires_at = values.expires_at === undefined ? row.expires_at : expiryOf(values.expires_at, now())
      run('UPDATE external_api_tokens SET name = ?, role = ?, expires_at = ? WHERE id = ?', [name, role, expires_at, id])
      return info(byId(id))
    },
    revokeToken(id: string): void {
      byId(id)
      run('UPDATE external_api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [new Date(now()).toISOString(), id])
    },
    authenticate(token: string): ExternalApiTokenInfo | null {
      if (!/^as_[A-Za-z0-9_-]{43}$/.test(token)) return null
      const hash = createHash('sha256').update(token).digest('hex')
      const row = get<StoredToken | null>('SELECT * FROM external_api_tokens WHERE token_hash = ?', hash)
      if (!row || row.revoked_at || !roles.includes(row.role) || row.role === 'disabled') return null
      if (row.expires_at && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now())) return null
      if (row.token_hash.length !== hash.length || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null
      if (!row.last_used_at || now() - Date.parse(row.last_used_at) >= 60_000) {
        row.last_used_at = new Date(now()).toISOString()
        run('UPDATE external_api_tokens SET last_used_at = ? WHERE id = ?', [row.last_used_at, row.id])
      }
      return info(row)
    },
    recordAudit(tokenId: string, method: string, route: string, status: number): void {
      run('INSERT INTO external_api_audit (token_id, method, route, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [tokenId, method.slice(0, 10), route.slice(0, 160), status, new Date(now()).toISOString()])
      db.exec('DELETE FROM external_api_audit WHERE id <= (SELECT MAX(id) - 5000 FROM external_api_audit)')
    },
  }
}

export type ExternalApiStore = ReturnType<typeof makeExternalApiStore>
