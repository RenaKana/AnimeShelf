import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it('clears the owned application database cache so a closed database can be reopened', async () => {
  const tempRoot = path.resolve(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempRoot, 'animeshelf-app-db-'))
  vi.stubEnv('ANIMESHELF_DATA_DIR', directory)
  vi.resetModules()
  const { closeAppDb, openAppDb } = await import('../schema')
  let database: Awaited<ReturnType<typeof openAppDb>> | undefined
  try {
    const first = database = await openAppDb()
    first.prepare("INSERT INTO settings(key, value) VALUES ('restart-test', 'preserved')").run()
    vi.spyOn(first, 'close').mockImplementationOnce(() => { throw new Error('database is still busy') })
    await expect(closeAppDb(first)).rejects.toThrow('database is still busy')
    expect(await openAppDb()).toBe(first)
    await closeAppDb(first)

    const reopened = database = await openAppDb()
    expect(reopened).not.toBe(first)
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'restart-test'").get()).toEqual({ value: 'preserved' })
  } finally {
    if (database) await closeAppDb(database)
    if (!path.resolve(directory).startsWith(tempRoot + path.sep)) throw new Error('Unsafe test cleanup path')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('shares a single pending initialization and rejects a corrupt database before schema writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-app-db-'))
  vi.stubEnv('ANIMESHELF_DATA_DIR', directory)
  vi.resetModules()
  const { openAppDb, closeAppDb } = await import('../schema')
  try {
    const [one, two] = await Promise.all([openAppDb(), openAppDb()])
    expect(one).toBe(two)
    await closeAppDb(one)
    const file = path.join(directory, 'animeshelf.db')
    const corrupt = fs.readFileSync(file)
    corrupt.fill(0, 100, 108)
    fs.writeFileSync(file, corrupt)
    await expect(openAppDb()).rejects.toMatchObject({ code: 'DATABASE_INTEGRITY_FAILED' })
    expect(fs.readFileSync(file)).toEqual(corrupt)
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
