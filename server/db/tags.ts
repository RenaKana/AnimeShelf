import type { Database } from 'node-sqlite3-wasm'
import { as } from './schema'
import type { Tag, TagLink } from '../types'

export function makeTagDb(db: Database) {
  const get = (id: number) => as<Tag | undefined>(db.prepare('SELECT * FROM tags WHERE id = ?').get(id) ?? undefined)
  return {
    list(): Tag[] {
      return as<Tag[]>(db.prepare('SELECT * FROM tags ORDER BY kind DESC, name').all())
    },
    create(name: string, color = '#8b5cf6'): Tag {
      const r = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run([name, color])
      return as<Tag>(db.prepare('SELECT * FROM tags WHERE id = ?').get(r.lastInsertRowid))
    },
    update(id: number, patch: { name?: string; color?: string }): Tag {
      const cur = get(id)
      if (!cur) throw new Error('tag not found')
      if (cur.kind === 'system' && patch.name && patch.name !== cur.name) throw new Error('system tag name is read-only')
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?')
        .run([patch.name ?? cur.name, patch.color ?? cur.color, id])
      return get(id)!
    },
    delete(id: number): void {
      const cur = get(id)
      if (!cur) throw new Error('tag not found')
      if (cur.kind === 'system') throw new Error('cannot delete system tag')
      db.prepare('DELETE FROM tags WHERE id = ?').run(id)
    },
    link(tagId: number, targetType: 'folder' | 'file', targetId: number): void {
      db.prepare('INSERT OR IGNORE INTO tag_links (tag_id, target_type, target_id) VALUES (?, ?, ?)')
        .run([tagId, targetType, targetId])
    },
    unlink(linkId: number): void {
      db.prepare('DELETE FROM tag_links WHERE id = ?').run(linkId)
    },
    unlinkByTarget(tagId: number, targetType: 'folder' | 'file', targetId: number): void {
      db.prepare('DELETE FROM tag_links WHERE tag_id = ? AND target_type = ? AND target_id = ?').run([tagId, targetType, targetId])
    },
    linksForTarget(targetType: 'folder' | 'file', targetId: number): TagLink[] {
      return as<TagLink[]>(db.prepare('SELECT * FROM tag_links WHERE target_type = ? AND target_id = ?').all([targetType, targetId]))
    },
    tagsForTarget(targetType: 'folder' | 'file', targetId: number): Tag[] {
      return as<Tag[]>(db.prepare(`
        SELECT t.* FROM tags t JOIN tag_links l ON l.tag_id = t.id
        WHERE l.target_type = ? AND l.target_id = ? ORDER BY t.name
      `).all([targetType, targetId]))
    },
    targetsForTag(tagId: number): { target_type: 'folder' | 'file'; target_id: number }[] {
      return as<{ target_type: 'folder' | 'file'; target_id: number }[]>(
        db.prepare('SELECT target_type, target_id FROM tag_links WHERE tag_id = ?').all(tagId))
    },
    // folder：自身 + 祖先链的 folder 标签；file：自身 + 父目录链的 folder 标签
    effectiveTags(targetType: 'folder' | 'file', targetId: number): Tag[] {
      const sql = targetType === 'folder' ? `
        WITH RECURSIVE chain(id) AS (
          SELECT id FROM folders WHERE id = ?
          UNION ALL
          SELECT f.parent_id FROM folders f JOIN chain c ON f.id = c.id WHERE f.parent_id IS NOT NULL
        )
        SELECT DISTINCT t.* FROM tags t JOIN tag_links l ON l.tag_id = t.id
        WHERE l.target_type = 'folder' AND l.target_id IN (SELECT id FROM chain)
      ` : `
        WITH RECURSIVE chain(id) AS (
          SELECT folder_id FROM files WHERE id = ?
          UNION ALL
          SELECT f.parent_id FROM folders f JOIN chain c ON f.id = c.id WHERE f.parent_id IS NOT NULL
        )
        SELECT DISTINCT t.* FROM tags t JOIN tag_links l ON l.tag_id = t.id
        WHERE (l.target_type = 'file' AND l.target_id = ?)
           OR (l.target_type = 'folder' AND l.target_id IN (SELECT id FROM chain))
      `
      return as<Tag[]>(db.prepare(sql).all(targetType === 'folder' ? [targetId] : [targetId, targetId]))
    },
  }
}
