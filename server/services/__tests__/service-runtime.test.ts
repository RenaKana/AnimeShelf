import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  archiveInstance,
  forceInstance,
  listInstances,
  startInstance,
  stopInstance,
  validateManagedRecord,
} from '../../../scripts/service-manager.mjs'

const require = createRequire(import.meta.url)
const runtime = require('../../../scripts/service-runtime.cjs')
const roots: string[] = []
const services: Array<{ close(options?: { remove?: boolean }): Promise<void> }> = []

function isolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-runtime-test-'))
  roots.push(root)
  return { ...process.env, ANIMESHELF_RUNTIME_DIR: path.join(root, 'run') }
}

function request(port: number, route: string, options: { token?: string; host?: string; origin?: string } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}` }
    if (options.token) headers[runtime.CONTROL_HEADER] = options.token
    if (options.origin !== undefined) headers.Origin = options.origin
    const req = http.request({ host: '127.0.0.1', port, path: route, method: route === '/stop' ? 'POST' : 'GET', headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.once('error', reject)
    req.end()
  })
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => {})
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('managed service control runtime', () => {
  it('authenticates loopback control without exposing the token', async () => {
    const env = isolatedEnv()
    const token = 'fixture-token-with-at-least-thirty-two-characters'
    let stopRequested = false
    const service = await runtime.createServiceRuntime({
      env,
      token,
      identity: 'fixture-process-identity',
      projectDir: process.cwd(),
      dataDir: path.join(roots[0], 'data'),
      onStop: () => { stopRequested = true },
    })
    services.push(service)
    expect(service.controlPort).toBeGreaterThan(0)

    await expect(request(service.controlPort, '/status')).resolves.toMatchObject({ status: 401 })
    await expect(request(service.controlPort, '/status', { token, host: `example.com:${service.controlPort}` })).resolves.toMatchObject({ status: 403 })
    await expect(request(service.controlPort, '/status', { token, origin: 'http://127.0.0.1' })).resolves.toMatchObject({ status: 403 })
    const status = await request(service.controlPort, '/status', { token })
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ id: service.id, identity: 'fixture-process-identity', managed: true })
    expect(JSON.stringify(status.body)).not.toContain(token)

    await expect(request(service.controlPort, '/stop', { token })).resolves.toMatchObject({ status: 202, body: { status: 'stopping' } })
    await vi.waitFor(() => expect(stopRequested).toBe(true))
    expect(service.status().state).toBe('stopping')
  })

  it('lists only a sanitized authenticated record', async () => {
    const env = isolatedEnv()
    const identity = 'known-creation-identity'
    const token = 'another-fixture-token-with-enough-characters'
    const packagedProject = path.join(roots[0], 'portable-install')
    const service = await runtime.createServiceRuntime({ env, token, identity, projectDir: packagedProject, dataDir: path.join(roots[0], 'data') })
    services.push(service)
    service.update({ state: 'running', apiPort: 32123, webUrl: 'http://127.0.0.1:41234' })
    const records = runtime.readRegistryRecords(env)
    const result = await listInstances(process.cwd(), {
      records,
      snapshot: { processes: [], listeners: [] },
      getIdentity: () => identity,
    })
    expect(result.instances).toHaveLength(1)
    expect(result.instances[0]).toMatchObject({ id: service.id, state: 'running', apiPort: 32123, managed: true, canStop: true })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('control')
  })

  it('treats PID reuse as unknown without contacting the recorded endpoint', async () => {
    const controlRequest = vi.fn()
    const record = {
      id: 'fixture-record', kind: 'dev', state: 'running', pid: 1234, identity: '1234:old',
      projectDir: process.cwd(), dataDir: path.resolve('fixture-data'), control: { host: '127.0.0.1', port: 43210, token: 'x'.repeat(32) },
    }
    const status = await validateManagedRecord(record, { getIdentity: () => '1234:new', controlRequest })
    expect(status).toMatchObject({ state: 'unknown', canStop: false, error: 'Process identity changed' })
    expect(controlRequest).not.toHaveBeenCalled()
  })

  it.each([
    [null, false, 'exited', true],
    ['1234:new', true, 'reused', true],
    [null, true, 'unverified', false],
    [null, null, 'unverified', false],
  ])('distinguishes missing, reused and unreadable processes (%s, %s)', async (identity, presence, processState, canRemove) => {
    const controlRequest = vi.fn()
    const result = await validateManagedRecord({
      id: 'dead-record', kind: 'dev', state: 'failed', pid: 1234, identity: '1234:old',
      error: 'original startup error', webUrl: 'http://127.0.0.1:5173', apiPort: 3002,
    }, { getIdentity: () => identity, getPresence: () => presence, controlRequest })
    expect(result).toMatchObject({ processState, canRemove, canForce: false, canStop: false,
      identityVerified: false, webUrl: null, apiPort: null, error: 'original startup error' })
    expect(controlRequest).not.toHaveBeenCalled()
  })

  it('allows explicit force for a verified live managed process with broken control', async () => {
    const result = await validateManagedRecord({
      id: 'live-record', state: 'running', pid: 1234, identity: '1234:old',
      control: { host: '127.0.0.1', port: 43210, token: 'x'.repeat(32) },
    }, { getIdentity: () => '1234:old', controlRequest: async () => { throw new Error('connection refused') } })
    expect(result).toMatchObject({ state: 'unknown', processState: 'alive', identityVerified: true,
      canStop: false, canRemove: false, canForce: true })
  })

  it('archives an exited registration while preserving its log and never calling control', async () => {
    const env = isolatedEnv()
    const logPath = path.join(roots[0], 'failed.log')
    fs.writeFileSync(logPath, 'original startup error')
    const record = { id: 'archive-dead', pid: 1234, identity: '1234:old', state: 'failed',
      projectDir: process.cwd(), logPath, error: 'original startup error' }
    runtime.writeRegistryRecord(record, env)
    const result = await archiveInstance(record.id, { env, getIdentity: () => null, getPresence: () => false })
    expect(result.status).toBe('archived')
    expect(runtime.readRegistryRecords(env)).toHaveLength(0)
    expect(JSON.parse(fs.readFileSync(result.archivePath, 'utf8'))).toEqual(record)
    expect(fs.readFileSync(logPath, 'utf8')).toBe('original startup error')
  })

  it.each(['1234:old', null])('refuses to archive a live or unverifiable owner (%s)', async identity => {
    const env = isolatedEnv()
    runtime.writeRegistryRecord({ id: 'archive-live', pid: 1234, identity: '1234:old' }, env)
    await expect(archiveInstance('archive-live', { env, getIdentity: () => identity, getPresence: () => true })).rejects.toThrow()
    expect(runtime.readRegistryRecords(env)).toHaveLength(1)
  })

  it('refuses to archive a record changed during process verification', async () => {
    const env = isolatedEnv()
    const record = { id: 'archive-race', pid: 1234, identity: '1234:old' }
    runtime.writeRegistryRecord(record, env)
    await expect(archiveInstance(record.id, { env, getPresence: () => false, getIdentity: () => {
      runtime.writeRegistryRecord({ ...record, pid: 5678, identity: '5678:new' }, env)
      return null
    } })).rejects.toThrow('changed')
    expect(runtime.readRegistryRecords(env)[0].pid).toBe(5678)
  })

  it('archives only the old registration after PID reuse', async () => {
    const env = isolatedEnv()
    runtime.writeRegistryRecord({ id: 'archive-reused', pid: 1234, identity: '1234:old' }, env)
    const result = await archiveInstance('archive-reused', { env, getIdentity: () => '1234:new' })
    expect(result.status).toBe('archived')
    expect(runtime.readRegistryRecords(env)).toHaveLength(0)
  })

  it('does not send shutdown to an exited instance or its old control address', async () => {
    const env = isolatedEnv()
    runtime.writeRegistryRecord({ id: 'stop-exited', pid: 1234, identity: '1234:old' }, env)
    const controlRequest = vi.fn()
    await expect(stopInstance('stop-exited', process.cwd(), {
      env, getIdentity: () => null, getPresence: () => false, controlRequest,
    })).resolves.toMatchObject({ status: 'exited', canRemove: true })
    expect(controlRequest).not.toHaveBeenCalled()
  })

  it('returns the known same-data instance under the start lock', async () => {
    const env = isolatedEnv()
    const dataDir = path.join(roots[0], 'library-data')
    const spawnImpl = vi.fn(() => { throw new Error('must not spawn') })
    const result = await startInstance(process.cwd(), dataDir, {
      env,
      spawnImpl: spawnImpl as never,
      list: async () => ({ instances: [{
        id: 'existing-instance', kind: 'dev', state: 'running', dataDir,
        managed: true, pid: 1, identity: '1:birth',
      }] as any[] }),
    })
    expect(result).toEqual({ instanceId: 'existing-instance', existing: true })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('blocks a duplicate when a live failed managed owner still holds the data directory', async () => {
    const env = isolatedEnv()
    const dataDir = path.join(roots[0], 'held-data')
    const identity = runtime.getProcessIdentity(process.pid)
    const spawnImpl = vi.fn(() => { throw new Error('must not spawn') })
    const result = await startInstance(process.cwd(), dataDir, {
      env,
      spawnImpl: spawnImpl as never,
      list: async () => ({ instances: [{
        id: 'failed-owner', kind: 'dev', state: 'failed', dataDir,
        managed: true, pid: process.pid, identity,
      }] as any[] }),
    })
    expect(result).toEqual({ instanceId: 'failed-owner', existing: true })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('does not overwrite a control record published by a fast child', async () => {
    const env = isolatedEnv()
    const identity = runtime.getProcessIdentity(process.pid)
    const dataDir = path.join(roots[0], 'race-data')
    const spawnImpl = vi.fn((_file: string, _args: string[], options: any) => {
      const now = new Date().toISOString()
      runtime.writeRegistryRecord({
        version: 1,
        id: options.env.ANIMESHELF_INSTANCE_ID,
        kind: 'dev',
        state: 'running',
        pid: process.pid,
        identity,
        projectDir: process.cwd(),
        projectKey: runtime.normalizePath(process.cwd()),
        dataDir,
        dataKey: runtime.normalizePath(dataDir),
        webUrl: 'http://127.0.0.1:40123',
        apiPort: 30123,
        logPath: options.env.ANIMESHELF_SERVICE_LOG,
        error: null,
        startedAt: now,
        updatedAt: now,
        control: { host: '127.0.0.1', port: 45123, token: options.env.ANIMESHELF_CONTROL_TOKEN },
      }, env)
      return { pid: process.pid, unref: vi.fn() }
    })
    const result = await startInstance(process.cwd(), dataDir, {
      env,
      spawnImpl: spawnImpl as never,
      list: async () => ({ instances: [] }),
    })
    const record = runtime.readRegistryRecords(env).find((item: any) => item.id === result.instanceId)
    expect(record).toMatchObject({ state: 'running', apiPort: 30123, control: { port: 45123 } })
  })

  it('reclaims a start lock only after its recorded owner identity is dead', async () => {
    const env = isolatedEnv()
    const dataDir = path.join(roots[0], 'stale-lock-data')
    const runDir = runtime.ensureRuntimeDir(env)
    const key = crypto.createHash('sha256').update(runtime.normalizePath(dataDir)).digest('hex')
    const lockPath = path.join(runDir, `start-${key}.lock`)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483000, identity: '2147483000:old', token: 'stale' }))
    const result = await startInstance(process.cwd(), dataDir, {
      env,
      list: async () => ({ instances: [{ id: 'existing-after-lock', state: 'running', dataDir, managed: true }] as any[] }),
    })
    expect(result).toEqual({ instanceId: 'existing-after-lock', existing: true })
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('does not claim stopped when the registry disappears but the original PID remains', async () => {
    const env = isolatedEnv()
    const projectDir = process.cwd()
    const id = 'stop-fixture'
    const identity = '5555:birth'
    const record = {
      id, kind: 'dev', state: 'running', pid: 5555, identity,
      projectDir, projectKey: runtime.normalizePath(projectDir), dataDir: path.join(roots[0], 'data'),
      control: { host: '127.0.0.1', port: 45000, token: 't'.repeat(32) },
    }
    runtime.writeRegistryRecord(record, env)
    const controlRequest = vi.fn(async (_record: any, method: string) => {
      if (method === 'GET') return { ...runtime.publicRecord(record), id, pid: 5555, identity }
      runtime.removeRegistryRecord(id, env)
      return { status: 'stopping' }
    })
    const result = await stopInstance(id, projectDir, {
      env,
      getIdentity: () => identity,
      controlRequest,
      timeoutMs: 20,
      pollMs: 5,
    })
    expect(result).toMatchObject({ status: 'stopping', requiresForce: true })
  })

  it('refuses force stop when the PID creation identity changed', async () => {
    const env = isolatedEnv()
    const projectDir = process.cwd()
    runtime.writeRegistryRecord({
      id: 'force-fixture', kind: 'dev', state: 'unknown', pid: 9876, identity: '9876:old',
      projectDir, projectKey: runtime.normalizePath(projectDir), dataDir: path.join(roots[0], 'data'),
      control: null,
    }, env)
    const stopProcess = vi.fn()
    await expect(forceInstance('force-fixture', '9876:old', projectDir, {
      env,
      getIdentity: () => '9876:new',
      stopProcess,
    })).rejects.toThrow('creation identity changed')
    expect(stopProcess).not.toHaveBeenCalled()
  })

  it('stops the backend watcher before workers and the dev root last during force', async () => {
    const env = isolatedEnv()
    const projectDir = process.cwd()
    runtime.writeRegistryRecord({
      id: 'force-order', kind: 'dev', state: 'failed', pid: 100, identity: '100:root',
      projectDir, projectKey: runtime.normalizePath(projectDir), dataDir: path.join(roots[0], 'data'),
      control: null,
    }, env)
    const snapshot = {
      ancestryAvailable: true,
      listeners: [],
      processes: [
        { pid: 100, parentPid: 50, identity: '100:root', commandLine: 'node scripts/dev.mjs' },
        { pid: 101, parentPid: 100, identity: '101:watcher', commandLine: 'node scripts/dev-server.mjs' },
        { pid: 102, parentPid: 101, identity: '102:backend', commandLine: 'node scripts/dev-server-worker.mjs bundle.cjs' },
        { pid: 103, parentPid: 100, identity: '103:vite', commandLine: 'node scripts/dev-server-worker.mjs --vite' },
      ],
    }
    const stopped: number[] = []
    const result = await forceInstance('force-order', '100:root', projectDir, {
      env,
      getIdentity: () => '100:root',
      snapshotProcesses: () => snapshot,
      stopProcess: (pid: number) => { stopped.push(pid); return true },
    })
    expect(result).toEqual({ status: 'stopped' })
    expect(stopped[0]).toBe(101)
    expect(stopped[stopped.length - 1]).toBe(100)
    expect(stopped).toEqual(expect.arrayContaining([102, 103]))
  })
})
