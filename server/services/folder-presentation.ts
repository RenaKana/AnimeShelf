import type { Database } from 'node-sqlite3-wasm'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { Folder } from '../types'
import { sqlAll, sqlGet, sqlRun } from '../db/sql'
import { posterCacheKey } from '../../shared/poster-cache-key'
import { isValidPosterImage, MAX_POSTER_BYTES } from './poster-image'
import { classifyFolder } from './media-domain'
import type { MediaDomainResolution } from '../../shared/media-domain'

import { chooseAutomaticDisplayMetadata, classifyDisplayMetadataFolder, type DisplayMetadataKind } from '../../shared/display-metadata-selection'
export { classifyDisplayMetadataFolder }
export type { DisplayMetadataKind }

export interface DisplayMetadataCandidate {
  id: number
  name: string
  path: string
  kind: DisplayMetadataKind
  depth: number
  hasMetadata: boolean
}

export interface FolderPresentation {
  folder: Folder
  metadataFolder: Folder
  effectiveMetadataFolderId: number
  isExplicit: boolean
  candidates: DisplayMetadataCandidate[]
}

export interface PosterAsset {
  path: string
  version: string
  size: number
  modifiedAt: Date
}

type PrivatePersistenceKey = 'filesystem_identity' | 'missing_source'

type PresentedFolderFields = MediaDomainResolution & Pick<Folder,
  'id' | 'anilist_id' | 'has_poster' | 'source' | 'tmdb_media_type' | 'rating' | 'genres' | 'synopsis' | 'year' | 'episodes'
> & {
  display_metadata_folder_id: number | null
  effective_metadata_folder_id: number
  effective_metadata_folder_name: string
  poster_version: string | null
  owned_season_numbers?: number[] | null
  display_metadata_candidates?: DisplayMetadataCandidate[]
}

export type PresentedFolder<T extends Folder = Folder> = Omit<T, PrivatePersistenceKey> & PresentedFolderFields

type FolderRow = Folder & {
  display_metadata_folder_id?: number | null
  depth: number
}

const POSTER_DIGEST_CACHE_LIMIT = 512
const posterDigestCache = new Map<string, { signature: string; digest: string }>()

function posterDigest(file: string, stat: fs.Stats): string {
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const cached = posterDigestCache.get(file)
  if (cached?.signature === signature) return cached.digest
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  posterDigestCache.delete(file)
  posterDigestCache.set(file, { signature, digest })
  if (posterDigestCache.size > POSTER_DIGEST_CACHE_LIMIT) {
    const oldest = posterDigestCache.keys().next().value
    if (oldest) posterDigestCache.delete(oldest)
  }
  return digest
}

const hasMetadata = (folder: Folder) => Boolean(
  folder.anilist_id
  || folder.has_poster
  || folder.synopsis?.trim()
  || folder.rating != null
  || folder.year != null
  || folder.episodes != null,
)

function classifyDisplayMetadataRow(root: FolderRow, row: FolderRow): DisplayMetadataKind {
  if (row.depth === 0) return 'self'
  const relative = path.relative(root.path, row.path)
  const segments = relative.split(/[\\/]+/).filter(Boolean)
  for (const segment of segments) {
    const kind = classifyDisplayMetadataFolder(segment)
    if (kind === 'extras' || kind === 'special' || kind === 'movie') return kind
  }
  return classifyDisplayMetadataFolder(row.name)
}

function subtreeRows(db: Database, folderId: number): FolderRow[] {
  return sqlAll<FolderRow>(db, `
    WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 0 FROM folders WHERE id = ?
      UNION ALL
      SELECT f.id, s.depth + 1 FROM folders f JOIN subtree s ON f.parent_id = s.id
    )
    SELECT f.*, s.depth FROM folders f JOIN subtree s ON s.id = f.id ORDER BY s.depth, f.path
  `, folderId)
}

function resolveFromRows(rows: FolderRow[]): FolderPresentation | null {
  const folder = rows[0]
  if (!folder) return null

  const candidates = rows
    .filter(row => row.depth === 0 || hasMetadata(row) || row.id === folder.display_metadata_folder_id)
    .map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      kind: classifyDisplayMetadataRow(folder, row),
      depth: row.depth,
      hasMetadata: hasMetadata(row),
    }))

  const explicit = folder.display_metadata_folder_id
    ? rows.find(row => row.id === folder.display_metadata_folder_id)
    : undefined
  if (explicit) {
    return {
      folder,
      metadataFolder: explicit,
      effectiveMetadataFolderId: explicit.id,
      isExplicit: true,
      candidates,
    }
  }

  let metadataFolder = folder
  if (!hasMetadata(folder)) {
    const eligible = rows.filter(row => {
      if (row.depth === 0 || !hasMetadata(row)) return false
      const kind = classifyDisplayMetadataRow(folder, row)
      return kind === 'season' || kind === 'unknown'
    })
    metadataFolder = chooseAutomaticDisplayMetadata(folder.path, eligible.map(row => ({
      row, name: row.name, year: row.year, parentId: row.parent_id, kind: classifyDisplayMetadataRow(folder, row),
    })))?.row ?? folder
  }

  return {
    folder,
    metadataFolder,
    effectiveMetadataFolderId: metadataFolder.id,
    isExplicit: false,
    candidates,
  }
}

export function resolveFolderPresentation(db: Database, folderId: number): FolderPresentation | null {
  return resolveFromRows(subtreeRows(db, folderId))
}

export function resolveFolderMediaDomain(db: Database, folderId: number): MediaDomainResolution | null {
  const presentation = resolveFolderPresentation(db, folderId)
  if (!presentation) return null
  const library = sqlGet<{ type: string }>(db, 'SELECT type FROM libraries WHERE id = ?', presentation.folder.library_id)
  return classifyFolder(presentation.folder, library?.type, presentation.metadataFolder)
}

export function setDisplayMetadataFolder(db: Database, folderId: number, targetFolderId: number | null): FolderPresentation {
  const current = resolveFolderPresentation(db, folderId)
  if (!current) throw new Error('folder not found')
  if (targetFolderId != null) {
    const allowed = subtreeRows(db, folderId).some(row => row.id === targetFolderId)
    if (!allowed) throw new Error('展示元数据目录必须是当前目录或其后代')
  }
  sqlRun(db, "UPDATE folders SET display_metadata_folder_id = ?, updated_at = datetime('now') WHERE id = ?", [targetFolderId, folderId])
  return resolveFolderPresentation(db, folderId)!
}

export function getPosterAsset(folder: Folder, posterDir: string): PosterAsset | null {
  if (!folder.anilist_id || !folder.has_poster) return null
  const typedKey = posterCacheKey(
    folder.source === 'tmdb' ? 'tmdb' : folder.source === 'bangumi' ? 'bangumi' : 'anilist',
    folder.anilist_id,
    folder.tmdb_media_type,
  )
  // Read-only compatibility for existing untyped bindings. Never promote this
  // ambiguous cache into either the movie or TV namespace.
  const legacy = !typedKey && folder.source === 'tmdb' && folder.tmdb_media_type == null
  const key = typedKey ?? (legacy ? `tm_${folder.anilist_id}` : null)
  if (!key) return null
  const candidates: Array<{ file: string; stat: fs.Stats }> = []
  for (const ext of ['jpg', 'png', 'webp']) {
    const file = path.join(posterDir, `${key}.${ext}`)
    try {
      const stat = fs.statSync(file)
      if (stat.isFile() && (!legacy || (stat.size <= MAX_POSTER_BYTES && isValidPosterImage(fs.readFileSync(file))))) candidates.push({ file, stat })
    } catch {
      // 缓存文件可能尚未写入或已被清理，继续探测其他扩展名。
    }
  }
  const selected = candidates.sort((left, right) =>
    right.stat.mtimeMs - left.stat.mtimeMs || right.stat.ctimeMs - left.stat.ctimeMs,
  )[0]
  if (!selected) return null
  try {
    const digest = posterDigest(selected.file, selected.stat)
    return {
      path: selected.file,
      version: `${key.replace(/_/g, '-')}-${digest.slice(0, 20)}`,
      size: selected.stat.size,
      modifiedAt: selected.stat.mtime,
    }
  } catch {
    return null
  }
}

export function posterCacheControl(requestedVersion: string | undefined, currentVersion: string): string {
  return requestedVersion === currentVersion
    ? 'private, max-age=31536000, immutable'
    : 'private, no-cache'
}

export function publicPersistenceRecord<T extends object>(record: T): Omit<T, PrivatePersistenceKey> {
  const publicRecord = { ...record } as T & { filesystem_identity?: unknown; missing_source?: unknown }
  delete publicRecord.filesystem_identity
  delete publicRecord.missing_source
  return publicRecord
}

function batchSubtreeRows(db: Database, folderIds: number[]): Map<number, FolderRow[]> {
  const ids = [...new Set(folderIds.filter(Number.isFinite))]
  const grouped = new Map<number, FolderRow[]>()
  if (ids.length === 0) return grouped
  const rows = sqlAll<FolderRow & { root_id: number }>(db, `
    WITH RECURSIVE subtree(root_id, id, depth) AS (
      SELECT id, id, 0 FROM folders WHERE id IN (${ids.join(',')})
      UNION ALL
      SELECT s.root_id, f.id, s.depth + 1 FROM folders f JOIN subtree s ON f.parent_id = s.id
    )
    SELECT f.*, s.root_id, s.depth
    FROM folders f JOIN subtree s ON s.id = f.id
    ORDER BY s.root_id, s.depth, f.path
  `)
  for (const row of rows) {
    if (!grouped.has(row.root_id)) grouped.set(row.root_id, [])
    grouped.get(row.root_id)!.push(row)
  }
  return grouped
}

/** Classification-only batch for catalog consumers; no poster IO or persisted defaults. */
export function resolveFolderMediaDomains(db: Database, folderIds: number[]): Map<number, MediaDomainResolution> {
  const rows = batchSubtreeRows(db, folderIds)
  const libraries = new Map(sqlAll<{ id: number; type: string }>(db, 'SELECT id, type FROM libraries').map(row => [row.id, row.type]))
  const result = new Map<number, MediaDomainResolution>()
  for (const [id, subtree] of rows) {
    const presentation = resolveFromRows(subtree)
    if (presentation) result.set(id, classifyFolder(presentation.folder, libraries.get(presentation.folder.library_id), presentation.metadataFolder))
  }
  return result
}

export function presentFolders<T extends Folder>(db: Database, folders: T[], posterDir: string, includeCandidates = false): Array<PresentedFolder<T>> {
  const grouped = batchSubtreeRows(db, folders.map(folder => folder.id))
  const libraryTypes = new Map(sqlAll<{ id: number; type: string }>(db, 'SELECT id, type FROM libraries').map(library => [library.id, library.type]))
  return folders.map(folder => {
    const presentation = resolveFromRows(grouped.get(folder.id) ?? [{ ...folder, depth: 0 }])
    const metadataFolder = presentation?.metadataFolder ?? folder
    const poster = getPosterAsset(metadataFolder, posterDir)
    return {
      ...publicPersistenceRecord(folder),
      ...classifyFolder(folder, libraryTypes.get(folder.library_id), metadataFolder),
      id: folder.id,
      display_metadata_folder_id: presentation?.isExplicit ? metadataFolder.id : null,
      anilist_id: metadataFolder.anilist_id,
      has_poster: metadataFolder.has_poster,
      source: metadataFolder.source,
      tmdb_media_type: metadataFolder.tmdb_media_type ?? null,
      rating: metadataFolder.rating,
      genres: metadataFolder.genres,
      synopsis: metadataFolder.synopsis,
      year: metadataFolder.year,
      episodes: metadataFolder.episodes,
      effective_metadata_folder_id: metadataFolder.id,
      effective_metadata_folder_name: metadataFolder.name,
      poster_version: poster?.version ?? null,
      ...(includeCandidates ? { display_metadata_candidates: presentation?.candidates ?? [] } : {}),
    }
  })
}
