import { Router } from 'express'
import { spawn } from 'child_process'
import { db } from '../db/instance'
import { makeFileDb } from '../db/files'
import { validatePlayableFile } from '../services/local-files'

const router = Router()

// POST /api/play { file_id } — 服务端调用系统默认播放器打开文件（Windows start 命令）。
// 浏览器 file:// 协议受限（http 页面无法直接打开本地文件），故由本机后端代开。
router.post('/', async (req, res) => {
  try {
    const { file_id } = req.body as { file_id?: number }
    if (!file_id) return res.status(400).json({ error: 'file_id required' })
    const f = makeFileDb(db).getById(Number(file_id))
    if (!f) return res.status(404).json({ error: 'file not found' })
    const target = await validatePlayableFile(db, f.id)
    const child = spawn('cmd', ['/c', 'start', '', target], { windowsHide: true, detached: true })
    child.unref() // 不阻塞 API 响应，播放器独立进程
    res.json({ ok: true, path: f.path })
  } catch (e: any) {
    res.status(e.status ?? 500).json({ error: e.message, code: e.code })
  }
})

export default router
