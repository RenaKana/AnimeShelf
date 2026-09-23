import { Router, type Request, type Response } from 'express'
import { db } from '../../../server/db/instance'
import { makeFolderDb } from '../../../server/db/folders'
import { getMediaCatalogForFolder, MediaCatalogValidationError, detachMediaWorkGroupItem, attachMediaWorkGroupItem, mergeMediaWorkGroups, rebuildLibraryMediaCatalogInTransaction, rebuildMediaCatalogForFolder, setMediaWorkGroupTitle, setMediaCatalogTitle, setManualMediaCatalog, splitMediaWorkGroup } from './media-catalog'
import { invalidateLibraryMatches } from '../../../server/core/extensions'
import { getCollectionPresentation, patchCollectionPresentation, setCollectionMemberGroup } from './collection-presentation'
import { resetCollectionCatalog } from './collection-reset'
import { CollectionOrganizationError, getCollectionOrganization, saveCollectionOrganization } from '../../../server/core/collection-organization'


const router = Router()

const folderDb = () => makeFolderDb(db)


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


function sendMediaCatalogError(res: Response, error: unknown) {
  if (error instanceof MediaCatalogValidationError || error instanceof CollectionOrganizationError) {
    return res.status(error.status).json({ error: error.message, code: error.code })
  }
  console.error('Media catalog operation failed:', error)
  return res.status(500).json({ error: '季度清单操作失败，请查看服务端日志', code: 'MEDIA_CATALOG_OPERATION_FAILED' })
}

router.get('/:id/collection-organization', (req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); return res.json(getCollectionOrganization(db, Number(req.params.id))) }
  catch (error) { return sendMediaCatalogError(res, error) }
})

router.patch('/:id/collection-organization', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改合集组织', code: 'LOCAL_REQUEST_REQUIRED' })
    if (!req.body || Object.keys(req.body).some(key => !['organization', 'expectedRevision'].includes(key))
      || !Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 0) {
      throw new CollectionOrganizationError('请提供合集组织配置及当前修订号')
    }
    db.exec('SAVEPOINT collection_organization_edit')
    try {
      const result = saveCollectionOrganization(db, Number(req.params.id), req.body.organization, req.body.expectedRevision)
      db.exec('RELEASE collection_organization_edit')
      return res.json(result)
    } catch (error) {
      db.exec('ROLLBACK TO collection_organization_edit'); db.exec('RELEASE collection_organization_edit'); throw error
    }
  } catch (error) { return sendMediaCatalogError(res, error) }
})


// GET /api/folders/:id/collection-presentation — 读取用户合集标题/顺序覆盖，不触发目录重建
router.get('/:id/collection-presentation', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    return res.json(getCollectionPresentation(db, Number(req.params.id)))
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PATCH /api/folders/:id/collection-presentation — 原子保存用户合集标题/顺序覆盖
router.patch('/:id/collection-presentation', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改合集展示', code: 'LOCAL_REQUEST_REQUIRED' })
    return res.json(patchCollectionPresentation(db, Number(req.params.id), req.body))
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PUT /api/folders/:id/collection-members/:itemId/group — 原子移动或显式移出作品组
router.put('/:id/collection-members/:itemId/group', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改合集分组', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = setCollectionMemberGroup(db, Number(req.params.id), Number(req.params.itemId), req.body)
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/collection-reset — 完全清除当前合集逻辑状态并按物理目录重新识别
router.post('/:id/collection-reset', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面完全重置合集', code: 'LOCAL_REQUEST_REQUIRED' })
    const result = resetCollectionCatalog(db, Number(req.params.id), req.body)
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: result.catalog.entries,
      media_catalog_summary: result.catalog.summary,
      media_catalog_v2: result.catalog.canonical,
      media_catalog_candidates: result.catalog.candidates,
      collection_reset: {
        root_folder_id: result.root_folder_id,
        before_snapshot_version: result.before_snapshot_version,
        after_snapshot_version: result.after_snapshot_version,
      },
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/rebuild-media-catalog — 重建该文件夹所属媒体库的持久化季度清单
router.post('/:id/rebuild-media-catalog', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面重建季度清单', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const rebuild = rebuildMediaCatalogForFolder(db, id)
    invalidateLibraryMatches(db)
    const catalog = getMediaCatalogForFolder(db, id)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
      rebuild,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PUT /api/folders/:id/media-catalog-title — 保存季度清单顶部的系列标题
router.put('/:id/media-catalog-title', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改季度清单标题', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const catalog = setMediaCatalogTitle(db, id, req.body?.title)
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PUT /api/folders/:id/media-work-groups/:groupId/title — 保存作品组标题
router.put('/:id/media-work-groups/:groupId/title', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改作品组标题', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = setMediaWorkGroupTitle(db, Number(req.params.id), Number(req.params.groupId), req.body?.title)
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/media-work-groups/:targetGroupId/merge — 合并作品组
router.post('/:id/media-work-groups/:targetGroupId/merge', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面合并作品组', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = mergeMediaWorkGroups(
      db,
      Number(req.params.id),
      Number(req.params.targetGroupId),
      Number(req.body?.sourceGroupId),
    )
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/media-work-groups/:groupId/detach — 拆出单个作品条目
router.post('/:id/media-work-groups/:groupId/detach', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面拆出作品条目', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = detachMediaWorkGroupItem(
      db,
      Number(req.params.id),
      Number(req.params.groupId),
      Number(req.body?.mediaItemId),
      req.body?.title,
    )
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/media-work-groups/:groupId/attach — 将未分组条目加入作品组
router.post('/:id/media-work-groups/:groupId/attach', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面加入作品组', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = attachMediaWorkGroupItem(
      db,
      Number(req.params.id),
      Number(req.params.groupId),
      Number(req.body?.mediaItemId),
    )
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// POST /api/folders/:id/media-work-groups/:groupId/split — 拆分所选作品条目
router.post('/:id/media-work-groups/:groupId/split', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面拆分作品组', code: 'LOCAL_REQUEST_REQUIRED' })
    const catalog = splitMediaWorkGroup(
      db,
      Number(req.params.id),
      Number(req.params.groupId),
      Array.isArray(req.body?.mediaItemIds) ? req.body.mediaItemIds.map((value: unknown) => Number(value)) : req.body?.mediaItemIds,
      req.body?.title,
    )
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PUT /api/folders/:id/media-catalog — 手动指定或清除某个物理目录的季度识别
router.put('/:id/media-catalog', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面修改季度清单', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const catalog = setManualMediaCatalog(db, id, req.body ?? {})
    invalidateLibraryMatches(db)
    return res.json({
      media_catalog: catalog.entries,
      media_catalog_summary: catalog.summary,
      media_catalog_v2: catalog.canonical,
      media_catalog_candidates: catalog.candidates,
    })
  } catch (error) {
    return sendMediaCatalogError(res, error)
  }
})


// PUT /api/folders/:id/pin { pinned } — 虚拟拎出：标记为合集（侧边栏单独入口；磁盘目录不动，扫描不覆盖）
router.put('/:id/pin', (req, res) => {
  try {
    if (!isTrustedLocalMutation(req)) return res.status(403).json({ error: '仅允许从本机 AnimeShelf 页面设置合集', code: 'LOCAL_REQUEST_REQUIRED' })
    const id = Number(req.params.id)
    const pinned = req.body?.pinned ? 1 : 0
    const f = folderDb().getById(id)
    if (!f) return res.status(404).json({ error: 'not found' })
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE folders SET pinned = ?, updated_at = datetime(\'now\') WHERE id = ?').run([pinned, id])
      rebuildLibraryMediaCatalogInTransaction(db, f.library_id)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }
      throw error
    }
    invalidateLibraryMatches(db)
    res.json({ ok: true, pinned: !!pinned, name: f.name })
  } catch (e: any) {
    sendMediaCatalogError(res, e)
  }
})

export default router
