// Child-process fault fixture. This file is not a test entrypoint and only
// accepts the isolated paths created by folder-moves.test.ts.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDb } from '../../db/schema'
import { makeFolderDb } from '../../db/folders'
import { makeLibraryDb } from '../../db/libraries'
import { FolderMoveService } from '../folder-moves'

async function main() {
  const [mode, temporary, crossRoot] = process.argv.slice(2)
  if (!temporary || !path.basename(temporary).startsWith('animeshelf-moves-')) throw new Error('Not an isolated fixture')
  const db = createDb(path.join(temporary, 'process-crash.db'))
  if (mode === 'crash') {
    const source = path.join(temporary, 'process-source'), target = crossRoot || path.join(temporary, 'process-target')
    fs.mkdirSync(path.join(source, 'CrashShow'), { recursive: true }); fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(source, 'CrashShow', '01.mkv'), 'process-crash-video')
    const a = makeLibraryDb(db).create('Source', source, 'anime'), b = makeLibraryDb(db).create('Target', target, 'anime')
    makeFolderDb(db).upsertTree(a.id, [source, path.join(source, 'CrashShow')])
    const row = db.get('SELECT id,path FROM folders WHERE name=?', 'CrashShow') as { id: number; path: string }
    const rename = fs.promises.rename.bind(fs.promises)
    fs.promises.rename = async (from, to) => {
      await rename(from, to)
      // Exit between publication and recording its phase, not a caught error.
      if (String(to) === path.join(target, 'CrashShow')) process.exit(73)
    }
    await new FolderMoveService(db).create({ items: [{ id: row.id, expectedPath: row.path }], targetLibraryId: b.id, targetRelativePath: '' }, randomUUID())
  } else {
    const service = new FolderMoveService(db)
    await service.recover()
    const job = service.list()[0]
    if (job.items[0].phase !== 'needs_attention' || !fs.existsSync(job.items[0].targetPath)) throw new Error('Recovery mutated or lost the published tree')
    await service.reconcile(job.id)
    if (!fs.existsSync(job.items[0].sourcePath)) throw new Error('Explicit recovery did not restore source')
    await service.resume(job.id); await service.wait()
    const result = service.get(job.id)
    if (result.items[0].phase !== 'completed' || fs.readFileSync(path.join(result.items[0].targetPath, '01.mkv'), 'utf8') !== 'process-crash-video') throw new Error(JSON.stringify(result))
    if (db.all('PRAGMA foreign_key_check').length || (db.get('PRAGMA integrity_check') as any).integrity_check !== 'ok') throw new Error('Database integrity failed')
    process.stdout.write(JSON.stringify({ recovered: true, crossVolume: result.items[0].crossVolume }))
    process.exit(0)
  }
}
main().catch(error => { console.error(error); process.exit(1) })
