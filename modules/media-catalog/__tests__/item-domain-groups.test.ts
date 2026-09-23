import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../../../server/db/schema'
import { makeLibraryDb } from '../../../server/db/libraries'
import { makeFolderDb } from '../../../server/db/folders'
import { makeFileDb } from '../../../server/db/files'
import { sqlAll, sqlRun } from '../../../server/db/sql'
import { candidateDomainEvidence } from '../../../shared/media-domain'
import { getMediaCatalogForFolder, rebuildLibraryMediaCatalog } from '../server/media-catalog'
import { setDisplayMetadataFolder } from '../../../server/services/folder-presentation'

describe('item domains in catalog projections', () => {
  let db: ReturnType<typeof createDb>
  let libraryId: number
  let rootId: number
  let animationId: number
  let liveId: number
  beforeEach(() => {
    db = createDb(':memory:')
    libraryId = makeLibraryDb(db).create('Mixed', 'D:\\Catalog', 'anime').id
    const folders = makeFolderDb(db)
    folders.upsertTree(libraryId, ['D:\\Catalog', 'D:\\Catalog\\Show', 'D:\\Catalog\\Show\\Animation', 'D:\\Catalog\\Show\\Live'])
    const rows = folders.getByLibrary(libraryId)
    rootId = rows.find(row => row.name === 'Show')!.id
    animationId = rows.find(row => row.name === 'Animation')!.id
    liveId = rows.find(row => row.name === 'Live')!.id
    sqlRun(db, 'UPDATE folders SET is_series=1 WHERE id=?', rootId)
    for (const [id, type] of [[animationId, 2], [liveId, 6]]) {
      folders.updateAnilist(id, { source: 'bangumi', anilistId: id, hasPoster: false, domainEvidence: candidateDomainEvidence('bangumi', { bgmId: id, type }) })
      const folder = folders.getById(id)!
      makeFileDb(db).upsertMany(libraryId, [{ folder_id: id, path: `${folder.path}\\S01E01.mkv`, name: 'S01E01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    }
    rebuildLibraryMediaCatalog(db, libraryId)
  })
  afterEach(() => db.close())

  it('splits opposite identified adaptations while sharing the folder resolver', () => {
    const snapshot = getMediaCatalogForFolder(db, rootId)
    expect(snapshot.canonical!.work_groups).toHaveLength(2)
    expect(snapshot.canonical!.work_groups.map(group => group.media_domain).sort()).toEqual(['anime', 'live_action'])
    expect(snapshot.entries.find(entry => entry.folder_id === liveId)?.media_domain).toBe('live_action')
    expect(snapshot.canonical!.mappings.find(entry => entry.folder_id === animationId)?.media_domain).toBe('anime')
    setDisplayMetadataFolder(db, rootId, liveId)
    expect(getMediaCatalogForFolder(db, rootId).summary?.media_domain).toBe('live_action')
    sqlRun(db, "UPDATE folders SET media_domain_override='unknown' WHERE id=?", rootId)
    expect(getMediaCatalogForFolder(db, rootId).summary).toMatchObject({ media_domain: 'unknown', media_domain_source: 'manual' })
  })

  it('keeps a manual relationship across a classification change and rebuild', () => {
    const before = getMediaCatalogForFolder(db, rootId).canonical!
    const group = before.work_groups[0]
    sqlRun(db, 'UPDATE media_work_group_members SET work_group_id=?, manual_locked=1 WHERE media_item_id IN (?,?)', [group.id, before.items[0].id, before.items[1].id])
    sqlRun(db, 'UPDATE media_work_groups SET manual_locked=1 WHERE id=?', group.id)
    sqlRun(db, "UPDATE folders SET media_domain_override='anime' WHERE id=?", liveId)
    rebuildLibraryMediaCatalog(db, libraryId)
    expect(getMediaCatalogForFolder(db, rootId).canonical!.work_groups.find(row => row.id === group.id)?.item_ids.sort()).toEqual(before.items.map(row => row.id).sort())
    expect(sqlAll(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(sqlAll(db, 'PRAGMA foreign_key_check')).toEqual([])
  })
})
