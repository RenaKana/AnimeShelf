import { Router, type Request, type Response } from 'express'
import { db } from '../db/instance'
import { POSTER_DIR, as } from '../db/schema'
import { makeFolderDb } from '../db/folders'
import { makeFileDb } from '../db/files'
import { makeTagDb } from '../db/tags'
import { deleteFolderOnDisk, FolderOperationError, getFolderRenameHistory, moveFolderToLibraryRoot, relinkFolder, renameFolderOnDisk, undoFolderRename } from '../services/folder-operations'
import { isOwnerRequest } from '../core/owner-request'
import { setBatchMediaDomain } from '../services/batch-media-domain'
import { withLibraryMaintenance } from '../services/library-maintenance'
import { getPosterAsset, posterCacheControl, presentFolders, publicPersistenceRecord, resolveFolderPresentation } from '../services/folder-presentation'
import { collectionExtras, getMediaCatalogForFolder, getOwnedSeasonNumbers, invalidateLibraryMatches, moduleActive } from '../core/extensions'
import { rebuildLibraryMediaCatalogInTransaction } from '../core/catalog-access'
import type { Folder } from '../types'
import { isMediaDomainOverride, normalizeMediaDomain, type MediaDomain } from '../../shared/media-domain'


const router = Router()

const folderDb = () => makeFolderDb(db)

const fileDb = () => makeFileDb(db)

const tagDb = () => makeTagDb(db)


function isTrustedLocalMutation(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? ''
  const isLoopback = remote === '::1' || remote === '127.0.0.1' || remote.startsWith('::ffff:127.')
  if (!isLoopback) return false
  const origin = req.get('origin')
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}


function sendFolderOperationError(res: Response, error: unknown) {
  if (error instanceof FolderOperationError) {
    return res.status(error.status).json({ error: error.message, code: error.code })
  }
  if (error instanceof Error && 'status' in error && 'code' in error) return res.status(Number(error.status)).json({ error: error.message, code: error.code })
  const fsError = error as NodeJS.ErrnoException
  if (fsError?.code === 'EACCES' || fsError?.code === 'EPERM' || fsError?.code === 'EBUSY') {
    return res.status(409).json({ error: '文件夹正在使用或当前进程没有操作权限', code: 'FILESYSTEM_BUSY' })
  }
  console.error('Folder operation failed:', error)
  return res.status(500).json({ error: '文件夹操作失败，请查看服务端日志', code: 'FOLDER_OPERATION_FAILED' })
}


class FolderListQueryError extends Error {}

function repeatedStrings(value: unknown, name: string): string[] {
  if (value === undefined) return []
  const raw = Array.isArray(value) ? value : [value]
  if (raw.some(item => typeof item !== 'string')) throw new FolderListQueryError(`${name} 参数格式无效`)
  return [...new Set((raw as string[]).map(item => item.trim()).filter(Boolean))]
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new FolderListQueryError(`${name} 参数格式无效`)
  return value
}

function libraryIds(value: unknown): number[] {
  if (value === undefined) return []
  const raw = Array.isArray(value) ? value : [value]
  if (raw.some(item => typeof item !== 'string' || !item.trim())) {
    throw new FolderListQueryError('libraryId 参数格式无效')
  }
  return [...new Set((raw as string[]).map(value => {
    const normalized = value.trim()
    if (!/^\d+$/.test(normalized)) throw new FolderListQueryError('libraryId 必须是正整数')
    const id = Number(normalized)
    if (!Number.isSafeInteger(id) || id <= 0) throw new FolderListQueryError('libraryId 超出有效范围')
    return id
  }))]
}

type FolderMediaDomainFilter = MediaDomain | null

function parseMediaDomain(value: unknown, name: string): FolderMediaDomainFilter | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new FolderListQueryError(`${name} 参数格式无效`)
  const token = value.normalize('NFKC').trim().toLocaleLowerCase()
  if (!token) throw new FolderListQueryError(`${name} 参数格式无效`)
  if (new Set(['all', 'any', '全部', '全部媒体']).has(token)) return null
  const domain = normalizeMediaDomain(token)
  if (domain === 'unknown' && !new Set(['unknown', '未知', '待确认']).has(token)) {
    throw new FolderListQueryError(`${name} 参数必须是 anime、live_action 或 unknown`)
  }
  return domain
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function placeholders(length: number): string {
  return Array.from({ length }, () => '?').join(', ')
}

// 递归含可用视频的目录集合。缺失文件不会贡献结果，递归也不会跨过缺失目录。
const VIDEO_DIRS_SQL = `
  WITH RECURSIVE video_dirs(id) AS (
    SELECT file.folder_id
    FROM files file
    JOIN folders folder ON folder.id = file.folder_id
    WHERE file.path_missing = 0 AND folder.path_missing = 0
    UNION
    SELECT parent.id
    FROM folders current
    JOIN video_dirs video ON current.id = video.id
    JOIN folders parent ON parent.id = current.parent_id
    WHERE parent.path_missing = 0
  )
  SELECT id FROM video_dirs
`


// 子树递归统计（该目录及其全部后代的直接视频文件总数/总大小）——ids 为数字主键内联，无注入面
const subtreeStatsSql = (ids: number[]) => `
  WITH RECURSIVE subtree(id, root_id) AS (
    SELECT id, id FROM folders WHERE id IN (${ids.join(',')}) AND path_missing = 0
    UNION ALL
    SELECT f.id, s.root_id FROM folders f JOIN subtree s ON f.parent_id = s.id
    WHERE f.path_missing = 0
  )
  SELECT s.root_id root_id, COUNT(f.id) c, COALESCE(SUM(f.size), 0) sz
  FROM subtree s LEFT JOIN files f ON f.folder_id = s.id AND f.path_missing = 0
  GROUP BY s.root_id
`


// 批量有效标签（每个 id 沿祖先链取全部 folder 级标签）
const batchTagsSql = (ids: number[]) => `
  WITH RECURSIVE ancestors(id, root_id) AS (
    SELECT id, id FROM folders WHERE id IN (${ids.join(',')})
    UNION ALL
    SELECT f.parent_id, a.root_id FROM folders f JOIN ancestors a ON f.id = a.id WHERE f.parent_id IS NOT NULL
  )
  SELECT a.root_id root_id, t.id, t.name, t.color, t.kind
  FROM tags t JOIN tag_links l ON l.tag_id = t.id AND l.target_type = 'folder'
  JOIN ancestors a ON l.target_id = a.id
  GROUP BY a.root_id, t.id
`

type OwnedSeasonView = { id: number; owned_season_numbers: number[] | null }

function withOwnedSeasons<T extends { id: number }>(
  views: T[],
  owned: Map<number, number[]> | null = getOwnedSeasonNumbers(db, views.map(view => view.id)),
): Array<T & OwnedSeasonView> {
  return views.map(view => ({
    ...view,
    owned_season_numbers: owned?.get(view.id) ?? (owned ? [] : null),
  }))
}

function effectiveTagFilterSql(values: string[], match: 'any' | 'all'): string {
  if (values.length === 0) return ''
  const matches = `
    SELECT COUNT(DISTINCT tag.name)
    FROM folder_ancestors ancestor
    JOIN tag_links link ON link.target_type = 'folder' AND link.target_id = ancestor.id
    JOIN tags tag ON tag.id = link.tag_id
    WHERE ancestor.root_id = f.id AND tag.name IN (${placeholders(values.length)})
  `
  return match === 'all' ? `(${matches}) = ${values.length}` : `(${matches}) > 0`
}


router.get('/', (req, res) => {
  try {
    const selectedLibraryIds = libraryIds(req.query.libraryId)
    const selectedTags = repeatedStrings(req.query.tag, 'tag')
    const selectedStatuses = repeatedStrings(req.query.status, 'status')
    const q = optionalString(req.query.q, 'q')?.trim()
    const type = optionalString(req.query.type, 'type')
    const pinned = optionalString(req.query.pinned, 'pinned')
    const requestedMediaDomain = parseMediaDomain(req.query.mediaDomain, 'mediaDomain')
    const compatibleMediaType = parseMediaDomain(req.query.mediaType, 'mediaType')
    if (requestedMediaDomain !== undefined && compatibleMediaType !== undefined && requestedMediaDomain !== compatibleMediaType) {
      throw new FolderListQueryError('mediaDomain 与 mediaType 不能指定不同的媒体范围')
    }
    const selectedMediaDomain = requestedMediaDomain ?? compatibleMediaType
    const tagMatchValue = optionalString(req.query.tagMatch, 'tagMatch') ?? 'any'
    if (tagMatchValue !== 'any' && tagMatchValue !== 'all') {
      throw new FolderListQueryError('tagMatch 必须是 any 或 all')
    }
    // pinned=1：合集列表（侧边栏用）——不经过 VIDEO_DIRS_SQL，直接返回全部已标记目录
    if (pinned === '1') {
      const rows = db.all(`SELECT f.*, l.name AS library_name
        FROM folders f JOIN libraries l ON l.id = f.library_id
        WHERE f.pinned = 1 ORDER BY f.name`) as any[]
      return res.json(withOwnedSeasons(presentFolders(db, rows, POSTER_DIR).filter(row => !selectedMediaDomain || row.media_domain === selectedMediaDomain)))
    }
    // 合集（虚拟拎出）从媒体库视图中移出：排除 pinned 目录及其整个子树（仅侧边栏 ?pinned=1 可见）
    const PINNED_TREE_EXCLUDE = !moduleActive(db, 'media-catalog') ? '' : `AND f.id NOT IN (
      WITH RECURSIVE pinned_tree(id) AS (
        SELECT id FROM folders WHERE pinned = 1
        UNION ALL
        SELECT f.id FROM folders f JOIN pinned_tree p ON f.parent_id = p.id
      ) SELECT id FROM pinned_tree
    )`
    const filters: string[] = [
      `(f.id IN (${VIDEO_DIRS_SQL}) OR (f.path_missing = 1 AND f.is_series = 1))`,
    ]
    const params: Array<string | number> = []
    if (selectedLibraryIds.length > 0) {
      filters.push(`f.library_id IN (${placeholders(selectedLibraryIds.length)})`)
      params.push(...selectedLibraryIds)
    }
    if (q) {
      filters.push(`(lower(f.name) LIKE ? ESCAPE '\\' OR lower(f.path) LIKE ? ESCAPE '\\')`)
      const term = `%${escapeLike(q.toLocaleLowerCase())}%`
      params.push(term, term)
    }
    if (type === 'series') {
      filters.push(moduleActive(db, 'media-catalog') ? 'f.is_series = 1' : '(f.is_series = 1 OR f.pinned = 1)')
    } else if (type === 'folder' || type === 'other') {
      filters.push('f.is_series = 0')
    }
    const tagFilter = effectiveTagFilterSql(selectedTags, tagMatchValue)
    if (tagFilter) {
      filters.push(tagFilter)
      params.push(...selectedTags)
    }
    const statusFilter = effectiveTagFilterSql(selectedStatuses, 'any')
    if (statusFilter) {
      filters.push(statusFilter)
      params.push(...selectedStatuses)
    }

    // JOIN libraries 带出所属媒体库名；标签条件沿祖先链计算，结果集在进入展示层前已完成筛选。
    const folders = db.all(`
      WITH RECURSIVE folder_ancestors(root_id, id) AS (
        SELECT id, id FROM folders
        UNION ALL
        SELECT ancestor.root_id, folder.parent_id
        FROM folders folder
        JOIN folder_ancestors ancestor ON folder.id = ancestor.id
        WHERE folder.parent_id IS NOT NULL
      )
      SELECT f.*, l.name AS library_name
      FROM folders f JOIN libraries l ON l.id = f.library_id
      WHERE ${filters.join('\n        AND ')}
        ${PINNED_TREE_EXCLUDE}
      ORDER BY f.path
    `, params) as any[]

    let views: any[] = []
    if (folders.length > 0) {
      const ids = folders.map(f => f.id)
      // 批量递归统计 + 批量有效标签：各一条 SQL，替代逐条 N+1（原 59 条系列需 118 次递归查询）
      const statRows = db.all(subtreeStatsSql(ids)) as { root_id: number; c: number; sz: number }[]
      const statMap = new Map(statRows.map(s => [s.root_id, { c: s.c, s: s.sz }]))
      const tagRows = db.all(batchTagsSql(ids)) as { root_id: number; id: number; name: string; color: string; kind: string }[]
      const tagMap = new Map<number, { id: number; name: string; color: string; kind: string }[]>()
      for (const tr of tagRows) {
        if (!tagMap.has(tr.root_id)) tagMap.set(tr.root_id, [])
        tagMap.get(tr.root_id)!.push({ id: tr.id, name: tr.name, color: tr.color, kind: tr.kind })
      }
      const baseViews = folders.map((f: Folder & { library_name?: string }) => ({
        ...f,
        size: statMap.get(f.id)?.s ?? 0,
        file_count: statMap.get(f.id)?.c ?? 0,
        tags: tagMap.get(f.id) ?? [],
      }))
      views = withOwnedSeasons(presentFolders(db, baseViews, POSTER_DIR))
    }
    // Classification includes the selected display metadata, so filter the
    // shared presentation, not the library or an independently copied SQL rule.
    res.json(views.filter(view => !selectedMediaDomain || view.media_domain === selectedMediaDomain))
  } catch (e: any) {
    if (e instanceof FolderListQueryError) return res.status(400).json({ error: e.message, code: 'INVALID_FOLDER_QUERY' })
    res.status(500).json({ error: e.message })
  }
})


router.get('/:id', (req, res) => {
  try {
    const f = folderDb().getById(Number(req.params.id))
    if (!f) return res.status(404).json({ error: 'not found' })
    const childRows = db.all(`
      SELECT * FROM folders
      WHERE parent_id = ?
        AND ((path_missing = 0 AND id IN (${VIDEO_DIRS_SQL})) OR (path_missing = 1 AND is_series = 1))
      ORDER BY name
    `, f.id) as unknown as Folder[]
    // 合集从父目录详情页中隐藏（pinned 根不显示在媒体库浏览路径；其详情页内部内容不受影响）
    const visibleChildRows = childRows.filter(c => !moduleActive(db, 'media-catalog') || c.pinned !== 1)
    const presentationIds = [f.id, ...visibleChildRows.map(child => child.id)]
    const statRows = db.all(subtreeStatsSql(presentationIds)) as { root_id: number; c: number; sz: number }[]
    const statMap = new Map(statRows.map(stat => [stat.root_id, { c: stat.c, s: stat.sz }]))
    const childViews = visibleChildRows.map(child => ({
      ...child,
      size: statMap.get(child.id)?.s ?? 0,
      file_count: statMap.get(child.id)?.c ?? 0,
      tags: tagDb().effectiveTags('folder', child.id),
    }))
    const ownedSeasons = getOwnedSeasonNumbers(db, presentationIds)
    const children = withOwnedSeasons(presentFolders(db, childViews, POSTER_DIR), ownedSeasons)
    const files = fileDb().getByFolder(f.id).map(file => ({
      ...publicPersistenceRecord(file),
      tags: tagDb().effectiveTags('file', file.id),
    }))
    const own = statMap.get(f.id) ?? { c: 0, s: 0 }
    const [presented] = withOwnedSeasons(presentFolders(db, [{
      ...f,
      size: own.s,
      file_count: own.c,
      tags: tagDb().effectiveTags('folder', f.id),
    }], POSTER_DIR, true), ownedSeasons)
    const mediaCatalog = getMediaCatalogForFolder(db, f.id)
    res.json({
      ...presented,
      children,
      files,
      media_catalog: mediaCatalog.entries,
      media_catalog_summary: mediaCatalog.summary,
      media_catalog_v2: mediaCatalog.canonical,
      media_catalog_candidates: mediaCatalog.candidates,
      ...(f.pinned === 1 ? collectionExtras(db, f.id, POSTER_DIR) : {}),
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})


router.put('/batch/media-domain', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面修改媒体类型', code: 'OWNER_REQUIRED' })
    return res.json(await setBatchMediaDomain(db, req.body?.ids, req.body?.override))
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.put('/:id/media-domain', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面修改媒体类型', code: 'OWNER_REQUIRED' })
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id <= 0 || !isMediaDomainOverride(req.body?.override)) return res.status(400).json({ error: '媒体类型无效', code: 'INVALID_MEDIA_DOMAIN' })
    await withLibraryMaintenance(db, '媒体类型修改', () => {
      const folder = folderDb().getById(id)
      if (!folder) throw new FolderOperationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.run("UPDATE folders SET media_domain_override=?, updated_at=datetime('now') WHERE id=?", [req.body.override, id])
        rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    invalidateLibraryMatches(db)
    return res.json(presentFolders(db, [folderDb().getById(id)!], POSTER_DIR, true)[0])
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.put('/:id/display-name', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面修改显示名', code: 'OWNER_REQUIRED' })
    const id = Number(req.params.id)
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!Number.isSafeInteger(id) || id <= 0 || !name || name.length > 255 || /[\u0000-\u001f]/.test(name)) return res.status(400).json({ error: '显示名不能为空、含控制字符或超过255字', code: 'INVALID_NAME' })
    await withLibraryMaintenance(db, '显示名修改', () => {
      const folder = folderDb().getById(id)
      if (!folder) throw new FolderOperationError('文件夹不存在', 404, 'FOLDER_NOT_FOUND')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.run("UPDATE folders SET name=?, renamed=1, updated_at=datetime('now') WHERE id=?", [name, id])
        rebuildLibraryMediaCatalogInTransaction(db, folder.library_id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    invalidateLibraryMatches(db)
    return res.json(withOwnedSeasons(presentFolders(db, [folderDb().getById(id)!], POSTER_DIR, true))[0])
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.get('/:id/rename-history', (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面读取操作历史', code: 'OWNER_REQUIRED' })
    return res.json(getFolderRenameHistory(db, Number(req.params.id)))
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.post('/:id/undo-rename', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面撤销磁盘重命名', code: 'OWNER_REQUIRED' })
    const result = await undoFolderRename(db, Number(req.params.id), { operationId: String(req.body?.operationId ?? ''), expectedPath: String(req.body?.expectedPath ?? '') })
    invalidateLibraryMatches(db)
    return res.json(result)
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.put('/:id/relink', async (req, res) => {
  try {
    if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面关联本地目录', code: 'OWNER_REQUIRED' })
    const result = await relinkFolder(db, Number(req.params.id), { expectedPath: String(req.body?.expectedPath ?? ''), path: String(req.body?.path ?? '') })
    invalidateLibraryMatches(db)
    return res.json(result)
  } catch (error) { return sendFolderOperationError(res, error) }
})

router.put('/:id/rename', async (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面执行文件夹操作', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const name = String(req.body?.name ?? '').trim()
    const expectedPath = String(req.body?.expectedPath ?? '')
    const result = await renameFolderOnDisk(db, id, { name, expectedPath })
    invalidateLibraryMatches(db)
    res.json(result)
  } catch (error) {
    sendFolderOperationError(res, error)
  }
})


router.put('/:id/move', async (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面执行文件夹操作', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const targetLibraryId = Number(req.body?.targetLibraryId)
    const expectedPath = String(req.body?.expectedPath ?? '')
    const result = await moveFolderToLibraryRoot(db, id, { targetLibraryId, expectedPath })
    invalidateLibraryMatches(db)
    res.json(result)
  } catch (error) {
    sendFolderOperationError(res, error)
  }
})


router.delete('/:id', async (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面执行文件夹操作', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const expectedPath = String(req.body?.expectedPath ?? '')
    const result = await deleteFolderOnDisk(db, id, { expectedPath })
    invalidateLibraryMatches(db)
    res.json(result)
  } catch (error) {
    sendFolderOperationError(res, error)
  }
})


// POST /api/folders/rename-regex { pattern, replacement?, ignoreCase?, scope?, apply? } — 批量正则重命名显示名
// 只改数据库 folders.name（renamed 标记防扫描覆盖），不改变磁盘上的实际目录名。
// scope: 'top' = 仅番剧主目录（直接含视频、父级为纯分类的目录，任意深度——含多级分类库；不含季/子目录）；'all' = 全部（默认）。
// 不带 apply = 预览（返回匹配列表）；带 apply = 执行更新。支持 $1（捕获组）、$&（完整匹配）、$$。
router.post('/rename-regex', (req, res) => {
  try {
    const pattern = String(req.body?.pattern ?? '').trim()
    const replacement = String(req.body?.replacement ?? '')
    const ignoreCase = !!req.body?.ignoreCase
    const apply = !!req.body?.apply
    const scope = req.body?.scope === 'top' ? 'top' : 'all'
    if (!pattern) return res.status(400).json({ error: '正则表达式不能为空' })
    let re: RegExp
    try { re = new RegExp(pattern, ignoreCase ? 'gi' : 'g') } catch (e: any) { return res.status(400).json({ error: `正则无效：${e.message}` }) }
    // 番剧主目录 = 扫描器标记的 is_series（与「全部媒体」视图一致，166 条；季/子目录不标记）
    const scopeSql = scope === 'top' ? 'WHERE is_series = 1' : ''
    const rows = as<{ id: number; library_id: number; name: string }[]>(db.all(`SELECT id, library_id, name FROM folders ${scopeSql}`))
    const changes = rows
      .map(r => ({ id: r.id, from: r.name, to: r.name.replace(re, replacement) }))
      .filter(c => c.to && c.to !== c.from)
    if (!apply) return res.json({ count: changes.length, changes: changes.slice(0, 200), scope })
    const changedIds = new Set(changes.map(change => change.id))
    const affectedLibraryIds = new Set(rows.filter(row => changedIds.has(row.id)).map(row => row.library_id))
    db.exec('BEGIN IMMEDIATE')
    try {
      const upd = db.prepare('UPDATE folders SET name = ?, renamed = 1, updated_at = datetime(\'now\') WHERE id = ?')
      try {
        for (const c of changes) upd.run([c.to, c.id])
      } finally {
        upd.finalize()
      }
      for (const libraryId of affectedLibraryIds) rebuildLibraryMediaCatalogInTransaction(db, libraryId)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ }
      throw error
    }
    invalidateLibraryMatches(db)
    res.json({ applied: changes.length, changes: changes.slice(0, 200), scope })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})


// POST /api/folders/restore-names { scope?, dryRun? } — 一键恢复磁盘原名
// 把所有被重命名过的目录（renamed=1）显示名恢复为磁盘实际目录名（path 最后一段），并清除 renamed 标记。
// dryRun = 只返回将恢复的列表不执行。
router.post('/restore-names', (req, res) => {
  try {
    const scope = req.body?.scope === 'top' ? 'top' : 'all'
    const dryRun = !!req.body?.dryRun
    const scopeSql = scope === 'top' ? 'AND is_series = 1' : ''
    const rows = as<{ id: number; library_id: number; name: string; path: string }[]>(db.all(`SELECT id, library_id, name, path FROM folders WHERE renamed = 1 ${scopeSql}`))
    const items = rows
      .map(r => ({ id: r.id, from: r.name, to: (r.path.split(/[\\/]/).filter(Boolean).pop() ?? '').trim() }))
      .filter(i => i.to && i.to !== i.from)
    if (dryRun) return res.json({ count: items.length, items: items.slice(0, 200), scope })
    const restoredIds = new Set(items.map(item => item.id))
    const affectedLibraryIds = new Set(rows.filter(row => restoredIds.has(row.id)).map(row => row.library_id))
    db.exec('BEGIN IMMEDIATE')
    try {
      const upd = db.prepare('UPDATE folders SET name = ?, renamed = 0, updated_at = datetime(\'now\') WHERE id = ?')
      try {
        for (const i of items) upd.run([i.to, i.id])
      } finally {
        upd.finalize()
      }
      for (const libraryId of affectedLibraryIds) rebuildLibraryMediaCatalogInTransaction(db, libraryId)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ }
      throw error
    }
    invalidateLibraryMatches(db)
    res.json({ restored: items.length, items: items.slice(0, 200), scope })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})


router.get('/:id/poster', (req, res) => {
  try {
    const presentation = resolveFolderPresentation(db, Number(req.params.id))
    if (!presentation) return res.status(404).json({ error: 'poster not found' })
    const poster = getPosterAsset(presentation.metadataFolder, POSTER_DIR)
    if (!poster) return res.status(404).json({ error: 'poster not found' })
    const requestedVersion = typeof req.query.v === 'string' ? req.query.v : undefined
    res.setHeader('Cache-Control', posterCacheControl(requestedVersion, poster.version))
    res.setHeader('ETag', `"${poster.version}"`)
    res.setHeader('Last-Modified', poster.modifiedAt.toUTCString())
    if (req.fresh) return res.status(304).end()
    return res.sendFile(poster.path)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
