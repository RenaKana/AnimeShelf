import { Router } from 'express'
import fs from 'fs'
import { db } from '../db/instance'
import { makeLibraryDb } from '../db/libraries'
import { scanLibrary } from '../services/scanner'
import { rebuildLibraryMediaCatalog } from '../core/catalog-access'
import { invalidateLibraryMatches } from '../core/extensions'
import { libraryScanCoordinator, refreshLibraryScanning } from '../services/library-scan-coordinator'
import { assertLibraryAvailable } from '../services/library-maintenance'
import { isOwnerRequest } from '../core/owner-request'
import { canonicalLibraryType } from '../db/libraries'


const router = Router()

const libraryDb = () => makeLibraryDb(db)


router.get('/', (_req, res) => {
  try { res.json(libraryDb().getAll()) } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/scan-status', (req, res) => {
  if (!isOwnerRequest(req)) return res.status(403).json({ error: '仅允许本机页面读取扫描状态', code: 'OWNER_REQUIRED' })
  res.set('Cache-Control', 'no-store').json(libraryScanCoordinator(db)?.snapshot() ?? { instanceId: 'standalone', revision: 0, libraries: [] })
})


router.post('/', (req, res) => {
  try {
    const { name, path, type, everything_url } = req.body as { name?: string; path?: string; type?: string; everything_url?: string | null }
    assertLibraryAvailable(db)
    if (!name?.trim() || !path?.trim() || !type?.trim()) return res.status(400).json({ error: 'name, path, type are required' })
    const canonicalType = canonicalLibraryType(type)
    if (!canonicalType) return res.status(400).json({ error: '媒体库类型必须是 anime 或 live_action', code: 'INVALID_LIBRARY_TYPE' })
    if (!fs.existsSync(path)) return res.status(400).json({ error: `Path not found: ${path}` })
    const lib = libraryDb().create(name.trim(), path, canonicalType, everything_url ?? null)
    refreshLibraryScanning(db)
    res.json(lib)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})


router.put('/:id', (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid library id' })
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name')
    const hasType = Object.prototype.hasOwnProperty.call(body, 'type')
    if (!hasName && !hasType) return res.status(400).json({ error: '至少需要修改媒体库名称或类型', code: 'EMPTY_LIBRARY_UPDATE' })
    if (!libraryDb().getById(id)) return res.status(404).json({ error: 'library not found' })

    const patch: { name?: string; type?: string } = {}
    if (hasName) {
      if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: '媒体库名称不能为空', code: 'INVALID_LIBRARY_NAME' })
      patch.name = body.name.trim()
    }
    if (hasType) {
      if (typeof body.type !== 'string') return res.status(400).json({ error: '媒体库类型必须是 anime 或 live_action', code: 'INVALID_LIBRARY_TYPE' })
      const canonicalType = canonicalLibraryType(body.type)
      if (!canonicalType) return res.status(400).json({ error: '媒体库类型必须是 anime 或 live_action', code: 'INVALID_LIBRARY_TYPE' })
      patch.type = canonicalType
    }

    const updated = libraryDb().update(id, patch)
    if (!updated) return res.status(404).json({ error: 'library not found' })
    res.json(updated)
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
})


router.delete('/:id', (req, res) => {
  try {
    assertLibraryAvailable(db)
    libraryDb().delete(Number(req.params.id))
    refreshLibraryScanning(db)
    invalidateLibraryMatches(db)
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})


router.post('/:id/scan', async (req, res) => {
  try {
    const lib = libraryDb().getById(Number(req.params.id))
    if (!lib) return res.status(404).json({ error: 'library not found' })
    res.json(await (libraryScanCoordinator(db)?.request(lib.id) ?? scanLibrary(lib)))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
