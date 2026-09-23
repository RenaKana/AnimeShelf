import { Router } from 'express'
import { db } from '../db/instance'
import { makeTagDb } from '../db/tags'
import { assertLibraryAvailable } from '../services/library-maintenance'

const router = Router()
const tagDb = () => makeTagDb(db)

router.get('/', (_req, res) => { try { res.json(tagDb().list()) } catch (e: any) { res.status(500).json({ error: e.message }) } })
router.post('/', (req, res) => {
  try {
    const { name, color } = req.body as { name: string; color?: string }
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    if (tagDb().list().some(t => t.name === name.trim())) return res.status(400).json({ error: 'tag exists' })
    res.json(tagDb().create(name.trim(), color))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
router.patch('/:id', (req, res) => {
  try {
    const { name, color } = req.body as { name?: string; color?: string }
    // name 提供时须为非空（trim 后），防止把 system 标签名清空（T3-M1）
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' })
    res.json(tagDb().update(Number(req.params.id), { name, color }))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
router.delete('/:id', (req, res) => {
  try { tagDb().delete(Number(req.params.id)); res.json({ ok: true }) } catch (e: any) { res.status(400).json({ error: e.message }) }
})
router.post('/link', (req, res) => {
  try {
    assertLibraryAvailable(db)
    const { tag_id, target_type, target_id } = req.body as { tag_id: number; target_type: 'folder' | 'file'; target_id: number }
    if (!['folder', 'file'].includes(target_type) || !Number.isSafeInteger(target_id) || target_id <= 0) return res.status(400).json({ error: '无效的标签目标' })
    if (!db.get(`SELECT id FROM ${target_type === 'folder' ? 'folders' : 'files'} WHERE id=?`, target_id)) return res.status(404).json({ error: '条目已不存在，请刷新后重试' })
    tagDb().link(tag_id, target_type, target_id)
    res.json({ ok: true })
  } catch (e: any) { res.status(Number(e.status) || 500).json({ error: e.message }) }
})
router.delete('/link/:id', (req, res) => {
  try { tagDb().unlink(Number(req.params.id)); res.json({ ok: true }) } catch (e: any) { res.status(500).json({ error: e.message }) }
})
router.delete('/target/:tagId', (req, res) => {
  try {
    const { target_type, target_id } = req.query as { target_type: 'folder' | 'file'; target_id: string }
    tagDb().unlinkByTarget(Number(req.params.tagId), target_type, Number(target_id))
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
router.get('/effective', (req, res) => {
  try {
    const { target_type, target_id } = req.query as { target_type: 'folder' | 'file'; target_id: string }
    res.json(tagDb().effectiveTags(target_type, Number(target_id)))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export default router
