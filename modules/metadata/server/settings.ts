import { Router } from 'express'
import { db } from '../../../server/db/instance'
import { posterRepairService, repairState, type PosterRepairJob, type PosterRepairMode } from './poster-repair'
import { freezeFolderScope, parseFolderIds } from './folder-scope'


const router = Router()


function responseJob(job: PosterRepairJob) {
  return {
    ...job,
    running: job.status === 'queued' || job.status === 'running',
    done: job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled',
    lastRun: job.finishedAt ?? 0,
  }
}

function sendError(res: any, error: any, prefix = '海报补抓失败') {
  res.status(error?.status ?? 500).json({ error: `${prefix}：${error?.message ?? String(error)}`, code: error?.code })
}

function requestedScope(req: any, form: 'body' | 'query' = 'body'): { libraryId: number | null; includeFavorites: boolean; folderIds?: number[] } {
  const raw = req.body?.libraryId ?? req.query?.libraryId
  const libraryId = raw == null || raw === '' || raw === 'all' ? null : Number(raw)
  if (libraryId != null && (!Number.isInteger(libraryId) || libraryId <= 0)) throw Object.assign(new Error('无效的媒体库'), { status: 400 })
  const rawFolderIds = form === 'query' ? req.query?.folderIds : req.body?.folderIds
  const parsedFolderIds = form === 'query' ? parseFolderIds(rawFolderIds, 'query') : rawFolderIds
  const folderIds = form === 'query' && parsedFolderIds
    ? freezeFolderScope(db, parsedFolderIds, { libraryId })?.folderIds
    : parsedFolderIds
  const requestedFavorites = req.body?.includeFavorites === true || req.query?.includeFavorites === '1'
  const includeFavorites = libraryId == null && requestedFavorites
  if (folderIds !== undefined && requestedFavorites) throw Object.assign(new Error('指定文件夹范围不能同时包含心愿单'), { status: 400, code: 'FOLDER_SCOPE_FAVORITES_CONFLICT' })
  return { libraryId, includeFavorites, ...(folderIds !== undefined ? { folderIds } : {}) }
}

// 保留原状态接口；可按 jobId 精确查看，也可按范围恢复最近一次任务。
router.get('/backups/poster-repair-status', (req, res) => {
  try {
    const service = posterRepairService()
    if (req.query.jobId) {
      const job = service.get(String(req.query.jobId))
      return job ? res.json(responseJob(job)) : res.status(404).json({ error: '海报任务不存在' })
    }
    const scope = requestedScope(req, 'query')
    const job = service.latest(scope.libraryId, scope.includeFavorites, scope.folderIds ?? null)
    const scoped = req.query.libraryId != null || req.query.includeFavorites != null || req.query.folderIds != null
    return res.json(job ? responseJob(job) : scoped ? null : repairState)
  } catch (error) { return sendError(res, error, '读取海报任务失败') }
})

// 无请求体时兼容原设置入口：全部媒体库 + 心愿单，只补缺失海报。
router.post('/repair-posters', (req, res) => {
  try {
    const hasExplicitScope = req.body && Object.keys(req.body).length > 0
    const scope = hasExplicitScope ? requestedScope(req, 'body') : { libraryId: null, includeFavorites: true }
    const mode = String(req.body?.mode ?? 'missing') as PosterRepairMode
    const job = posterRepairService().start({ ...scope, mode })
    res.status(202).json({ ok: true, jobId: job.jobId, job: responseJob(job) })
  } catch (error) { sendError(res, error) }
})

router.post('/repair-posters/:jobId/retry', (req, res) => {
  try {
    const job = posterRepairService().retry(String(req.params.jobId))
    res.status(202).json({ ok: true, jobId: job.jobId, job: responseJob(job) })
  } catch (error) { sendError(res, error, '重试海报任务失败') }
})

export default router
