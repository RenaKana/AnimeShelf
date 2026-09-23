import type { Database } from 'node-sqlite3-wasm'
import { as } from './schema'
import { sqlAll, sqlGet, sqlRun } from './sql'
import type { Library } from '../types'
import { normalizeMediaDomain, type MediaDomain } from '../../shared/media-domain'

export type EditableLibraryType = Exclude<MediaDomain, 'unknown'>

/**
 * Library.type has a few legacy spellings in existing databases.  Keep those
 * readable through shared/media-domain, but only write the two stable values
 * used by the edit form when a caller explicitly changes the type.
 */
export function canonicalLibraryType(value: unknown): EditableLibraryType | null {
  const domain = normalizeMediaDomain(value)
  return domain === 'anime' || domain === 'live_action' ? domain : null
}

export interface LibraryUpdate {
  name?: string
  type?: unknown
}

export function makeLibraryDb(db: Database) {
  return {
    getAll(): Library[] {
      return as<Library[]>(sqlAll(db, 'SELECT * FROM libraries ORDER BY name'))
    },
    getById(id: number): Library | undefined {
      return as<Library | undefined>(sqlGet<Library>(db, 'SELECT * FROM libraries WHERE id = ?', id) ?? undefined)
    },
    create(name: string, rootPath: string, type: string, everythingUrl: string | null = null): Library {
      const r = sqlRun(db, 'INSERT INTO libraries (name, root_path, type, everything_url) VALUES (?, ?, ?, ?)', [name, rootPath, type, everythingUrl])
      return as<Library>(sqlGet<Library>(db, 'SELECT * FROM libraries WHERE id = ?', r.lastInsertRowid))
    },
    update(id: number, patch: LibraryUpdate): Library | undefined {
      const hasName = Object.prototype.hasOwnProperty.call(patch, 'name')
      const hasType = Object.prototype.hasOwnProperty.call(patch, 'type')
      if (!hasName && !hasType) throw new Error('至少需要修改媒体库名称或类型')

      const current = as<Library | undefined>(sqlGet<Library>(db, 'SELECT * FROM libraries WHERE id = ?', id) ?? undefined)
      if (!current) return undefined

      let name = current.name
      if (hasName) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('媒体库名称不能为空')
        name = patch.name.trim()
      }

      let type = current.type
      if (hasType) {
        const canonical = canonicalLibraryType(patch.type)
        if (!canonical) throw new Error('媒体库类型必须是 anime 或 live_action')
        type = canonical
      }

      const fields: string[] = []
      const values: unknown[] = []
      if (hasName) { fields.push('name = ?'); values.push(name) }
      if (hasType) { fields.push('type = ?'); values.push(type) }
      values.push(id)
      sqlRun(db, `UPDATE libraries SET ${fields.join(', ')} WHERE id = ?`, values)
      return as<Library | undefined>(sqlGet<Library>(db, 'SELECT * FROM libraries WHERE id = ?', id) ?? undefined)
    },
    rename(id: number, name: string): Library | undefined {
      return this.update(id, { name })
    },
    delete(id: number): void {
      sqlRun(db, 'DELETE FROM libraries WHERE id = ?', id)
    },
  }
}
