import { Router } from 'express'
import type { ModuleContext, ServerModule } from '../../server/core/module-runtime'

export default function createModule(context: ModuleContext): ServerModule {
  const router = Router()
  router.get('/', (_req, res) => res.json({ module: 'sample', running: !context.signal.aborted }))
  return {
    migrations: [{ id: '001', up(db) { db.exec('CREATE TABLE IF NOT EXISTS sample_notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)') } }],
    routes: [{ path: '/api/sample', router }],
  }
}
