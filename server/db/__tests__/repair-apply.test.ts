import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Database } from 'node-sqlite3-wasm'
import { afterEach, expect, it } from 'vitest'
import { acquireDatabaseLease } from '../../../scripts/database-lease.cjs'

const roots: string[] = []
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
async function fixture(lossless = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-apply-')); roots.push(root)
  const dbPath = path.join(root, 'animeshelf.db'), candidate = path.join(root, 'candidate.db'), reportPath = path.join(root, 'report.json')
  for (const file of [dbPath, candidate]) {
    const lease = await acquireDatabaseLease(file)
    const db = new Database(file)
    db.exec('CREATE TABLE preserved(id INTEGER PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO preserved VALUES(7, ?)', file === dbPath ? 'current' : 'recovered')
    db.close(); await lease.release()
  }
  const report = { sourceSha256: hash(dbPath), candidateSha256: hash(candidate), candidateVerified: true, readyToApply: true, generationResetCompleted: !lossless, lossless, requiresGenerationReset: !lossless }
  fs.writeFileSync(reportPath, JSON.stringify(report))
  const { applyVerifiedCandidate, verifyRepairDatabase } = await import(pathToFileURL(path.resolve('scripts/repair-db.mjs')).href)
  return { dbPath, candidate, reportPath, report, applyVerifiedCandidate, verifyRepairDatabase }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('animeshelf-apply-')) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('preserves the original and installs only the hash-bound verified candidate', async () => {
  const fixtureState = await fixture()
  const result = await fixtureState.applyVerifiedCandidate(fixtureState)
  expect(hash(fixtureState.dbPath)).toBe(fixtureState.report.candidateSha256)
  expect(hash(result.preservedPath)).toBe(fixtureState.report.sourceSha256)
})

it('blocks a legacy wasm connection throughout candidate validation and publication', async () => {
  const state = await fixture()
  const legacy = new Database(state.dbPath)
  let checked = false
  try {
    await state.applyVerifiedCandidate({ ...state, verify(file: string) {
      expect(fs.existsSync(`${state.dbPath}.lock`)).toBe(true)
      expect(() => legacy.run("INSERT INTO preserved VALUES(8, 'unmanaged writer')")).toThrow('locked')
      legacy.close()
      checked = true
      state.verifyRepairDatabase(file)
    } })
    expect(checked).toBe(true)
    expect(fs.existsSync(`${state.dbPath}.lock`)).toBe(false)
    expect(hash(state.dbPath)).toBe(state.report.candidateSha256)
  } finally { if (legacy.isOpen) legacy.close() }
})

it('rolls back to the exact original when post-install verification fails', async () => {
  const state = await fixture()
  await expect(state.applyVerifiedCandidate({ ...state, verifyInstalled() { throw new Error('post-install failure') } })).rejects.toThrow('post-install failure')
  expect(hash(state.dbPath)).toBe(state.report.sourceSha256)
})

it('rejects source drift and unconfirmed history loss without replacing either file', async () => {
  const state = await fixture(false)
  await expect(state.applyVerifiedCandidate(state)).rejects.toThrow('同步历史')
  expect(hash(state.dbPath)).toBe(state.report.sourceSha256)
  const altered = { ...state.report, sourceSha256: '0'.repeat(64) }
  fs.writeFileSync(state.reportPath, JSON.stringify(altered))
  await expect(state.applyVerifiedCandidate({ ...state, acceptHistoryReset: true })).rejects.toThrow('预检后变化')
  expect(hash(state.dbPath)).toBe(state.report.sourceSha256)
  expect(hash(state.candidate)).toBe(state.report.candidateSha256)
})

it('does not treat SQLite integrity alone as permission to apply incomplete historical state', async () => {
  const state = await fixture(false)
  fs.writeFileSync(state.reportPath, JSON.stringify({ ...state.report, generationResetCompleted: false }))
  await expect(state.applyVerifiedCandidate({ ...state, acceptHistoryReset: true })).rejects.toThrow('尚未完成')
  expect(hash(state.dbPath)).toBe(state.report.sourceSha256)
  fs.writeFileSync(state.reportPath, JSON.stringify({ ...state.report, requiresGenerationReset: false, generationResetCompleted: false }))
  await expect(state.applyVerifiedCandidate({ ...state, acceptHistoryReset: true })).rejects.toThrow('尚未完成')
})
