import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { acquireDatabaseLease } from '../../../scripts/database-lease.cjs'

const directories: string[] = []
const children: ChildProcess[] = []
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-lease-')); directories.push(root); return root }
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  }
  for (const root of directories.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('animeshelf-lease-')) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('refuses an unknown SQLite lock without removing it or taking over its ownership record', async () => {
  const file = path.join(directory(), 'animeshelf.db')
  fs.mkdirSync(`${file}.lock`)
  await expect(acquireDatabaseLease(file)).rejects.toMatchObject({ code: 'DATABASE_LOCK_UNVERIFIED' })
  expect(fs.existsSync(`${file}.lock`)).toBe(true)
  expect(fs.existsSync(`${file}.owner.json`)).toBe(false)
})

it('rejects a second process while its owner writes, and recovers only that proven dead owner after a crash', async () => {
  const root = directory(), file = path.join(root, 'animeshelf.db')
  const fixture = path.join(root, 'owner.cjs')
  fs.writeFileSync(fixture, `
    const { acquireDatabaseLease } = require(${JSON.stringify(path.resolve('scripts/database-lease.cjs'))});
    const { Database } = require(${JSON.stringify(require.resolve('node-sqlite3-wasm'))});
    (async () => {
      const lease = await acquireDatabaseLease(process.argv[2]);
      const db = new Database(process.argv[2]);
      lease.recordLock(db);
      db.exec(${JSON.stringify("CREATE TABLE kept(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO kept VALUES(1, 'preserved'); BEGIN IMMEDIATE")});
      process.send('ready');
      process.on('message', () => process.exit(0)); // simulated abrupt owner loss
    })().catch(error => { console.error(error); process.exit(1) });
  `)
  const child = spawn(process.execPath, [fixture, file], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  children.push(child)
  let childErrors = ''
  child.stderr!.on('data', chunk => { childErrors += chunk })
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Owner exited before ready (${code}): ${childErrors}`) }),
  ])
  expect(fs.existsSync(`${file}.lock`)).toBe(true)
  const bytes = fs.readFileSync(file)
  await expect(acquireDatabaseLease(file)).rejects.toMatchObject({ code: 'DATABASE_IN_USE' })
  expect(fs.existsSync(`${file}.lock`)).toBe(true)
  expect(fs.readFileSync(file)).toEqual(bytes)
  const exited = once(child, 'exit'); child.send('crash'); await exited
  const recovered = await acquireDatabaseLease(file)
  try {
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
    expect(fs.readFileSync(file)).toEqual(bytes)
  } finally { await recovered.release() }
}, 20_000)

it('allows independent databases and rejects aliases of the same database', async () => {
  const root = directory(), file = path.join(root, 'one.db')
  const first = await acquireDatabaseLease(file)
  const second = await acquireDatabaseLease(path.join(root, 'two.db'))
  try {
    const alias = process.platform === 'win32' ? file.toUpperCase() : path.join(root, '.', 'one.db')
    await expect(acquireDatabaseLease(alias)).rejects.toMatchObject({ code: 'DATABASE_IN_USE' })
  } finally { await second.release(); await first.release() }
}, 15_000)

it('never uses a closed marker to delete a later unregistered SQLite lock', async () => {
  const file = path.join(directory(), 'animeshelf.db')
  const lease = await acquireDatabaseLease(file)
  await lease.release()
  fs.mkdirSync(`${file}.lock`)
  await expect(acquireDatabaseLease(file)).rejects.toMatchObject({ code: 'DATABASE_LOCK_UNVERIFIED' })
  expect(fs.existsSync(`${file}.lock`)).toBe(true)
})
