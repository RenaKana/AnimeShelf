import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDb } from '../../../server/db/schema'
import { makeFolderDb } from '../../../server/db/folders'
import { makeLibraryDb } from '../../../server/db/libraries'
import { makeFileDb } from '../../../server/db/files'
import { sqlGet, sqlRun } from '../../../server/db/sql'
import { appendNewCollectionMembers, collectionMemberKeys, getCollectionOrganization, rekeyCollectionMember, saveCollectionOrganization } from '../../../server/core/collection-organization'
import { collectionMemberKey, nextCollectionEntry, resolveCollectionOrganization, validateCollectionOrganization, type CollectionOrganization } from '../../../shared/collection-organization'
import { rebuildLibraryMediaCatalog, setManualMediaCatalog } from '../server/media-catalog'

describe('independent collection organization', () => {
  let db: ReturnType<typeof createDb>, directory: string, rootId: number, libraryId: number
  let folderIds: number[]
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'collection-organization-'))
    db = createDb(path.join(directory, 'test.db'))
    libraryId = makeLibraryDb(db).create('Anime', 'D:\\Anime', 'anime').id
    const folders = makeFolderDb(db)
    folders.upsertTree(libraryId, ['D:\\Anime', 'D:\\Anime\\Collection', ...['A','B','C'].map(name => `D:\\Anime\\Collection\\${name}`)])
    const rows = folders.getByLibrary(libraryId)
    rootId = rows.find(row => row.name === 'Collection')!.id
    sqlRun(db, 'UPDATE folders SET pinned=1 WHERE id=?', rootId)
    folderIds = ['A','B','C'].map(name => rows.find(row => row.name === name)!.id)
    for (const [index, id] of folderIds.entries()) {
      sqlRun(db, "UPDATE folders SET source='anilist', anilist_id=? WHERE id=?", [9101 + index, id])
      const folder = rows.find(row => row.id === id)!
      makeFileDb(db).upsertMany(libraryId, [{ path: `${folder.path}\\episode.mkv`, folder_id: id, name: 'episode.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    }
    rebuildLibraryMediaCatalog(db, libraryId)
  })
  afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const saved = (): CollectionOrganization => {
    const organization = getCollectionOrganization(db, rootId).organization
    organization.orderSource = 'user'
    const [a,b,c] = organization.watchEntries.map(entry => entry.targetKey)
    organization.groups = [{ id:'x',title:'X',memberKeys:[a,c] }, { id:'y',title:'Y',memberKeys:[b,c] }]
    return saveCollectionOrganization(db, rootId, organization, 0).organization
  }
  it('reads an old collection without writing a migration or inventing recommended order', () => {
    const before = sqlGet(db, 'SELECT COUNT(*) AS count FROM media_collection_organization')
    const result = getCollectionOrganization(db, rootId)
    expect(result.revision).toBe(0)
    expect(result.organization.orderSource).toBe('existing')
    expect(result.organization.groups).toEqual([])
    expect(result.organization.watchEntries.map(entry => entry.targetKey)).toEqual(['item:anilist:9101','item:anilist:9102','item:anilist:9103'])
    expect(sqlGet(db, 'SELECT COUNT(*) AS count FROM media_collection_organization')).toEqual(before)
  })
  it('preserves an existing custom list order when first resolving the flat sequence', () => {
    const group = sqlGet<{ group_key:string }>(db, `SELECT g.group_key FROM media_work_groups g JOIN media_work_group_members m ON m.work_group_id=g.id
      JOIN media_items i ON i.id=m.media_item_id WHERE i.item_key='anilist:9103'`)!
    sqlRun(db, 'INSERT INTO media_collection_presentation(root_folder_id,entry_key,position) VALUES (?,?,0)', [rootId,`group:${group.group_key}`])
    expect(getCollectionOrganization(db, rootId).organization.watchEntries[0].targetKey).toBe('item:anilist:9103')
  })
  it('uses A→B→C across X={A,C} and Y={B,C}, independent of every group edit', () => {
    const organization = saved(), order = structuredClone(organization.watchEntries)
    expect(nextCollectionEntry(organization, order[0].id)).toEqual(order[1])
    organization.groups = [{ ...organization.groups[1],title:'New Y',memberKeys:[order[2].targetKey,order[1].targetKey] }]
    const after = saveCollectionOrganization(db, rootId, organization, 1).organization
    expect(after.watchEntries).toEqual(order)
    expect(new Set(after.watchEntries.map(entry => entry.targetKey)).size).toBe(3)
    expect(nextCollectionEntry(after, order[0].id)).toEqual(order[1])
  })
  it('persists reopening and leaves organization intact through metadata refresh and catalog rebuild', () => {
    const organization = saved()
    db.close(); db = createDb(path.join(directory, 'test.db'))
    expect(getCollectionOrganization(db, rootId).organization).toEqual(organization)
    sqlRun(db, "UPDATE folders SET synopsis='Refreshed', year=2025 WHERE id=?", folderIds[0])
    rebuildLibraryMediaCatalog(db, libraryId)
    expect(getCollectionOrganization(db, rootId).organization).toEqual(organization)
    expect(getCollectionOrganization(db, rootId).revision).toBe(1)
  })
  it('appends new members once with pending placement, irrespective of refreshed titles', () => {
    const organization = saved()
    sqlRun(db, `INSERT INTO media_items(library_id,root_folder_id,item_key,title,kind) VALUES (?,?, 'new:1','0 new','movie')`, [libraryId,rootId])
    appendNewCollectionMembers(db, libraryId)
    const after = getCollectionOrganization(db,rootId)
    expect(after.organization.watchEntries.slice(0,3)).toEqual(organization.watchEntries)
    expect(after.organization.watchEntries[3]).toMatchObject({targetKey:'item:new:1',pending:true})
    sqlRun(db, "UPDATE media_items SET title='zz new' WHERE item_key='new:1'")
    appendNewCollectionMembers(db,libraryId)
    expect(getCollectionOrganization(db,rootId)).toEqual(after)
  })
  it('keeps unexpected missing entries in their exact position, but explicit exclusion cleans only that member', () => {
    const organization = saved(), [a,b,c] = organization.watchEntries
    sqlRun(db, "DELETE FROM media_items WHERE item_key='anilist:9102'")
    expect(nextCollectionEntry(getCollectionOrganization(db,rootId).organization,a.id)).toEqual(b)
    expect(getCollectionOrganization(db,rootId).organization.watchEntries[2]).toEqual(c)
    rebuildLibraryMediaCatalog(db,libraryId)
    setManualMediaCatalog(db,folderIds[1],{excluded:true})
    const after = getCollectionOrganization(db,rootId).organization
    expect(after.watchEntries.map(entry=>entry.targetKey)).toEqual([a.targetKey,c.targetKey])
    expect(after.groups.flatMap(group=>group.memberKeys)).not.toContain(b.targetKey)
    expect(sqlGet(db,'SELECT id FROM folders WHERE id=?',folderIds[1])).toBeTruthy()
    expect(sqlGet(db,'SELECT id FROM files WHERE folder_id=?',folderIds[1])).toBeTruthy()
  })
  it('rejects stale, duplicate, cross-collection and incomplete edits without changing saved data', () => {
    const organization = saved(), before = getCollectionOrganization(db,rootId)
    expect(()=>saveCollectionOrganization(db,rootId,{...organization,groups:[]},0)).toThrow('其他位置')
    expect(()=>saveCollectionOrganization(db,rootId,{...organization,watchEntries:[...organization.watchEntries,organization.watchEntries[0]]},1)).toThrow('重复')
    expect(()=>saveCollectionOrganization(db,rootId,{...organization,groups:[{id:'bad',title:'Bad',memberKeys:['item:outside']}]},1)).toThrow()
    expect(()=>saveCollectionOrganization(db,rootId,{...organization,watchEntries:[]},1)).toThrow('全部')
    expect(getCollectionOrganization(db,rootId)).toEqual(before)
  })
  it('does not modify item identity or number a movie when constructing whole-work entries', () => {
    expect(collectionMemberKey('custom:TV:anilist:1')).not.toBe(collectionMemberKey('custom:Movie:anilist:1'))
    const organization=resolveCollectionOrganization(null,['item:movie','item:zero'])
    expect(validateCollectionOrganization(organization,['item:movie','item:zero'])).toEqual(organization)
    expect(organization.watchEntries).toEqual([{id:'watch:item:movie',targetKey:'item:movie'},{id:'watch:item:zero',targetKey:'item:zero'}])
  })
  it('carries a proven same-item rekey and manual replacement without duplicate pending entries', () => {
    const organization=saved(), old=organization.watchEntries[0]
    rekeyCollectionMember(db,rootId,'anilist:9101','anilist:9101#content:A')
    sqlRun(db,"UPDATE media_items SET item_key='anilist:9101#content:A' WHERE item_key='anilist:9101'")
    appendNewCollectionMembers(db,libraryId)
    const rekeyed=getCollectionOrganization(db,rootId).organization
    expect(rekeyed.watchEntries).toHaveLength(3)
    expect(rekeyed.watchEntries[0]).toEqual({...old,targetKey:'item:anilist:9101#content:A'})
    expect(rekeyed.groups[0].memberKeys[0]).toBe('item:anilist:9101#content:A')
    setManualMediaCatalog(db,folderIds[0],{kind:'custom',customLabel:'TV',seasonNumbers:[]})
    const replaced=getCollectionOrganization(db,rootId).organization
    expect(replaced.watchEntries).toHaveLength(3)
    expect(replaced.watchEntries[0].id).toBe(old.id)
    expect(collectionMemberKeys(db,rootId)).toContain(replaced.watchEntries[0].targetKey)
  })
  it('keeps entry IDs unique when an old key returns after a proven rekey', () => {
    const original = saved()
    rekeyCollectionMember(db,rootId,'anilist:9101','anilist:9101#content:A')
    sqlRun(db,"UPDATE media_items SET item_key='anilist:9101#content:A' WHERE item_key='anilist:9101'")
    sqlRun(db,"INSERT INTO media_items(library_id,root_folder_id,item_key,title,kind) VALUES (?,?,'anilist:9101','Another item','movie')",[libraryId,rootId])
    appendNewCollectionMembers(db,libraryId)
    const result=getCollectionOrganization(db,rootId).organization
    expect(result.watchEntries[0].id).toBe(original.watchEntries[0].id)
    expect(result.watchEntries.at(-1)).toMatchObject({targetKey:'item:anilist:9101',pending:true})
    expect(new Set(result.watchEntries.map(entry=>entry.id)).size).toBe(4)
  })
  it('reports malformed saved configuration without replacing it with an empty sequence', () => {
    saved()
    sqlRun(db,"UPDATE media_collection_organization SET organization_json=? WHERE root_folder_id=?",['{"version":1,"watchEntries":null}',rootId])
    expect(()=>getCollectionOrganization(db,rootId)).toThrow('合集组织记录无法读取')
    expect(sqlGet<{organization_json:string}>(db,'SELECT organization_json FROM media_collection_organization WHERE root_folder_id=?',rootId)?.organization_json).toBe('{"version":1,"watchEntries":null}')
  })
})
