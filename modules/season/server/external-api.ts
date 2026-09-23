import { Router } from 'express'
import { as } from '../../../server/db/schema'
import type {
  ExternalApiJsonObject,
  ExternalApiRouteContribution,
  ExternalApiSqlValue,
} from '../../../server/core/external-api-contributions'

const favoriteSelect = `
  item_id, title, title_zh, air_day, air_time, begin, bangumi_id, links,
  image, synopsis, synopsis_original, aired_episodes, total_episodes,
  air_status, media_type, lib_match_override, added_at
`

export const seasonExternalApiRoutes: ExternalApiRouteContribution = {
  moduleId: 'season',
  createRouter({ db, auth, input, errors }) {
    const router = Router()
    const { withRole } = auth
    const {
      assertKeys,
      assertQueryKeys,
      escapedLike,
      limitedString,
      listResponse,
      nullableBoundedInteger,
      pagination,
      plainBody,
      queryString,
    } = input
    const fail = (message: string, status: number, code: string): never => {
      throw errors.create(message, status, code)
    }
    const favoriteView = (row: any) => ({ ...row, links: input.parseJsonArray(row.links) })
    const readFavorite = (itemId: string): any | undefined => {
      const row = as<any | undefined>(db.prepare(`SELECT ${favoriteSelect} FROM season_favorites WHERE item_id = ?`).get(itemId) ?? undefined)
      return row ? favoriteView(row) : undefined
    }
    const validateFavoriteId = (value: unknown): string => limitedString(value, 'item_id', 200) as string
    const validateLinks = (value: unknown): Array<{ name: string; url: string }> | null => {
      if (value === null) return null
      if (!Array.isArray(value) || value.length > 50) {
        return fail('links must be an array with at most 50 items', 400, 'INVALID_FIELD')
      }
      return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return fail(`links[${index}] must be an object`, 400, 'INVALID_FIELD')
        }
        const link = entry as ExternalApiJsonObject
        assertKeys(link, ['name', 'url'])
        const name = limitedString(link.name, `links[${index}].name`, 100) as string
        const urlText = limitedString(link.url, `links[${index}].url`, 2000) as string
        let url: URL
        try { url = new URL(urlText) } catch { return fail('link URL is invalid', 400, 'INVALID_FIELD') }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return fail('link URL must use http or https', 400, 'INVALID_FIELD')
        }
        return { name, url: url.toString() }
      })
    }
    const favoriteFields = [
      'title', 'title_zh', 'air_day', 'air_time', 'begin', 'bangumi_id', 'links',
      'image', 'synopsis', 'synopsis_original', 'aired_episodes', 'total_episodes',
      'air_status', 'media_type', 'lib_match_override',
    ] as const
    const normalizedFavoriteFields = (body: ExternalApiJsonObject): Record<string, ExternalApiSqlValue> => {
      const out: Record<string, ExternalApiSqlValue> = {}
      for (const field of favoriteFields) {
        if (!(field in body)) continue
        switch (field) {
          case 'title': out[field] = limitedString(body[field], field, 500); break
          case 'title_zh':
          case 'air_day':
          case 'air_time':
          case 'begin':
          case 'bangumi_id': out[field] = limitedString(body[field], field, 500, { nullable: true, empty: true }); break
          case 'image': out[field] = limitedString(body[field], field, 2000, { nullable: true, empty: true }); break
          case 'synopsis':
          case 'synopsis_original': out[field] = limitedString(body[field], field, 10_000, { nullable: true, empty: true }); break
          case 'links': {
            const links = validateLinks(body.links)
            out.links = links === null || links.length === 0 ? null : JSON.stringify(links)
            break
          }
          case 'aired_episodes':
          case 'total_episodes': out[field] = nullableBoundedInteger(body[field], field, 0, 100_000); break
          case 'air_status': {
            const value = body.air_status
            if (value !== null && value !== 'airing' && value !== 'finished' && value !== 'upcoming') {
              return fail('air_status is invalid', 400, 'INVALID_FIELD')
            }
            out.air_status = value as 'airing' | 'finished' | 'upcoming' | null
            break
          }
          case 'media_type': {
            if (body.media_type !== 'anime' && body.media_type !== 'live') {
              return fail('media_type must be anime or live', 400, 'INVALID_FIELD')
            }
            out.media_type = body.media_type
            break
          }
          case 'lib_match_override': {
            if (body.lib_match_override !== null && body.lib_match_override !== 'present' && body.lib_match_override !== 'absent') {
              return fail('lib_match_override is invalid', 400, 'INVALID_FIELD')
            }
            out.lib_match_override = body.lib_match_override as 'present' | 'absent' | null
            break
          }
        }
      }
      return out
    }

    router.get('/favorites', withRole('read', (req, res) => {
      assertQueryKeys(req, ['page', 'pageSize', 'q', 'mediaType', 'airStatus'])
      const { page, pageSize, offset } = pagination(req)
      const clauses: string[] = []
      const params: ExternalApiSqlValue[] = []
      const q = queryString(req, 'q')
      const mediaType = queryString(req, 'mediaType')
      const airStatus = queryString(req, 'airStatus')
      if (q !== undefined) {
        if (q.length > 200) return fail('q is too long', 400, 'INVALID_QUERY_PARAMETER')
        const pattern = escapedLike(q.toLowerCase())
        clauses.push("(LOWER(item_id) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(title_zh, '')) LIKE ? ESCAPE '\\')")
        params.push(pattern, pattern, pattern)
      }
      if (mediaType !== undefined) {
        if (mediaType !== 'anime' && mediaType !== 'live') return fail('mediaType must be anime or live', 400, 'INVALID_QUERY_PARAMETER')
        clauses.push('media_type = ?')
        params.push(mediaType)
      }
      if (airStatus !== undefined) {
        if (!['airing', 'finished', 'upcoming'].includes(airStatus)) return fail('airStatus is invalid', 400, 'INVALID_QUERY_PARAMETER')
        clauses.push('air_status = ?')
        params.push(airStatus)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM season_favorites ${where}`).get(params) as { count: number }).count
      const rows = as<any[]>(db.prepare(`
        SELECT ${favoriteSelect} FROM season_favorites ${where}
        ORDER BY added_at DESC, item_id LIMIT ? OFFSET ?
      `).all([...params, pageSize, offset]))
      res.json(listResponse(rows.map(favoriteView), page, pageSize, total))
    }))

    router.get('/favorites/:id', withRole('read', (req, res) => {
      assertQueryKeys(req, [])
      const itemId = validateFavoriteId(req.params.id)
      const favorite = readFavorite(itemId)
      if (!favorite) return fail('Favorite not found', 404, 'FAVORITE_NOT_FOUND')
      res.json(favorite)
    }))

    router.post('/favorites', withRole('edit', (req, res) => {
      const body = plainBody(req)
      assertKeys(body, ['item_id', ...favoriteFields])
      const itemId = validateFavoriteId(body.item_id)
      if (readFavorite(itemId)) return fail('Favorite already exists', 409, 'FAVORITE_EXISTS')
      const values = normalizedFavoriteFields(body)
      if (!('title' in values)) return fail('title is required', 400, 'INVALID_FIELD')
      const mediaType = values.media_type ?? (itemId.startsWith('manual-tmdb-') ? 'live' : 'anime')
      db.prepare(`
        INSERT INTO season_favorites (
          item_id, title, title_zh, air_day, air_time, begin, bangumi_id, links,
          image, synopsis, synopsis_original, aired_episodes, total_episodes,
          air_status, media_type, lib_match_override
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run([
        itemId, values.title, values.title_zh ?? null, values.air_day ?? null,
        values.air_time ?? null, values.begin ?? null, values.bangumi_id ?? null,
        values.links ?? null, values.image ?? null, values.synopsis ?? null,
        values.synopsis_original ?? null, values.aired_episodes ?? null,
        values.total_episodes ?? null, values.air_status ?? null, mediaType,
        values.lib_match_override ?? null,
      ])
      res.status(201).json(readFavorite(itemId))
    }))

    router.patch('/favorites/:id', withRole('edit', (req, res) => {
      const itemId = validateFavoriteId(req.params.id)
      if (!readFavorite(itemId)) return fail('Favorite not found', 404, 'FAVORITE_NOT_FOUND')
      const body = plainBody(req)
      assertKeys(body, favoriteFields)
      const values = normalizedFavoriteFields(body)
      const entries = Object.entries(values)
      if (entries.length === 0) return fail('At least one favorite field is required', 400, 'EMPTY_PATCH')
      db.prepare(`UPDATE season_favorites SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE item_id = ?`)
        .run([...entries.map(([, value]) => value), itemId])
      res.json(readFavorite(itemId))
    }))

    router.delete('/favorites/:id', withRole('edit', (req, res) => {
      if (req.body !== undefined) assertKeys(plainBody(req), [])
      const itemId = validateFavoriteId(req.params.id)
      if (!readFavorite(itemId)) return fail('Favorite not found', 404, 'FAVORITE_NOT_FOUND')
      db.prepare('DELETE FROM season_favorites WHERE item_id = ?').run(itemId)
      res.json({ ok: true })
    }))

    return router
  },
}
