import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDb } from '../../db/schema'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { presentFolders, resolveFolderPresentation } from '../folder-presentation'
import { JPEG_IMAGE } from './poster-fixture'

describe('folder presentation metadata', () => {
  let db: any
  let libraryId: number

  beforeEach(() => {
    db = createDb(':memory:')
    libraryId = makeLibraryDb(db).create('动漫', 'D:\\Anime', 'anime').id
  })

  afterEach(() => db.close())

  const createFolders = (paths: string[]) => {
    makeFolderDb(db).upsertTree(libraryId, ['D:\\Anime', ...paths])
    return Object.fromEntries(paths.map(path => [
      path,
      db.prepare('SELECT * FROM folders WHERE path = ?').get(path),
    ])) as Record<string, any>
  }

  const addMetadata = (folderId: number, externalId: number, year = 2020) => {
    db.prepare(`
      UPDATE folders SET anilist_id = ?, has_poster = 1, source = 'bangumi',
        rating = 8.0, synopsis = '简介', year = ?, episodes = 12
      WHERE id = ?
    `).run([externalId, year, folderId])
  }

  it('provides a resolver for a folder display metadata source', async () => {
    const module = await import('../folder-presentation').catch(() => ({} as Record<string, unknown>))
    expect(module.resolveFolderPresentation).toBeTypeOf('function')
  })

  it('uses the only normal metadata child instead of an SP folder', () => {
    const paths = [
      'D:\\Anime\\调教咖啡厅',
      'D:\\Anime\\调教咖啡厅\\[VCB-Studio] 调教咖啡厅',
      'D:\\Anime\\调教咖啡厅\\SPs',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 204145)
    addMetadata(folders[paths[2]].id, 999999)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[1]].id)
    expect(result?.candidates.find(candidate => candidate.id === folders[paths[2]].id)?.kind).toBe('extras')
  })

  it('selects a first-season folder by name rather than path order', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\第三季',
      'D:\\Anime\\作品\\第一季',
      'D:\\Anime\\作品\\第二季',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 3)
    addMetadata(folders[paths[2]].id, 1)
    addMetadata(folders[paths[3]].id, 2)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[2]].id)
  })

  it('selects the unique metadata child whose year matches the outer folder year', () => {
    const paths = [
      'D:\\Anime\\某科学的超电磁炮 [2009]',
      'D:\\Anime\\某科学的超电磁炮 [2009]\\Toaru Kagaku no Railgun T',
      'D:\\Anime\\某科学的超电磁炮 [2009]\\Toaru Kagaku no Railgun',
      'D:\\Anime\\某科学的超电磁炮 [2009]\\Toaru Kagaku no Railgun S',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 12710, 2020)
    addMetadata(folders[paths[2]].id, 12528, 2009)
    addMetadata(folders[paths[3]].id, 12620, 2013)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)
    const root = db.prepare('SELECT * FROM folders WHERE id = ?').get(folders[paths[0]].id)
    const [presented] = presentFolders(db, [root], os.tmpdir(), true)

    expect(result?.candidates.filter(candidate => candidate.hasMetadata).map(candidate => candidate.kind))
      .toEqual(['unknown', 'unknown', 'unknown'])
    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[2]].id)
    expect(presented.id).toBe(root.id)
    expect(presented.name).toBe(root.name)
    expect(presented.path).toBe(root.path)
    expect(presented.display_metadata_folder_id).toBeNull()
    expect(presented.effective_metadata_folder_id).toBe(folders[paths[2]].id)
    expect(presented.anilist_id).toBe(12528)
    expect(presented.year).toBe(2009)
    expect(presented.synopsis).toBe('简介')
  })

  it('does not guess between ambiguous normal descendants', () => {
    const paths = [
      'D:\\Anime\\Fate Series',
      'D:\\Anime\\Fate Series\\Fate stay night',
      'D:\\Anime\\Fate Series\\Fate Zero',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 11)
    addMetadata(folders[paths[2]].id, 12)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
  })

  it('does not automatically promote a standalone SP or OVA directory', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\[字幕组][SP]',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 99)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
    expect(result?.candidates[1].kind).toBe('special')
  })

  it('recognizes a decorated SPs directory as extras', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\[VCB-Studio] SPs [1080p]',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 100)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
    expect(result?.candidates[1].kind).toBe('extras')
  })

  it('does not promote metadata nested below an extras directory', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\SPs',
      'D:\\Anime\\作品\\SPs\\Vol.1',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[2]].id, 101)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
    expect(result?.candidates.find(candidate => candidate.id === folders[paths[2]].id)?.kind).toBe('extras')
  })

  it('treats a numbered SP pack as extras instead of a main release', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\SPs 01-06',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 102)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
    expect(result?.candidates[1].kind).toBe('extras')
  })

  it('does not guess a first season when another normal work is mixed in', () => {
    const paths = [
      'D:\\Anime\\作品合集',
      'D:\\Anime\\作品合集\\第一季',
      'D:\\Anime\\作品合集\\外传故事',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 1)
    addMetadata(folders[paths[2]].id, 2)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
  })

  it('does not combine seasons whose names belong to different works', () => {
    const paths = [
      'D:\\Anime\\作品合集',
      'D:\\Anime\\作品合集\\Show A Season 1',
      'D:\\Anime\\作品合集\\Show B Season 2',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 1)
    addMetadata(folders[paths[2]].id, 2)

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
  })

  it('honors an explicit descendant selection', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\第一季',
      'D:\\Anime\\作品\\第二季',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 1)
    addMetadata(folders[paths[2]].id, 2)
    db.prepare('UPDATE folders SET display_metadata_folder_id = ? WHERE id = ?')
      .run([folders[paths[2]].id, folders[paths[0]].id])

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[2]].id)
    expect(result?.isExplicit).toBe(true)
  })

  it('keeps an explicit no-metadata descendant available as a candidate', () => {
    const paths = [
      'D:\\Anime\\作品',
      'D:\\Anime\\作品\\第一季',
    ]
    const folders = createFolders(paths)
    db.prepare('UPDATE folders SET display_metadata_folder_id = ? WHERE id = ?')
      .run([folders[paths[1]].id, folders[paths[0]].id])

    const result = resolveFolderPresentation(db, folders[paths[0]].id)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[1]].id)
    expect(result?.candidates.map(candidate => candidate.id)).toContain(folders[paths[1]].id)
  })

  it('normalizes an explicit selection that is no longer in the folder subtree', () => {
    const paths = [
      'D:\\Anime\\作品A',
      'D:\\Anime\\作品A\\第一季',
      'D:\\Anime\\作品B',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 1)
    db.prepare('UPDATE folders SET display_metadata_folder_id = ? WHERE id = ?')
      .run([folders[paths[1]].id, folders[paths[0]].id])
    db.prepare('UPDATE folders SET parent_id = ?, path = ? WHERE id = ?')
      .run([folders[paths[2]].id, 'D:\\Anime\\作品B\\第一季', folders[paths[1]].id])

    const result = resolveFolderPresentation(db, folders[paths[0]].id)
    const root = db.prepare('SELECT * FROM folders WHERE id = ?').get(folders[paths[0]].id)
    const [presented] = presentFolders(db, [root], os.tmpdir(), true)

    expect(result?.effectiveMetadataFolderId).toBe(folders[paths[0]].id)
    expect(result?.isExplicit).toBe(false)
    expect(presented.display_metadata_folder_id).toBeNull()
  })

  it('rejects an explicit selection outside the folder subtree', async () => {
    const paths = [
      'D:\\Anime\\作品A',
      'D:\\Anime\\作品A\\第一季',
      'D:\\Anime\\作品B',
    ]
    const folders = createFolders(paths)
    const module = await import('../folder-presentation') as any
    expect(module.setDisplayMetadataFolder).toBeTypeOf('function')
    if (typeof module.setDisplayMetadataFolder !== 'function') return

    expect(() => module.setDisplayMetadataFolder(db, folders[paths[0]].id, folders[paths[2]].id))
      .toThrow('展示元数据目录必须是当前目录或其后代')
  })

  it('builds a stable poster version from the actual cached file', async () => {
    const paths = ['D:\\Anime\\作品']
    const folders = createFolders(paths)
    addMetadata(folders[paths[0]].id, 42)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-poster-'))
    try {
      fs.writeFileSync(path.join(dir, 'bg_42.jpg'), 'poster')
      const module = await import('../folder-presentation') as any
      expect(module.getPosterAsset).toBeTypeOf('function')
      if (typeof module.getPosterAsset !== 'function') return
      const metadataFolder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folders[paths[0]].id)

      const readFile = vi.spyOn(fs, 'readFileSync')
      const first = module.getPosterAsset(metadataFolder, dir)
      const second = module.getPosterAsset(metadataFolder, dir)

      expect(first?.version).toBe(second?.version)
      expect(first?.path).toBe(path.join(dir, 'bg_42.jpg'))
      expect(readFile).toHaveBeenCalledTimes(1)

      const originalTime = fs.statSync(first.path).mtime
      fs.writeFileSync(first.path, 'POSTER')
      fs.utimesSync(first.path, originalTime, originalTime)
      const changed = module.getPosterAsset(metadataFolder, dir)
      expect(changed?.version).not.toBe(first?.version)
      readFile.mockRestore()
    } finally {
      vi.restoreAllMocks()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects the newest poster when legacy cache extensions coexist', async () => {
    const paths = ['D:\\Anime\\作品']
    const folders = createFolders(paths)
    addMetadata(folders[paths[0]].id, 43)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-poster-extensions-'))
    try {
      const jpg = path.join(dir, 'bg_43.jpg')
      const png = path.join(dir, 'bg_43.png')
      fs.writeFileSync(jpg, 'old')
      fs.writeFileSync(png, 'new')
      const oldTime = new Date(Date.now() - 60_000)
      fs.utimesSync(jpg, oldTime, oldTime)
      const metadataFolder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folders[paths[0]].id)

      const module = await import('../folder-presentation') as any
      const poster = module.getPosterAsset(metadataFolder, dir)

      expect(poster?.path).toBe(png)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps TMDB movie and TV posters isolated when their numeric ids match', async () => {
    const module = await import('../folder-presentation') as any
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-tmdb-poster-kinds-'))
    try {
      fs.writeFileSync(path.join(dir, 'tm_movie_8.jpg'), 'movie')
      fs.writeFileSync(path.join(dir, 'tm_tv_8.jpg'), 'tv')
      const movie = { id: 1, anilist_id: 8, has_poster: 1, source: 'tmdb', tmdb_media_type: 'movie' }
      const tv = { id: 2, anilist_id: 8, has_poster: 1, source: 'tmdb', tmdb_media_type: 'tv' }

      expect(module.getPosterAsset(movie, dir)?.path).toBe(path.join(dir, 'tm_movie_8.jpg'))
      expect(module.getPosterAsset(tv, dir)?.path).toBe(path.join(dir, 'tm_tv_8.jpg'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads valid legacy TMDB posters only for existing untyped bindings without promoting them', async () => {
    const module = await import('../folder-presentation') as any
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-tmdb-legacy-poster-'))
    try {
      fs.writeFileSync(path.join(dir, 'tm_8.jpg'), JPEG_IMAGE)
      const legacy = { id: 1, anilist_id: 8, has_poster: 1, source: 'tmdb', tmdb_media_type: null }
      expect(module.getPosterAsset(legacy, dir)).toMatchObject({ path: path.join(dir, 'tm_8.jpg'), version: expect.stringContaining('tm-8-') })
      expect(module.getPosterAsset({ ...legacy, tmdb_media_type: 'movie' }, dir)).toBeNull()
      expect(module.getPosterAsset({ ...legacy, has_poster: 0 }, dir)).toBeNull()
      expect(fs.readdirSync(dir)).toEqual(['tm_8.jpg'])
      fs.writeFileSync(path.join(dir, 'tm_8.jpg'), '<html>not a poster</html>')
      expect(module.getPosterAsset(legacy, dir)).toBeNull()
      expect(fs.existsSync(path.join(dir, 'tm_8.jpg'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('presents root identity with metadata and poster version from its representative child', async () => {
    const paths = [
      'D:\\Anime\\调教咖啡厅',
      'D:\\Anime\\调教咖啡厅\\[VCB-Studio] 调教咖啡厅',
    ]
    const folders = createFolders(paths)
    addMetadata(folders[paths[1]].id, 204145)
    const posterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-presented-poster-'))
    try {
      fs.writeFileSync(path.join(posterDir, 'bg_204145.jpg'), 'poster')
      const module = await import('../folder-presentation') as any
      expect(module.presentFolders).toBeTypeOf('function')
      if (typeof module.presentFolders !== 'function') return
      const root = db.prepare('SELECT * FROM folders WHERE id = ?').get(folders[paths[0]].id)

      const [presented] = module.presentFolders(db, [root], posterDir, true)

      expect(presented.id).toBe(root.id)
      expect(presented.name).toBe('调教咖啡厅')
      expect(presented.anilist_id).toBe(204145)
      expect(presented.synopsis).toBe('简介')
      expect(presented.effective_metadata_folder_id).toBe(folders[paths[1]].id)
      expect(presented.poster_version).toContain('bg-204145-')
      expect(presented.display_metadata_candidates).toHaveLength(2)
    } finally {
      fs.rmSync(posterDir, { recursive: true, force: true })
    }
  })

  it('uses immutable caching only for the current poster version', async () => {
    const module = await import('../folder-presentation') as any
    expect(module.posterCacheControl).toBeTypeOf('function')
    if (typeof module.posterCacheControl !== 'function') return

    expect(module.posterCacheControl('v1', 'v1')).toBe('private, max-age=31536000, immutable')
    expect(module.posterCacheControl(undefined, 'v1')).toBe('private, no-cache')
    expect(module.posterCacheControl('old', 'v1')).toBe('private, no-cache')
  })
})
