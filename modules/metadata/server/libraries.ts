import { Router } from 'express'
import { randomUUID } from 'crypto'
import { db } from '../../../server/db/instance'
import { makeLibraryDb } from '../../../server/db/libraries'
import { rebuildLibraryMediaCatalog, rebuildLibraryMediaCatalogInTransaction } from '../../../server/core/catalog-access'
import { invalidateLibraryMatches, moduleRuntime } from '../../../server/core/extensions'
import { assertLibraryAvailable } from '../../../server/services/library-maintenance'
import { candidateDomainEvidence, mediaDomainForLibrary, type MediaDomain } from '../../../shared/media-domain'
import { FolderScopeError, freezeFolderScope } from './folder-scope'
import { sqlAll, sqlRun } from '../../../server/db/sql'


const router = Router()

const libraryDb = () => makeLibraryDb(db)


// POST /api/libraries/:id/match-metadata — 批量绑定：对库内未绑定的系列自动搜索 AniList 并写入元数据
// 内置限速（AniList 有 rate limit，约 30 次/分钟）与 429 重试
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))


// 字幕组格式回退：[字幕组][片名][集数][字幕]...——片名通常在第二个方括号里；
// 从第二个段开始找第一个非标签段（第一个段视为压制组）
function bracketedFallback(raw: string): string {
  const segments = raw.match(/\[([^\]]*)\]/g) ?? []
  const skip = /^(?:GB|BIG5|CHS|CHT|简|繁|字幕|720|1080|480|2160|BD|BDRip|DVD|DVDRip|WebRip|HEVC|H265|H264|x264|x265|AVC|FLAC|AAC|MKV|MP4|RAW|U2|SP|OVA|OAD|NCED|OP|ED|TV|全集|特典|合集|01|02|\d{1,3}(?:-\d{1,3})?|\w+-\w+)$/i
  for (let i = 1; i < segments.length; i++) {
    const inner = segments[i].slice(1, -1).trim()
    if (inner && !skip.test(inner)) return inner
  }
  const first = segments[0]?.slice(1, -1).trim() ?? ''
  return first && !skip.test(first) ? first : ''
}


// 生成 AniList 搜索变体（AniList 搜索对带括号/混合语言/季标记的查询很挑剔，需要多级回退）：
// 1) 清洗版（去 [标签]/括号/符号/尾部年份/压制者） 2) 去季标记（S1/第一季/Season 2）
// 3) 去 Gekijouban/剧场版 前缀 4) 前两个词 5) 括号内英文名 6) 字幕组格式回退段；空变体剔除
export function searchVariants(raw: string): string[] {
  const cleaned = raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[!！?？~～·・＊*、。]/g, ' ')
    .replace(/\./g, ' ') // 点号分隔（Fate.Zero.2011 → Fate Zero 2011）
    .replace(/_/g, ' ') // 下划线分隔（Nanatsu_no_Taizai → Nanatsu no Taizai）
    .replace(/\s*-\s*[\w.]+$/g, '') // 尾部 "- 压制者"
    .replace(/\s*(?:19|20)\d{2}\s*$/g, '') // 尾部裸年份
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const variants = [cleaned]
  const noSeason = cleaned
    .replace(/\s*S\d{1,2}\s*$/i, '')
    .replace(/\s*Season\s*\d+\s*/i, ' ')
    .replace(/\s*第[一二三四五六七八九十\d]+季\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (noSeason && noSeason !== cleaned) variants.push(noSeason)
  const noGeki = (noSeason || cleaned).replace(/^(Gekijouban|Gekijoban|劇場版|剧场版)\s+/i, '')
  if (noGeki && noGeki !== (noSeason || cleaned)) variants.push(noGeki)
  const firstTwo = (noGeki || noSeason || cleaned).split(/\s+/).slice(0, 2).join(' ')
  if (firstTwo && firstTwo.length >= 2 && !variants.includes(firstTwo)) variants.push(firstTwo)
  const paren = raw.match(/\(([^)]+)\)/)?.[1]?.trim()
  if (paren && !variants.includes(paren)) variants.push(paren)
  // 括号内容（英文/日文名）位于主体清洗段之后——默认以没有被括号包裹的内容为主
  // 字幕组格式回退：仅当常规清洗无效（片名整体在方括号里）时启用，避免标签段浪费查询
  if (variants.filter(v => v && v.length >= 2).length === 0) {
    const fb = bracketedFallback(raw)
    if (fb && !variants.includes(fb)) variants.push(fb)
    const fbNoSeason = fb.replace(/\s*第[一二三四五六七八九十\d]+季\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (fbNoSeason && fbNoSeason !== fb && !variants.includes(fbNoSeason)) variants.push(fbNoSeason)
  }
  return [...new Set(variants.filter(v => v && v.length >= 2))]
}


function expectedYearFromPath(filePath: string): number | null {
  const years = filePath.match(/(?:19|20)\d{2}/g)
  return years?.length ? Number(years[years.length - 1]) : null
}


function bangumiQueries(name: string, filePath: string): string[] {
  const queries = searchVariants(name)
  const parenthesized = [...filePath.matchAll(/\(([^)]+)\)/g)].map(match => match[1].trim()).filter(Boolean)
  // 英文短标题（如 Another）容易先命中 OVA；TV 后缀可让 Bangumi 返回正片候选。
  return [...new Set([...queries, ...parenthesized, `${name} TV`].filter(query => query.length >= 2))]
}


// 匹配任务状态（后台运行，前端轮询进度）
interface MatchTask {
  jobId: string
  libraryId: number
  folderIds: number[] | null
  scopeIds: Set<number> | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  error: string | null
  finishedAt: number | null
  running: boolean
  total: number; done: number; matched: number; failed: number
  current: string; startTime: number
  reasons?: Record<string, number> // 失败原因统计
}

const matchTasks = new Map<string, MatchTask>()
const latestMatchTasks = new Map<number, string>()
const MAX_RETAINED_MATCH_TASKS = 20
let matchTaskDb: unknown

function ensureMatchTaskStore(): void {
  if (matchTaskDb === db) return
  matchTasks.clear()
  latestMatchTasks.clear()
  matchTaskDb = db
}

function publicMatchTask(task: MatchTask) {
  const { scopeIds: _scopeIds, ...publicTask } = task
  return { ...publicTask, reasons: publicTask.reasons ?? {} }
}

function rememberMatchTask(task: MatchTask): void {
  matchTasks.set(task.jobId, task)
  latestMatchTasks.set(task.libraryId, task.jobId)
  while (matchTasks.size > MAX_RETAINED_MATCH_TASKS) {
    const oldest = [...matchTasks.values()].find(candidate => !candidate.running)
    if (!oldest) break
    matchTasks.delete(oldest.jobId)
    if (latestMatchTasks.get(oldest.libraryId) === oldest.jobId) latestMatchTasks.delete(oldest.libraryId)
  }
}

function activeMatchTask(libraryId: number): MatchTask | undefined {
  return [...matchTasks.values()].find(task => task.libraryId === libraryId && task.running)
}

function matchErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error || '元数据匹配任务失败')
}

function failMatchTask(task: MatchTask, error: unknown): void {
  task.status = 'failed'
  task.error = matchErrorText(error)
  task.current = ''
}

export type MetadataMatchSource = 'auto' | 'anilist' | 'bangumi' | 'tmdb'

/** The automatic route is domain-specific; explicit source selection remains manual. */
export function metadataSourcesFor(domain: MediaDomain, source: MetadataMatchSource, libraryHint: MediaDomain = 'unknown'): Exclude<MetadataMatchSource, 'auto'>[] {
  if (source !== 'auto') return [source]
  if (domain === 'anime') return ['bangumi', 'anilist']
  if (domain === 'live_action') return ['tmdb']
  return libraryHint === 'live_action' ? ['tmdb', 'bangumi', 'anilist'] : ['bangumi', 'anilist', 'tmdb']
}


// 后台执行批量匹配（带进度更新）；自动模式按媒体域选择来源，禁止跨域静默回退。
async function runMatchTask(task: MatchTask, source: MetadataMatchSource = 'auto') {
  const libId = task.libraryId
  const lib = libraryDb().getById(libId)
  if (!lib) {
    failMatchTask(task, new Error('媒体库不存在'))
    task.running = false
    task.finishedAt = Date.now()
    return
  }
  let catalogDirty = false
  task.status = 'running'
  try {
    const {
      searchAniList, searchBangumi, getBangumiDetail, searchTMDB, getTMDBKey, getBangumiToken,
      bindAnilist, bindBangumi, bindTMDB, preferBangumiSynopsis, mergeBangumiDetail,
      folderMatchingDomain, candidateMediaDomain, pickAutomaticMetadataCandidate, getTMDBDetail,
    } = await import('./metadata')
    const tmdbKey = getTMDBKey()
    const libraryHint = mediaDomainForLibrary(lib)
    // 限速：Bangumi 有 token 时放宽到几乎不限（400/min），无 token 保持保守间隔；AniList 固定保守（无 token 机制）
    const hasBgmToken = !!getBangumiToken()
    const BGM_INTERVAL = hasBgmToken ? 200 : 1500   // 搜索变体间间隔
    const ITEM_SLEEP = hasBgmToken ? 200 : 3000     // 条目间间隔（防 AniList 429 的余量）
    const rows = sqlAll<{ id: number; name: string; path: string; source: string; anilist_id: number | null; tmdb_media_type: 'movie' | 'tv' | null; parent_name: string | null }>(db, `
      SELECT f.id, f.name, f.path, f.source, f.anilist_id, f.tmdb_media_type,
        (SELECT name FROM folders WHERE id=f.parent_id) AS parent_name FROM folders f
      WHERE f.library_id = ?
        AND (f.anilist_id IS NULL OR (f.source IN ('bangumi', 'tmdb') AND f.media_domain_evidence IS NULL))
        AND (
          -- 历史错误绑定的顶层系列可能只有子目录含视频，仍需直接纳入修复。
          (f.anilist_id IS NOT NULL AND f.media_domain_evidence IS NULL)
          OR
          -- 直接含视频的系列/子季目录
          (f.id IN (SELECT folder_id FROM files GROUP BY folder_id) AND (
            f.is_series = 1
            OR f.parent_id IN (SELECT id FROM folders WHERE library_id = ? AND is_series = 1)
          ))
          -- 主文件夹：基础文件夹（Movies/Series/TV 等）的直接子目录——中文名命中率高
          OR f.parent_id IN (
            SELECT id FROM folders WHERE library_id = ? AND name IN ('Movies','Series','TV','Drama','Anime','Movie','Animation','动画')
          )
        )
    `, [libId, libId, libId])
    const eligibleRows = task.scopeIds ? rows.filter(row => task.scopeIds!.has(row.id)) : rows
    task.total = eligibleRows.length
    const ok: string[] = []
    const failed: string[] = []
    const reasons: Record<string, number> = {}
    for (const r of eligibleRows) {
      if (moduleRuntime(db)?.aborted) break
      task.current = r.name
      // A generic season directory needs its parent title to identify a work.
      // Only season one can use the unqualified parent; later seasons retain
      // their number so they cannot silently bind the first adaptation.
      const season = r.name.match(/^(?:season\s*|s|第)(\d+)(?:季)?$/i)
      const searchName = season && r.parent_name ? `${r.parent_name}${Number(season[1]) === 1 ? '' : ` Season ${Number(season[1])}`}` : r.name
      const queries = searchVariants(searchName)
      const identityQueries = [queries[0], ...[...searchName.matchAll(/\(([^)]+)\)/g)].map(match => match[1])].filter(Boolean)
      const expectedYear = expectedYearFromPath(r.path)
      let matched = false
      let failReason = 'no-reliable-candidate'
      const mediaDomain = folderMatchingDomain(db, r.id)
      const matchSources = metadataSourcesFor(mediaDomain, source, libraryHint)
      try {
        if (r.anilist_id) {
          // Refresh a legacy binding by its exact ID, never silently rebind it
          // to a same-name adaptation just to obtain a classification.
          const evidence = r.source === 'bangumi'
            ? candidateDomainEvidence('bangumi', { ...await getBangumiDetail(r.anilist_id), bgmId: r.anilist_id })
            : r.tmdb_media_type ? (await getTMDBDetail(r.anilist_id, r.tmdb_media_type))?.domainEvidence : undefined
          if (evidence?.length) {
            const updated = sqlRun(db, "UPDATE folders SET media_domain_evidence=?, updated_at=datetime('now') WHERE id=? AND source=? AND anilist_id=? AND tmdb_media_type IS ?",
              [JSON.stringify(evidence), r.id, r.source, r.anilist_id, r.tmdb_media_type])
            matched = updated.changes > 0
          }
        } else {
          const candidates: Array<{ source: 'bangumi' | 'anilist' | 'tmdb'; candidate: any }> = []
          let inconclusive = false
          for (const candidateSource of matchSources) {
            if (candidateSource === 'tmdb' && !tmdbKey) continue
            const searchQueries = candidateSource === 'bangumi' ? bangumiQueries(searchName, r.path) : queries
            const found: any[] = []
            try {
              for (const query of searchQueries) {
                if (query !== searchQueries[0]) await sleep(candidateSource === 'bangumi' ? BGM_INTERVAL : 1000)
                const result = candidateSource === 'bangumi' ? await searchBangumi(query, { mediaDomain })
                  : candidateSource === 'anilist' ? await searchAniList(query, { mediaDomain })
                    : await searchTMDB(query, tmdbKey, { mediaDomain })
                found.push(...result)
              }
              const candidate = pickAutomaticMetadataCandidate(candidateSource, found, identityQueries, expectedYear)
              if (candidate) candidates.push({ source: candidateSource, candidate })
              else if (found.length) inconclusive = true
            } catch { failReason = `${candidateSource}-error` }
            if (mediaDomain !== 'unknown' && candidates.length) break
          }
          const domains = new Set(candidates.map(value => candidateMediaDomain(value.source, value.candidate)))
          if (domains.size === 1 && candidates.length && !(mediaDomain === 'unknown' && inconclusive)) {
            const selected = candidates[0]
            const options = { rebuildCatalog: false, automatic: true }
            if (selected.source === 'bangumi') {
              const detail = await getBangumiDetail(selected.candidate.bgmId, { expectedBangumiType: selected.candidate.type })
              await bindBangumi(r.id, mergeBangumiDetail(selected.candidate, detail), db, options)
            } else if (selected.source === 'anilist') await bindAnilist(r.id, await preferBangumiSynopsis(selected.candidate), db, options)
            else await bindTMDB(r.id, selected.candidate, db, options)
            matched = true
          } else if (inconclusive || domains.size > 1) {
            // Candidate ambiguity is insufficient identity, not a conflict
            // between two already-bound sources. Never save candidate IDs.
            sqlRun(db, "UPDATE folders SET media_domain_evidence='[]' WHERE id=? AND anilist_id IS NULL", r.id)
            catalogDirty = true
            failReason = 'ambiguous-candidates'
          }
        }
      } catch (error) { failReason = String((error as any)?.code ?? 'metadata-error') }
      if (matched) { ok.push(r.name); catalogDirty = true } else failed.push(r.name)
      if (!matched) reasons[failReason] = (reasons[failReason] ?? 0) + 1
      task.done++; task.matched = ok.length; task.failed = failed.length
      task.reasons = reasons
      // 条目间限速：仅当即将访问 AniList（无 token 机制）时需要保守；纯 Bangumi 且有 token 时几乎不限
      const willTouchAnilist = !matched && matchSources.includes('anilist')
      if (r !== eligibleRows[eligibleRows.length - 1]) await sleep(willTouchAnilist ? 3000 : ITEM_SLEEP)
    }
  } catch (e: any) {
    console.error('match task error:', e)
    failMatchTask(task, e)
  } finally {
    if (catalogDirty) {
      try {
        rebuildLibraryMediaCatalog(db, libId)
        invalidateLibraryMatches(db)
      } catch (error) {
        console.error('media catalog rebuild after metadata match failed:', error)
        failMatchTask(task, error)
      }
    }
    if (task.status === 'running') task.status = moduleRuntime(db)?.aborted ? 'cancelled' : 'completed'
    task.running = false
    task.finishedAt = Date.now()
    task.current = ''
  }
}


// POST /api/libraries/:id/match-metadata — 启动后台批量匹配（立即返回，前端轮询 /match-status 看进度）
router.post('/:id/match-metadata', async (req, res) => {
  try {
    ensureMatchTaskStore()
    const lib = libraryDb().getById(Number(req.params.id))
    if (!lib) return res.status(404).json({ error: 'library not found' })
    assertLibraryAvailable(db)
    const requestedSource = req.body?.source ?? 'auto'
    if (requestedSource !== 'auto' && requestedSource !== 'anilist' && requestedSource !== 'bangumi' && requestedSource !== 'tmdb') {
      return res.status(400).json({ error: '不支持的元数据来源' })
    }
    const scope = freezeFolderScope(db, req.body?.folderIds, { libraryId: lib.id })
    if (activeMatchTask(lib.id)) return res.status(409).json({ error: '已有匹配任务运行中', code: 'LIBRARY_BUSY' })
    const source = requestedSource as MetadataMatchSource
    const task: MatchTask = {
      jobId: randomUUID(), libraryId: lib.id, folderIds: scope?.folderIds ?? null, scopeIds: scope ? new Set(scope.descendantIds) : null,
      status: 'queued', error: null, finishedAt: null,
      running: true, total: 0, done: 0, matched: 0, failed: 0, current: '准备中…', startTime: Date.now(),
    }
    rememberMatchTask(task)
    const work = runMatchTask(task, source)
    void moduleRuntime(db)?.track(work)
    res.json({ running: true, jobId: task.jobId, folderIds: task.folderIds })
  } catch (e: any) {
    const status = e instanceof FolderScopeError ? e.status : e?.status ?? 500
    res.status(status).json({ error: e.message, code: e?.code })
  }
})


// GET /api/libraries/:id/match-status — 匹配任务进度
router.get('/:id/match-status', (req, res) => {
  try {
    ensureMatchTaskStore()
    const libraryId = Number(req.params.id)
    const requestedJobId = req.query.jobId
    let task: MatchTask | undefined
    if (requestedJobId !== undefined) {
      if (typeof requestedJobId !== 'string' || !requestedJobId) return res.status(400).json({ error: 'jobId 参数格式无效', code: 'INVALID_JOB_ID' })
      task = matchTasks.get(requestedJobId)
      if (!task || task.libraryId !== libraryId) return res.status(404).json({ error: '匹配任务不存在' })
    } else {
      const latestId = latestMatchTasks.get(libraryId)
      task = latestId ? matchTasks.get(latestId) : undefined
    }
    res.json(task ? publicMatchTask(task) : { jobId: null, folderIds: null, status: 'idle', error: null, finishedAt: null, running: false, total: 0, done: 0, matched: 0, failed: 0, current: '', startTime: 0, reasons: {} })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})




// POST /api/libraries/:id/clear-metadata — 一键清除该库全部文件夹的元数据（保留目录结构与标签）
router.post('/:id/clear-metadata', async (req, res) => {
  try {
    ensureMatchTaskStore()
    const lib = libraryDb().getById(Number(req.params.id))
    if (!lib) return res.status(404).json({ error: 'library not found' })
    assertLibraryAvailable(db)
    if (activeMatchTask(lib.id)) return res.status(409).json({ error: '已有匹配任务运行中', code: 'LIBRARY_BUSY' })
    const scope = freezeFolderScope(db, req.body?.folderIds, { libraryId: lib.id })
    const rootPlaceholders = scope ? scope.folderIds.map(() => '?').join(', ') : ''
    const updateSql = scope
      ? `WITH RECURSIVE scope_ids(id, library_id) AS (
          SELECT id, library_id FROM folders WHERE id IN (${rootPlaceholders})
          UNION ALL
          SELECT f.id, f.library_id FROM folders f JOIN scope_ids s ON f.parent_id = s.id AND f.library_id = s.library_id
        )
        UPDATE folders SET anilist_id = NULL, source = '', tmdb_media_type = NULL, rating = NULL, genres = NULL, synopsis = NULL, year = NULL, episodes = NULL, has_poster = 0, display_metadata_folder_id = NULL, media_domain_evidence = NULL
        WHERE library_id = ? AND id IN (SELECT id FROM scope_ids)`
      : `UPDATE folders SET anilist_id = NULL, source = '', tmdb_media_type = NULL, rating = NULL, genres = NULL, synopsis = NULL, year = NULL, episodes = NULL, has_poster = 0, display_metadata_folder_id = NULL, media_domain_evidence = NULL WHERE library_id = ?`
    const savepoint = 'clear_library_metadata'
    db.exec(`SAVEPOINT ${savepoint}`)
    try {
      sqlRun(db, updateSql, scope ? [...scope.folderIds, lib.id] : [lib.id])
      rebuildLibraryMediaCatalogInTransaction(db, lib.id)
      invalidateLibraryMatches(db)
      db.exec(`RELEASE ${savepoint}`)
    } catch (error) {
      try { db.exec(`ROLLBACK TO ${savepoint}`) } finally { db.exec(`RELEASE ${savepoint}`) }
      throw error
    }
    res.json({ ok: true, folderIds: scope?.folderIds ?? null })
  } catch (e: any) {
    const status = e instanceof FolderScopeError ? e.status : e?.status ?? 500
    res.status(status).json({ error: e.message, code: e?.code })
  }
})
export default router
