import type { Database } from 'node-sqlite3-wasm'
import { VIDEO_EXTS } from '../../../server/services/everything'
import { sqlAll } from '../../../server/db/sql'

interface OwnedSeasonRow {
  root_id: number
  season_number: number
}

/**
 * Reads owned seasons from canonical physical mappings in one query. A season
 * counts only when its mapped folder and direct main video are currently
 * present inside the requested folder's real descendant tree.
 */
export function getOwnedSeasons(db: Database, folderIds: number[]): Map<number, number[]> {
  const ids = [...new Set(folderIds.filter(id => Number.isSafeInteger(id) && id > 0))]
  const result = new Map(ids.map(id => [id, [] as number[]]))
  if (ids.length === 0) return result

  const idList = ids.join(',')
  const videoExtList = VIDEO_EXTS.map(ext => `'${ext.replace(/'/g, "''")}'`).join(',')
  const rows = sqlAll<OwnedSeasonRow>(db, `
    WITH RECURSIVE requested_subtree(root_id, id) AS (
      SELECT id, id
      FROM folders
      WHERE id IN (${idList}) AND path_missing = 0
      UNION ALL
      SELECT subtree.root_id, child.id
      FROM folders child
      JOIN requested_subtree subtree ON child.parent_id = subtree.id
      WHERE child.path_missing = 0
    )
    SELECT subtree.root_id, mapping.season_number
    FROM requested_subtree subtree
    JOIN folder_media_mappings mapping ON mapping.folder_id = subtree.id
    WHERE mapping.content_role = 'main'
      AND mapping.kind = 'season'
      AND mapping.season_number IS NOT NULL
      AND mapping.season_number > 0
      AND EXISTS (
        SELECT 1
        FROM files file
        WHERE file.folder_id = mapping.folder_id
          AND file.path_missing = 0
          AND lower(ltrim(file.ext, '.')) IN (${videoExtList})
      )
    GROUP BY subtree.root_id, mapping.season_number
    ORDER BY subtree.root_id, mapping.season_number
  `)

  for (const row of rows) {
    if (!Number.isSafeInteger(row.season_number) || row.season_number <= 0) continue
    result.get(row.root_id)?.push(row.season_number)
  }
  return result
}
