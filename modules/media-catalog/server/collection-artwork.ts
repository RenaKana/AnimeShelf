import type { Database } from 'node-sqlite3-wasm'
import type { Folder } from '../../../server/types'
import { as } from '../../../server/db/schema'
import { presentFolders } from '../../../server/services/folder-presentation'

/** Read poster versions for every displayed work, not just first-level folders. */
export function getCollectionArtwork(db: Database, rootFolderId: number, posterDir: string): Array<{ id: number; poster_version: string | null }> {
  const folders = as<Folder[]>(db.prepare(`
    WITH RECURSIVE scope(id) AS (
      SELECT id FROM folders WHERE id = ? AND pinned = 1
      UNION ALL
      SELECT f.id FROM folders f JOIN scope s ON f.parent_id = s.id WHERE f.pinned != 1
    )
    SELECT f.* FROM folders f JOIN scope s ON s.id = f.id
    WHERE EXISTS (SELECT 1 FROM folder_media_mappings m WHERE m.root_folder_id = ? AND m.folder_id = f.id)
       OR EXISTS (SELECT 1 FROM media_work_groups g WHERE g.root_folder_id = ? AND g.anchor_folder_id = f.id)
    ORDER BY f.id
  `).all([rootFolderId, rootFolderId, rootFolderId]))
  return presentFolders(db, folders, posterDir).map(folder => ({ id: folder.id, poster_version: folder.poster_version }))
}
