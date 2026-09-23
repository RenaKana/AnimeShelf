import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import type { Database } from 'node-sqlite3-wasm'
import type { ExternalApiRole, ExternalApiTokenInfo } from '../../../shared/external-api'
import type {
  ExternalApiCatalogSnapshot,
  ExternalApiRouteContribution,
  ExternalApiRouteFactoryContext,
  ExternalApiRouteHandler,
} from '../../../server/core/external-api-contributions'
import { as } from '../../../server/db/schema'
import { makeTagDb } from '../../../server/db/tags'
import {
  deleteFolderOnDisk,
  FolderOperationError,
  moveFolderToLibraryRoot,
  renameFolderOnDisk,
} from '../../../server/services/folder-operations'
import { getMediaCatalogForFolder } from '../../../server/core/extensions'
import { rebuildLibraryMediaCatalogInTransaction } from '../../../server/core/catalog-access'


type RequiredRole = Exclude<ExternalApiRole, 'disabled'>
type JsonObject = Record<string, unknown>
type SqlValue = boolean | number | bigint | string | Uint8Array | null

const roleRank: Record<RequiredRole, number> = { read: 1, edit: 2, files: 3 }
const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
const folderSelect = `
  id, library_id, parent_id, name, path, is_series, anilist_id, has_poster,
  source, rating, genres, synopsis, year, episodes, display_metadata_folder_id,
  pinned, renamed, created_at, updated_at
`

class ExternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ExternalApiError'
  }
}

function sendError(res: Response, status: number, error: string, code: string): Response {
  return res.status(status).json({ error, code })
}

function tokenFrom(res: Response): ExternalApiTokenInfo | undefined {
  const value = (res.locals as { externalApiToken?: unknown }).externalApiToken
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as ExternalApiTokenInfo
}

function authorize(res: Response, required: RequiredRole): boolean {
  const principal = tokenFrom(res)
  if (!principal) {
    sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED')
    return false
  }
  const role = principal.role
  const expiry = principal.expires_at == null ? null : Date.parse(principal.expires_at)
  const invalid = !principal.id || !principal.name || !principal.prefix
    || !(role === 'read' || role === 'edit' || role === 'files' || role === 'disabled')
    || (principal.expires_at != null && !Number.isFinite(expiry))
  if (invalid || role === 'disabled' || principal.revoked_at != null || (expiry != null && expiry <= Date.now())) {
    sendError(res, 403, 'Token is disabled', 'TOKEN_DISABLED')
    return false
  }
  if (roleRank[role] < roleRank[required]) {
    sendError(res, 403, 'Insufficient permission', 'INSUFFICIENT_PERMISSION')
    return false
  }
  return true
}

function trackAuditedOperation(handler: ExternalApiRouteHandler): RequestHandler {
  return (req, res, next) => {
    const operation = Promise.resolve().then(() => {
      if (res.destroyed) return
      return handler(req, res)
    })
    res.locals.externalApiTrackOperation?.(operation)
    operation.catch(next)
  }
}

function withRole(required: RequiredRole, handler: ExternalApiRouteHandler): RequestHandler {
  const tracked = trackAuditedOperation(handler)
  return (req, res, next) => {
    if (!authorize(res, required)) return
    tracked(req, res, next)
  }
}

function plainBody(req: Request): JsonObject {
  const value = req.body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalApiError('JSON object body required', 400, 'INVALID_BODY')
  }
  return value as JsonObject
}

function assertKeys(value: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new ExternalApiError(`Unknown field: ${unknown[0]}`, 400, 'UNKNOWN_FIELD')
  }
}

function assertQueryKeys(req: Request, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(req.query).filter(key => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new ExternalApiError(`Unknown query parameter: ${unknown[0]}`, 400, 'UNKNOWN_QUERY_PARAMETER')
  }
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ExternalApiError(`${key} must be a string`, 400, 'INVALID_QUERY_PARAMETER')
  return value
}

function positiveInteger(value: unknown, label: string, code = 'INVALID_ID'): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new ExternalApiError(`${label} must be a positive integer`, 400, code)
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ExternalApiError(`${label} must be an integer from ${min} to ${max}`, 400, 'INVALID_FIELD')
  }
  return value
}

function nullableBoundedInteger(value: unknown, label: string, min: number, max: number): number | null {
  return value === null ? null : boundedInteger(value, label, min, max)
}

function nullableNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ExternalApiError(`${label} must be a number from ${min} to ${max}`, 400, 'INVALID_FIELD')
  }
  return value
}

function limitedString(value: unknown, label: string, max: number, options: { nullable?: boolean; empty?: boolean } = {}): string | null {
  if (value === null && options.nullable) return null
  if (typeof value !== 'string') throw new ExternalApiError(`${label} must be a string`, 400, 'INVALID_FIELD')
  const normalized = value.trim()
  if (!options.empty && !normalized) throw new ExternalApiError(`${label} cannot be empty`, 400, 'INVALID_FIELD')
  if (normalized.length > max) throw new ExternalApiError(`${label} is too long`, 400, 'INVALID_FIELD')
  return normalized
}

function pagination(req: Request): { page: number; pageSize: number; offset: number } {
  const pageRaw = queryString(req, 'page')
  const sizeRaw = queryString(req, 'pageSize')
  const page = pageRaw === undefined ? 1 : positiveInteger(pageRaw, 'page', 'INVALID_PAGINATION')
  const pageSize = sizeRaw === undefined ? 50 : positiveInteger(sizeRaw, 'pageSize', 'INVALID_PAGINATION')
  if (pageSize > 200) throw new ExternalApiError('pageSize cannot exceed 200', 400, 'INVALID_PAGINATION')
  if (page > 1_000_000) throw new ExternalApiError('page is too large', 400, 'INVALID_PAGINATION')
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function listResponse<T>(data: T[], page: number, pageSize: number, total: number) {
  return { data, pagination: { page, pageSize, total } }
}

function escapedLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function folderView(row: any) {
  return { ...row, genres: parseJsonArray(row.genres) }
}

function readFolder(db: Database, id: number): any | undefined {
  const row = as<any | undefined>(db.prepare(`SELECT ${folderSelect} FROM folders WHERE id = ?`).get(id) ?? undefined)
  return row ? folderView(row) : undefined
}

function validateGenres(value: unknown): string[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > 30) {
    throw new ExternalApiError('genres must be an array with at most 30 items', 400, 'INVALID_FIELD')
  }
  return value.map((genre, index) => limitedString(genre, `genres[${index}]`, 80) as string)
}

function validateColor(value: unknown): string {
  const color = limitedString(value, 'color', 7) as string
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ExternalApiError('color must be a six-digit hex color', 400, 'INVALID_FIELD')
  return color.toLowerCase()
}

function catalogResponse(catalog: ExternalApiCatalogSnapshot) {
  return {
    media_catalog: catalog.entries,
    media_catalog_summary: catalog.summary,
    media_catalog_v2: catalog.canonical,
    media_catalog_candidates: catalog.candidates,
  }
}

function handleError(error: unknown, res: Response): Response {
  if (error instanceof ExternalApiError || error instanceof FolderOperationError || (error instanceof Error && error.name === 'MediaCatalogValidationError' && 'status' in error && 'code' in error)) {
    return sendError(res, Number(error.status), error.message, String(error.code))
  }
  const message = error instanceof Error ? error.message : ''
  if (/UNIQUE constraint failed/i.test(message)) return sendError(res, 409, 'Resource already exists', 'RESOURCE_CONFLICT')
  if (/FOREIGN KEY constraint failed|constraint failed/i.test(message)) return sendError(res, 409, 'Request conflicts with current data', 'DATA_CONFLICT')
  console.error('External data API operation failed:', error)
  return sendError(res, 500, 'External API operation failed', 'EXTERNAL_API_FAILED')
}

function externalErrorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction): Response {
  return handleError(error, res)
}

export function createExternalDataRouter(db: Database, options: { invalidateLibraryMatches?: () => void; isModuleActive?: (id: string) => boolean; contributions?: readonly ExternalApiRouteContribution[] } = {}): Router {
  const router = Router()
  const active = options.isModuleActive ?? (() => true)
  const contributions = options.contributions ?? []
  const contributedModules = new Set(contributions.map(contribution => contribution.moduleId))
  router.use((req, res, next) => {
    const feature = /^\/favorites(?:\/|$)/.test(req.path) ? 'season' : /\/(?:media-catalog|media-work-groups)/.test(req.path) ? 'media-catalog' : null
    if (feature && !contributedModules.has(feature)) return res.status(404).json({ error: 'Module unavailable', code: 'MODULE_UNAVAILABLE' })
    if (req.method === 'PATCH' && /^\/folders\/[^/]+$/.test(req.path) && !active('metadata') && Object.keys(req.body ?? {}).some(key => key !== 'name')) return res.status(404).json({error: 'Metadata module unavailable', code: 'MODULE_UNAVAILABLE'})
    next()
  })

  const tagDb = makeTagDb(db)
  // The caller owns this DB. Do not import the application's singleton DB just
  // to invalidate its cache (isolated integrations/tests must stay isolated).
  const invalidateLibHitCache = options.invalidateLibraryMatches ?? (() => {})
  const contributionContext: ExternalApiRouteFactoryContext = {
    db,
    auth: { withRole },
    audit: { track: trackAuditedOperation },
    input: {
      plainBody,
      assertKeys,
      assertQueryKeys,
      queryString,
      positiveInteger,
      boundedInteger,
      nullableBoundedInteger,
      nullableNumber,
      limitedString,
      pagination,
      listResponse,
      escapedLike,
      parseJsonArray,
    },
    errors: {
      create: (message, status, code) => new ExternalApiError(message, status, code),
      send: sendError,
      handle: handleError,
    },
    responses: { catalog: catalogResponse },
    cache: { invalidateLibraryMatches: invalidateLibHitCache },
  }

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!allowedMethods.has(req.method)) {
      if (!authorize(res, 'read')) return
      sendError(res, 404, 'Route not found', 'ROUTE_NOT_FOUND')
      return
    }
    if (req.method !== 'GET') assertQueryKeys(req, [])
    next()
  })

  router.get('/me', withRole('read', (req, res) => {
    assertQueryKeys(req, [])
    const principal = tokenFrom(res)!
    res.json({
      id: principal.id,
      name: principal.name,
      prefix: principal.prefix,
      role: principal.role,
      created_at: principal.created_at,
      expires_at: principal.expires_at,
      last_used_at: principal.last_used_at,
    })
  }))

  router.get('/libraries', withRole('read', (req, res) => {
    assertQueryKeys(req, ['page', 'pageSize'])
    const { page, pageSize, offset } = pagination(req)
    const total = (db.prepare('SELECT COUNT(*) AS count FROM libraries').get() as { count: number }).count
    const data = as<any[]>(db.prepare(`
      SELECT id, name, root_path, type, created_at
      FROM libraries ORDER BY name, id LIMIT ? OFFSET ?
    `).all([pageSize, offset]))
    res.json(listResponse(data, page, pageSize, total))
  }))

  router.get('/folders', withRole('read', (req, res) => {
    assertQueryKeys(req, ['page', 'pageSize', 'libraryId', 'parentId', 'isSeries', 'q'])
    const { page, pageSize, offset } = pagination(req)
    const clauses: string[] = []
    const params: SqlValue[] = []
    const libraryId = queryString(req, 'libraryId')
    const parentId = queryString(req, 'parentId')
    const isSeries = queryString(req, 'isSeries')
    const q = queryString(req, 'q')
    if (libraryId !== undefined) {
      clauses.push('library_id = ?')
      params.push(positiveInteger(libraryId, 'libraryId', 'INVALID_LIBRARY_ID'))
    }
    if (parentId !== undefined) {
      clauses.push('parent_id = ?')
      params.push(positiveInteger(parentId, 'parentId', 'INVALID_FOLDER_ID'))
    }
    if (isSeries !== undefined) {
      if (!['0', '1', 'false', 'true'].includes(isSeries)) throw new ExternalApiError('isSeries must be true or false', 400, 'INVALID_QUERY_PARAMETER')
      clauses.push('is_series = ?')
      params.push(isSeries === '1' || isSeries === 'true' ? 1 : 0)
    }
    if (q !== undefined) {
      if (q.length > 200) throw new ExternalApiError('q is too long', 400, 'INVALID_QUERY_PARAMETER')
      const pattern = escapedLike(q.toLowerCase())
      clauses.push("(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(path) LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM folders ${where}`).get(params) as { count: number }).count
    const rows = as<any[]>(db.prepare(`
      SELECT ${folderSelect} FROM folders ${where}
      ORDER BY path, id LIMIT ? OFFSET ?
    `).all([...params, pageSize, offset]))
    const data = rows.map(folderView)
    res.json(listResponse(data, page, pageSize, total))
  }))

  router.get('/folders/:id', withRole('read', (req, res) => {
    assertQueryKeys(req, [])
    const id = positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID')
    const folder = readFolder(db, id)
    if (!folder) throw new ExternalApiError('Folder not found', 404, 'FOLDER_NOT_FOUND')
    const children = as<any[]>(db.prepare(`
      SELECT ${folderSelect} FROM folders WHERE parent_id = ? ORDER BY name, id
    `).all(id)).map(folderView)
    const files = as<any[]>(db.prepare(`
      SELECT id, folder_id, library_id, name, path, size, date_modified, ext, created_at, updated_at
      FROM files WHERE folder_id = ? ORDER BY name, id
    `).all(id))
    const catalog = getMediaCatalogForFolder(db, id)
    res.json({
      ...folder,
      tags: tagDb.effectiveTags('folder', id),
      children,
      files,
      ...catalogResponse(catalog),
    })
  }))

  router.get('/files/:id', withRole('read', (req, res) => {
    assertQueryKeys(req, [])
    const id = positiveInteger(req.params.id, 'file id', 'INVALID_FILE_ID')
    const file = as<any | undefined>(db.prepare(`
      SELECT f.id, f.folder_id, f.library_id, f.name, f.path, f.size, f.date_modified,
             f.ext, f.created_at, f.updated_at, folders.name AS folder_name,
             libraries.name AS library_name
      FROM files f
      JOIN folders ON folders.id = f.folder_id
      JOIN libraries ON libraries.id = f.library_id
      WHERE f.id = ?
    `).get(id) ?? undefined)
    if (!file) throw new ExternalApiError('File not found', 404, 'FILE_NOT_FOUND')
    res.json({ ...file, tags: tagDb.effectiveTags('file', id) })
  }))

  router.get('/tags', withRole('read', (req, res) => {
    assertQueryKeys(req, ['page', 'pageSize', 'q', 'kind'])
    const { page, pageSize, offset } = pagination(req)
    const clauses: string[] = []
    const params: SqlValue[] = []
    const q = queryString(req, 'q')
    const kind = queryString(req, 'kind')
    if (q !== undefined) {
      if (q.length > 100) throw new ExternalApiError('q is too long', 400, 'INVALID_QUERY_PARAMETER')
      clauses.push("LOWER(name) LIKE ? ESCAPE '\\'")
      params.push(escapedLike(q.toLowerCase()))
    }
    if (kind !== undefined) {
      if (kind !== 'custom' && kind !== 'system') throw new ExternalApiError('kind must be custom or system', 400, 'INVALID_QUERY_PARAMETER')
      clauses.push('kind = ?')
      params.push(kind)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM tags ${where}`).get(params) as { count: number }).count
    const data = as<any[]>(db.prepare(`
      SELECT t.id, t.name, t.color, t.kind,
             (SELECT COUNT(*) FROM tag_links l WHERE l.tag_id = t.id) AS link_count
      FROM tags t ${where} ORDER BY t.kind DESC, t.name, t.id LIMIT ? OFFSET ?
    `).all([...params, pageSize, offset]))
    res.json(listResponse(data, page, pageSize, total))
  }))

  router.patch('/folders/:id', withRole('edit', (req, res) => {
    const id = positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID')
    const current = readFolder(db, id)
    if (!current) throw new ExternalApiError('Folder not found', 404, 'FOLDER_NOT_FOUND')
    const body = plainBody(req)
    const fields = ['name', 'source', 'anilist_id', 'rating', 'genres', 'synopsis', 'year', 'episodes'] as const
    assertKeys(body, fields)
    const assignments: string[] = []
    const values: SqlValue[] = []
    let catalogAffected = false
    for (const field of fields) {
      if (!(field in body)) continue
      switch (field) {
        case 'name': {
          const name = limitedString(body.name, 'name', 255) as string
          if (/[\u0000-\u001f]/.test(name)) throw new ExternalApiError('name contains control characters', 400, 'INVALID_FIELD')
          assignments.push('name = ?', 'renamed = 1')
          values.push(name)
          catalogAffected = true
          break
        }
        case 'source': {
          const source = limitedString(body.source, 'source', 32, { empty: true }) as string
          if (!/^[a-z0-9_-]*$/i.test(source)) throw new ExternalApiError('source is invalid', 400, 'INVALID_FIELD')
          assignments.push('source = ?')
          values.push(source)
          catalogAffected = true
          break
        }
        case 'anilist_id':
          assignments.push('anilist_id = ?')
          values.push(body.anilist_id === null ? null : positiveInteger(body.anilist_id, 'anilist_id', 'INVALID_FIELD'))
          catalogAffected = true
          break
        case 'rating':
          assignments.push('rating = ?')
          values.push(nullableNumber(body.rating, 'rating', 0, 10))
          break
        case 'genres': {
          const genres = validateGenres(body.genres)
          assignments.push('genres = ?')
          values.push(genres === null || genres.length === 0 ? null : JSON.stringify(genres))
          break
        }
        case 'synopsis':
          assignments.push('synopsis = ?')
          values.push(limitedString(body.synopsis, 'synopsis', 10_000, { nullable: true, empty: true }))
          break
        case 'year':
          assignments.push('year = ?')
          values.push(nullableBoundedInteger(body.year, 'year', 1800, 3000))
          break
        case 'episodes':
          assignments.push('episodes = ?')
          values.push(nullableBoundedInteger(body.episodes, 'episodes', 0, 100_000))
          break
      }
    }
    if (assignments.length === 0) throw new ExternalApiError('At least one metadata field is required', 400, 'EMPTY_PATCH')
    assignments.push("updated_at = datetime('now')")
    if (catalogAffected) db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE folders SET ${assignments.join(', ')} WHERE id = ?`).run([...values, id])
      if (catalogAffected) {
        rebuildLibraryMediaCatalogInTransaction(db, current.library_id)
        db.exec('COMMIT')
      }
    } catch (error) {
      if (catalogAffected) {
        try { db.exec('ROLLBACK') } catch { /* preserve original error */ }
      }
      throw error
    }
    invalidateLibHitCache()
    res.json({ ...readFolder(db, id), tags: tagDb.effectiveTags('folder', id) })
  }))

  router.post('/tags', withRole('edit', (req, res) => {
    const body = plainBody(req)
    assertKeys(body, ['name', 'color'])
    const name = limitedString(body.name, 'name', 100) as string
    const color = body.color === undefined ? '#8b5cf6' : validateColor(body.color)
    const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
    if (existing) throw new ExternalApiError('Tag already exists', 409, 'TAG_EXISTS')
    res.status(201).json(tagDb.create(name, color))
  }))

  router.patch('/tags/:id', withRole('edit', (req, res) => {
    const id = positiveInteger(req.params.id, 'tag id', 'INVALID_TAG_ID')
    const current = as<any | undefined>(db.prepare('SELECT id, name, color, kind FROM tags WHERE id = ?').get(id) ?? undefined)
    if (!current) throw new ExternalApiError('Tag not found', 404, 'TAG_NOT_FOUND')
    const body = plainBody(req)
    assertKeys(body, ['name', 'color'])
    if (!('name' in body) && !('color' in body)) throw new ExternalApiError('At least one tag field is required', 400, 'EMPTY_PATCH')
    const name = 'name' in body ? limitedString(body.name, 'name', 100) as string : undefined
    const color = 'color' in body ? validateColor(body.color) : undefined
    if (name && name !== current.name && db.prepare('SELECT id FROM tags WHERE name = ?').get(name)) {
      throw new ExternalApiError('Tag already exists', 409, 'TAG_EXISTS')
    }
    try {
      res.json(tagDb.update(id, { name, color }))
    } catch (error) {
      if (error instanceof Error && /system tag name is read-only/i.test(error.message)) {
        throw new ExternalApiError(error.message, 409, 'SYSTEM_TAG_PROTECTED')
      }
      throw error
    }
  }))

  router.delete('/tags/:id', withRole('edit', (req, res) => {
    if (req.body !== undefined) assertKeys(plainBody(req), [])
    const id = positiveInteger(req.params.id, 'tag id', 'INVALID_TAG_ID')
    const current = as<any | undefined>(db.prepare('SELECT id, kind FROM tags WHERE id = ?').get(id) ?? undefined)
    if (!current) throw new ExternalApiError('Tag not found', 404, 'TAG_NOT_FOUND')
    if (current.kind === 'system') throw new ExternalApiError('System tags cannot be deleted', 409, 'SYSTEM_TAG_PROTECTED')
    tagDb.delete(id)
    res.json({ ok: true })
  }))

  function tagLinkBody(req: Request): { targetType: 'folder' | 'file'; targetId: number } {
    const body = plainBody(req)
    assertKeys(body, ['target_type', 'target_id'])
    if (body.target_type !== 'folder' && body.target_type !== 'file') {
      throw new ExternalApiError('target_type must be folder or file', 400, 'INVALID_TAG_TARGET')
    }
    const targetId = positiveInteger(body.target_id, 'target_id', 'INVALID_TAG_TARGET')
    return { targetType: body.target_type, targetId }
  }

  router.post('/tags/:id/links', withRole('edit', (req, res) => {
    const tagId = positiveInteger(req.params.id, 'tag id', 'INVALID_TAG_ID')
    if (!db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)) throw new ExternalApiError('Tag not found', 404, 'TAG_NOT_FOUND')
    const { targetType, targetId } = tagLinkBody(req)
    const table = targetType === 'folder' ? 'folders' : 'files'
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(targetId)) {
      throw new ExternalApiError('Tag target not found', 404, 'TAG_TARGET_NOT_FOUND')
    }
    tagDb.link(tagId, targetType, targetId)
    res.json({ ok: true })
  }))

  router.delete('/tags/:id/links', withRole('edit', (req, res) => {
    const tagId = positiveInteger(req.params.id, 'tag id', 'INVALID_TAG_ID')
    if (!db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)) throw new ExternalApiError('Tag not found', 404, 'TAG_NOT_FOUND')
    const { targetType, targetId } = tagLinkBody(req)
    tagDb.unlinkByTarget(tagId, targetType, targetId)
    res.json({ ok: true })
  }))

  router.put('/folders/:id/rename', withRole('files', async (req, res) => {
    const body = plainBody(req)
    assertKeys(body, ['name', 'expectedPath'])
    const result = await renameFolderOnDisk(db, positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'), {
      name: limitedString(body.name, 'name', 255) as string,
      expectedPath: limitedString(body.expectedPath, 'expectedPath', 32_768) as string,
    })
    invalidateLibHitCache()
    res.json(result)
  }))

  router.put('/folders/:id/move', withRole('files', async (req, res) => {
    const body = plainBody(req)
    assertKeys(body, ['targetLibraryId', 'expectedPath'])
    const result = await moveFolderToLibraryRoot(db, positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'), {
      targetLibraryId: positiveInteger(body.targetLibraryId, 'targetLibraryId', 'INVALID_LIBRARY_ID'),
      expectedPath: limitedString(body.expectedPath, 'expectedPath', 32_768) as string,
    })
    invalidateLibHitCache()
    res.json(result)
  }))

  router.delete('/folders/:id', withRole('files', async (req, res) => {
    const body = plainBody(req)
    assertKeys(body, ['expectedPath', 'confirm'])
    if (body.confirm !== true) throw new ExternalApiError('confirm must be true', 400, 'DELETE_CONFIRMATION_REQUIRED')
    const result = await deleteFolderOnDisk(db, positiveInteger(req.params.id, 'folder id', 'INVALID_FOLDER_ID'), {
      expectedPath: limitedString(body.expectedPath, 'expectedPath', 32_768) as string,
    })
    invalidateLibHitCache()
    res.json(result)
  }))

  for (const contribution of contributions) router.use(contribution.createRouter(contributionContext))

  router.use((req, res) => {
    if (!authorize(res, 'read')) return
    sendError(res, 404, 'Route not found', 'ROUTE_NOT_FOUND')
  })
  router.use(externalErrorMiddleware)

  return router
}

export default createExternalDataRouter
