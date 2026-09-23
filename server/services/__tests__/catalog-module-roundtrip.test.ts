import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'node-sqlite3-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import mediaCatalogManifestJson from '../../../modules/media-catalog/manifest.json'
import type * as MediaCatalogOperations from '../../../modules/media-catalog/server/media-catalog'
import type { ModuleManifest } from '../../../shared/modules'
import { listDirtyCatalogLibraries } from '../../core/catalog-integrity'
import { ModuleRuntime, type ServerModuleLoader } from '../../core/module-runtime'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { createDb } from '../../db/schema'
import type { Library } from '../../types'
import { deleteFolderOnDisk, moveFolderToLibraryRoot } from '../folder-operations'
import { scanLibrary } from '../scanner'

interface EverythingFile {
  path: string
  size: number
  dateModified: number
}

const everythingState = vi.hoisted(() => ({
  snapshots: new Map<string, { files: EverythingFile[]; folders: string[] }>(),
}))

vi.mock('../everything', () => ({
  VIDEO_EXTS: ['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'flv', 'ts', 'webm'],
  EverythingClient: vi.fn().mockImplementation(function (this: any) {
    this.searchFiles = vi.fn(async (rootPath: string) => (
      everythingState.snapshots.get(rootPath)?.files.map(file => ({ ...file })) ?? []
    ))
    this.searchFolders = vi.fn(async (rootPath: string) => (
      [...(everythingState.snapshots.get(rootPath)?.folders ?? [])]
    ))
  }),
}))

const mediaCatalogManifest = mediaCatalogManifestJson as ModuleManifest
const mediaCatalogLoaders: Record<string, ServerModuleLoader> = {
  'media-catalog': () => import('../../../modules/media-catalog/server'),
}

type CatalogOperations = typeof MediaCatalogOperations

function setEverythingSnapshot(rootPath: string, folders: string[], filePaths: string[]): void {
  everythingState.snapshots.set(rootPath, {
    folders: [...folders],
    files: filePaths.map((filePath, index) => ({
      path: filePath,
      size: index + 1,
      dateModified: index + 1,
    })),
  })
}

function countIds(db: Database, table: string, ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${placeholders})`).get(ids) as { count: number }
  return row.count
}

describe('media catalog module restart round trip', () => {
  let tempDir: string | null = null
  let db: Database | null = null
  let runtime: ModuleRuntime | null = null

  async function stopCurrentRuntime(): Promise<void> {
    if (!runtime) return
    await runtime.stop()
    runtime = null
  }

  afterEach(async () => {
    await stopCurrentRuntime()
    db?.close()
    db = null
    everythingState.snapshots.clear()
    vi.clearAllMocks()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it.skipIf(process.platform !== 'win32')(
    'preserves manual catalog state across disabled scans, a cross-library move, deletion, and startup rebuild',
    async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-catalog-roundtrip-'))
      const dbPath = path.join(tempDir, 'catalog.db')
      const sourceRoot = path.join(tempDir, 'library-a')
      const targetRoot = path.join(tempDir, 'library-b')
      const collectionPath = path.join(sourceRoot, 'Collection')
      const seasonOnePath = path.join(collectionPath, 'Season 1')
      const ovaPath = path.join(collectionPath, 'OVA')
      const moviePath = path.join(collectionPath, 'Movie')
      const deletedRootPath = path.join(sourceRoot, 'Delete Me')
      const deletedSeasonPath = path.join(deletedRootPath, 'Season 1')
      const seasonOneFile = path.join(seasonOnePath, 'S01E01.mkv')
      const ovaFile = path.join(ovaPath, 'OVA01.mkv')
      const movieFile = path.join(moviePath, 'Movie.mkv')
      const deletedFile = path.join(deletedSeasonPath, 'S01E01.mkv')

      for (const filePath of [seasonOneFile, ovaFile, movieFile, deletedFile]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, 'video')
      }
      fs.mkdirSync(targetRoot, { recursive: true })

      db = createDb(dbPath)
      const libraries = makeLibraryDb(db)
      const sourceLibrary = libraries.create('Library A', sourceRoot, 'anime')
      const targetLibrary = libraries.create('Library B', targetRoot, 'anime')
      setEverythingSnapshot(sourceRoot, [
        sourceRoot,
        collectionPath,
        seasonOnePath,
        ovaPath,
        moviePath,
        deletedRootPath,
        deletedSeasonPath,
      ], [seasonOneFile, ovaFile, movieFile, deletedFile])
      setEverythingSnapshot(targetRoot, [targetRoot], [])

      runtime = new ModuleRuntime(db, [mediaCatalogManifest], mediaCatalogLoaders)
      await runtime.start()
      expect(runtime.isActive('media-catalog')).toBe(true)

      await scanLibrary(sourceLibrary, db)
      await scanLibrary(targetLibrary, db)
      expect(listDirtyCatalogLibraries(db)).toEqual([])

      const sourceFolders = makeFolderDb(db).getByLibrary(sourceLibrary.id)
      const collection = sourceFolders.find(folder => folder.path === collectionPath)!
      const seasonOne = sourceFolders.find(folder => folder.path === seasonOnePath)!
      const ova = sourceFolders.find(folder => folder.path === ovaPath)!
      const deletedRoot = sourceFolders.find(folder => folder.path === deletedRootPath)!
      const deletedSeason = sourceFolders.find(folder => folder.path === deletedSeasonPath)!
      expect(collection.is_series).toBe(1)
      expect(deletedRoot.is_series).toBe(1)

      const catalog = runtime.capability<CatalogOperations>('catalogOperations')
      expect(catalog).toBeDefined()
      const initial = catalog!.getCanonicalMediaCatalogForRoot(db, collection.id) as any
      const ovaMapping = initial.mappings.find((mapping: any) => mapping.folder_id === ova.id)
      const automaticGroup = initial.work_groups.find((group: any) => (
        group.item_ids.includes(ovaMapping.media_item_id) && group.item_ids.length > 1
      ))
      expect(automaticGroup).toBeDefined()

      const split = catalog!.splitMediaWorkGroup(
        db,
        collection.id,
        automaticGroup.id,
        [ovaMapping.media_item_id],
        'Manual retained group',
      ) as any
      const retainedGroup = split.canonical.work_groups.find((group: any) => group.title === 'Manual retained group')
      expect(retainedGroup).toMatchObject({
        manual_locked: 1,
        members: [expect.objectContaining({ media_item_id: ovaMapping.media_item_id, manual_locked: 1 })],
      })

      catalog!.setManualMediaCatalog(db, seasonOne.id, {
        kind: 'season',
        seasonNumbers: [7],
        partNumber: 2,
      })
      const retainedMember = db.prepare(`
        SELECT member.relation_role
        FROM media_work_group_members member
        WHERE member.work_group_id = ?
      `).get(retainedGroup.id) as { relation_role: string }
      const deletedCatalog = catalog!.getCanonicalMediaCatalogForRoot(db, deletedRoot.id) as any
      const deletedSeriesIds = (db.prepare('SELECT id FROM media_series WHERE root_folder_id = ?').all(deletedRoot.id) as Array<{ id: number }>).map(row => row.id)
      const deletedItemIds = deletedCatalog.items.map((item: any) => item.id) as number[]
      const deletedGroupIds = deletedCatalog.work_groups.map((group: any) => group.id) as number[]
      expect(deletedSeriesIds.length).toBeGreaterThan(0)
      expect(deletedItemIds.length).toBeGreaterThan(0)
      expect(deletedGroupIds.length).toBeGreaterThan(0)

      runtime.configure({ enabled: { 'media-catalog': false } })
      await stopCurrentRuntime()

      runtime = new ModuleRuntime(db, [mediaCatalogManifest], mediaCatalogLoaders)
      await runtime.start()
      expect(runtime.isActive('media-catalog')).toBe(false)
      expect(runtime.capability('catalogOperations')).toBeUndefined()

      const seasonTwoPath = path.join(collectionPath, 'Season 2')
      const seasonTwoFile = path.join(seasonTwoPath, 'S02E01.mkv')
      fs.mkdirSync(seasonTwoPath, { recursive: true })
      fs.writeFileSync(seasonTwoFile, 'video')
      setEverythingSnapshot(sourceRoot, [
        sourceRoot,
        collectionPath,
        seasonOnePath,
        path.join(collectionPath, 'OVA'),
        path.join(collectionPath, 'Movie'),
        seasonTwoPath,
        deletedRootPath,
        deletedSeasonPath,
      ], [seasonOneFile, ovaFile, movieFile, seasonTwoFile, deletedFile])

      const reopenedSourceLibrary = makeLibraryDb(db).getById(sourceLibrary.id) as Library
      await scanLibrary(reopenedSourceLibrary, db)
      const seasonTwo = makeFolderDb(db).getByLibrary(sourceLibrary.id).find(folder => folder.path === seasonTwoPath)!
      expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id = ?').get(seasonTwo.id))
        .toEqual({ count: 0 })
      expect(listDirtyCatalogLibraries(db)).toContain(sourceLibrary.id)

      const move = await moveFolderToLibraryRoot(db, collection.id, {
        targetLibraryId: targetLibrary.id,
        expectedPath: collectionPath,
      })
      const movedCollectionPath = path.join(targetRoot, 'Collection')
      expect(move).toMatchObject({
        id: collection.id,
        libraryId: targetLibrary.id,
        path: movedCollectionPath,
      })
      expect(fs.existsSync(collectionPath)).toBe(false)
      expect(fs.existsSync(path.join(movedCollectionPath, 'Season 2', 'S02E01.mkv'))).toBe(true)

      await deleteFolderOnDisk(db, deletedRoot.id, { expectedPath: deletedRootPath })
      expect(fs.existsSync(deletedRootPath)).toBe(false)

      runtime.configure({ enabled: { 'media-catalog': true } })
      await stopCurrentRuntime()

      runtime = new ModuleRuntime(db, [mediaCatalogManifest], mediaCatalogLoaders)
      await runtime.start()
      expect(runtime.isActive('media-catalog')).toBe(true)

      expect(db.prepare(`
        SELECT entry.kind, entry.season_number, entry.part_number,
               entry.manual_locked, series.library_id, series.root_folder_id,
               folder.library_id AS folder_library_id, folder.path AS folder_path
        FROM folder_media_entries entry
        JOIN media_series series ON series.id = entry.series_id
        JOIN folders folder ON folder.id = entry.folder_id
        WHERE entry.folder_id = ? AND entry.manual_locked = 1
      `).all(seasonOne.id)).toEqual([{
        kind: 'season',
        season_number: 7,
        part_number: 2,
        manual_locked: 1,
        library_id: targetLibrary.id,
        root_folder_id: collection.id,
        folder_library_id: targetLibrary.id,
        folder_path: path.join(movedCollectionPath, 'Season 1'),
      }])

      expect(db.prepare(`
        SELECT work_group.id, work_group.library_id, work_group.root_folder_id,
               work_group.title, work_group.manual_locked,
               member.relation_role, member.manual_locked AS member_manual_locked,
               item.library_id AS item_library_id,
               item.root_folder_id AS item_root_folder_id,
               mapping.folder_id AS mapped_folder_id
        FROM media_work_groups work_group
        JOIN media_work_group_members member ON member.work_group_id = work_group.id
        JOIN media_items item ON item.id = member.media_item_id
        JOIN folder_media_mappings mapping ON mapping.media_item_id = item.id
        WHERE work_group.id = ? AND mapping.folder_id = ?
      `).all([retainedGroup.id, ova.id])).toEqual([{
        id: retainedGroup.id,
        library_id: targetLibrary.id,
        root_folder_id: collection.id,
        title: 'Manual retained group',
        manual_locked: 1,
        relation_role: retainedMember.relation_role,
        member_manual_locked: 1,
        item_library_id: targetLibrary.id,
        item_root_folder_id: collection.id,
        mapped_folder_id: ova.id,
      }])

      expect(db.prepare(`
        SELECT entry.kind, entry.season_number, entry.manual_locked,
               series.library_id, series.root_folder_id
        FROM folder_media_entries entry
        JOIN media_series series ON series.id = entry.series_id
        WHERE entry.folder_id = ?
      `).all(seasonTwo.id)).toEqual([{
        kind: 'season',
        season_number: 2,
        manual_locked: 0,
        library_id: targetLibrary.id,
        root_folder_id: collection.id,
      }])

      expect(countIds(db, 'folders', [deletedRoot.id, deletedSeason.id])).toBe(0)
      expect(countIds(db, 'media_series', deletedSeriesIds)).toBe(0)
      expect(countIds(db, 'media_items', deletedItemIds)).toBe(0)
      expect(countIds(db, 'media_work_groups', deletedGroupIds)).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_entries WHERE folder_id IN (?, ?)').get([deletedRoot.id, deletedSeason.id]))
        .toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM folder_media_mappings WHERE folder_id IN (?, ?)').get([deletedRoot.id, deletedSeason.id]))
        .toEqual({ count: 0 })
      expect(listDirtyCatalogLibraries(db)).toEqual([])
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    },
  )
})


