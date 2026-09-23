import { Router } from 'express'
import { db } from '../db/instance'
import { makeFileDb } from '../db/files'
import { makeFolderDb } from '../db/folders'
import { makeTagDb } from '../db/tags'
import { publicPersistenceRecord } from '../services/folder-presentation'

const router = Router()

router.get('/:id', (req, res) => {
  try {
    const file = makeFileDb(db).getById(Number(req.params.id))
    if (!file) return res.status(404).json({ error: 'not found' })
    const folder = makeFolderDb(db).getById(file.folder_id) ?? null
    res.json({
      ...publicPersistenceRecord(file),
      tags: makeTagDb(db).effectiveTags('file', file.id),
      folder: folder ? publicPersistenceRecord(folder) : null,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
