import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Database } from 'node-sqlite3-wasm'
import { expect, it, vi } from 'vitest'
import { createDatabaseSnapshot, verifyDatabaseFile } from '../maintenance'

it('never publishes or overwrites a failed snapshot and leaves the source unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-snapshot-'))
  const file = path.join(root, 'input.db'), output = path.join(root, 'snapshot.db')
  let db: Database | undefined
  try {
    db = new Database(file)
    db.exec('CREATE TABLE kept(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO kept VALUES(1, \'keep\')')
    createDatabaseSnapshot(db, file, output)
    verifyDatabaseFile(output)
    const good = fs.readFileSync(output)
    expect(() => createDatabaseSnapshot(db!, file, output)).toThrow('备份文件已存在')
    expect(fs.readFileSync(output)).toEqual(good)
    db.close(); db = undefined
    const corrupt = fs.readFileSync(file)
    corrupt.fill(0, 100, 108)
    fs.writeFileSync(file, corrupt)
    expect(() => verifyDatabaseFile(file)).toThrow('数据库完整性检查失败')
    db = new Database(file)
    expect(() => createDatabaseSnapshot(db!, file, path.join(root, 'bad.db'))).toThrow()
    expect(fs.existsSync(path.join(root, 'bad.db'))).toBe(false)
    expect(fs.readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([])
    expect(fs.readFileSync(file)).toEqual(corrupt)
  } finally {
    db?.close()
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('does not publish or unlink a snapshot whose verification connection fails to close', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-snapshot-'))
  const file = path.join(root, 'input.db'), output = path.join(root, 'snapshot.db')
  const db = new Database(file)
  db.exec('CREATE TABLE kept(id INTEGER PRIMARY KEY)')
  let retained: Database | undefined
  const close = Database.prototype.close
  const spy = vi.spyOn(Database.prototype, 'close').mockImplementation(function(this: Database) {
    retained = this
    this.exec('BEGIN; SELECT * FROM kept')
    throw new Error('injected close failure')
  })
  try {
    expect(() => createDatabaseSnapshot(db, file, output)).toThrow('未能关闭')
    expect(fs.existsSync(output)).toBe(false)
    const staging = fs.readdirSync(root).find(name => name.includes('.tmp-') && !name.endsWith('.lock'))!
    expect(fs.existsSync(path.join(root, `${staging}.lock`))).toBe(true)
    expect(fs.existsSync(path.join(root, staging))).toBe(true)
  } finally {
    spy.mockRestore()
    if (retained) close.call(retained)
    db.close()
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
