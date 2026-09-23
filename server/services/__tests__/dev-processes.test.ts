import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures: { root: string; child?: ChildProcess; exited?: Promise<number | null> }[] = []
const fixtureBase = path.resolve('.artifacts', 'dev-process-tests')

function fixture() {
  fs.mkdirSync(fixtureBase, { recursive: true })
  const state: typeof fixtures[number] = { root: fs.mkdtempSync(path.join(fixtureBase, 'animeshelf-dev-process-')) }
  fixtures.push(state)
  const write = (file: string, source: string) => {
    const target = path.join(state.root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  const copy = (file: string) => write(file, fs.readFileSync(file, 'utf8'))
  const run = (entry: string, env: NodeJS.ProcessEnv = {}) => {
    let output = ''
    const child = state.child = spawn(process.execPath, [entry], {
      cwd: state.root,
      env: {
        ...process.env,
        ANIMESHELF_DEV_API_PORT: '0',
        ANIMESHELF_DEV_CLIENT_PORT: '0',
        ANIMESHELF_RUNTIME_DIR: path.join(state.root, 'runtime'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    child.stdout!.on('data', chunk => { output += chunk })
    child.stderr!.on('data', chunk => { output += chunk })
    state.exited = new Promise(resolve => child.once('exit', resolve))
    return { output: () => output, exited: state.exited, stop: () => child.send('stop') }
  }
  return { ...state, write, copy, run }
}

afterEach(async () => {
  for (const state of fixtures.splice(0)) {
    if (state.child?.exitCode === null && state.child.signalCode === null) {
      // The fixture relay invokes the real script's graceful shutdown handlers,
      // including on Windows where child.kill() would bypass them.
      state.child.send('stop')
      await state.exited
    }
    const target = path.resolve(state.root)
    if (path.dirname(target) !== fixtureBase || !path.basename(target).startsWith('animeshelf-dev-process-')) {
      throw new Error('Unexpected development process fixture path')
    }
    const dependencies = path.join(target, 'node_modules')
    if (fs.existsSync(dependencies) && fs.lstatSync(dependencies).isSymbolicLink()) fs.unlinkSync(dependencies)
    fs.rmSync(target, { recursive: true, force: true })
  }
})

describe('development service processes', () => {
  it('starts the frontend only after a listening but initially unready API becomes healthy', async () => {
    const { write, copy, run } = fixture()
    copy('scripts/dev.mjs')
    copy('scripts/dev-launcher.mjs')
    copy('scripts/service-runtime.cjs')
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs', `
      import { createServer } from 'node:http'
      const readyAt = Date.now() + 400
      const server = createServer((_req, res) => {
        const ready = Date.now() >= readyAt
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: ready, instanceId: 'fixture', restartSupported: true }))
      }).listen(Number(process.env.ANIMESHELF_DEV_API_PORT), '127.0.0.1')
      process.on('message', message => {
        if (message?.type === 'shutdown') server.close(() => process.exit(0))
      })
    `)
    write('scripts/dev-server-worker.mjs', `
      fetch('http://127.0.0.1:' + process.env.ANIMESHELF_DEV_API_PORT + '/api/health')
        .then(async response => {
          console.log('FRONTEND_HEALTH=' + response.status)
          process.send?.({ type: 'service-status', clientPort: Number(process.env.ANIMESHELF_DEV_CLIENT_PORT) })
        })
        .catch(() => console.log('FRONTEND_HEALTH=unreachable'))
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(0) })
    `)
    const processResult = run('relay.mjs')
    await vi.waitFor(() => expect(processResult.output()).toContain('FRONTEND_HEALTH=200'), { timeout: 10_000 })
    processResult.stop()
    await processResult.exited
    expect(processResult.output()).toContain('FRONTEND_HEALTH=200')
    expect(processResult.output()).not.toContain('FRONTEND_HEALTH=503')
    expect(processResult.output()).not.toContain('FRONTEND_HEALTH=unreachable')
  }, 15_000)

  it('stops a pending startup without launching the frontend', async () => {
    const { write, copy, run } = fixture()
    copy('scripts/dev.mjs')
    copy('scripts/dev-launcher.mjs')
    copy('scripts/service-runtime.cjs')
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs', `
      import { createServer } from 'node:http'
      const server = createServer((_req, res) => { res.writeHead(503); res.end('{}') })
        .listen(Number(process.env.ANIMESHELF_DEV_API_PORT), '127.0.0.1', () => console.log('FIXTURE_LISTENING'))
      process.on('message', message => {
        if (message?.type === 'shutdown') server.close(() => process.exit(0))
      })
    `)
    write('scripts/dev-server-worker.mjs', "console.log('FRONTEND_STARTED')")
    const processResult = run('relay.mjs')
    await vi.waitFor(() => expect(processResult.output()).toContain('FIXTURE_LISTENING'), { timeout: 10_000 })
    processResult.stop()
    await expect(processResult.exited).resolves.toBe(0)
    expect(processResult.output()).not.toContain('FRONTEND_STARTED')
  }, 15_000)

  it('records selected dynamic ports and closes backend and Vite over IPC', async () => {
    const { root, write, copy, run } = fixture()
    copy('scripts/dev.mjs')
    copy('scripts/dev-launcher.mjs')
    copy('scripts/service-runtime.cjs')
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs', `
      import { createServer } from 'node:http'
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, instanceId: 'fixture', restartSupported: true }))
      }).listen(Number(process.env.ANIMESHELF_DEV_API_PORT), '127.0.0.1', () => {
        process.send?.({ type: 'service-status', apiPort: Number(process.env.ANIMESHELF_DEV_API_PORT) })
      })
      process.on('message', message => {
        if (message?.type === 'shutdown') {
          console.log('BACKEND_STOPPED')
          server.close(() => process.exit(0))
        }
      })
    `)
    write('scripts/dev-server-worker.mjs', `
      console.log('VITE_STARTED=' + process.env.ANIMESHELF_DEV_CLIENT_PORT)
      process.send?.({ type: 'service-status', clientPort: Number(process.env.ANIMESHELF_DEV_CLIENT_PORT) })
      process.on('message', message => {
        if (message?.type === 'shutdown') { console.log('VITE_STOPPED'); process.exit(0) }
      })
    `)
    const processResult = run('relay.mjs')
    await vi.waitFor(() => expect(processResult.output()).toContain('VITE_STARTED='), { timeout: 10_000 })
    const registryFile = fs.readdirSync(path.join(root, 'runtime')).find(name => name.endsWith('.json'))!
    const record = JSON.parse(fs.readFileSync(path.join(root, 'runtime', registryFile), 'utf8'))
    expect(record.apiPort).toBeGreaterThan(0)
    expect(record.webUrl).toBe(`http://127.0.0.1:${record.webUrl.split(':').at(-1)}`)
    expect(Number(record.webUrl.split(':').at(-1))).toBeGreaterThan(0)
    processResult.stop()
    await expect(processResult.exited).resolves.toBe(0)
    expect(processResult.output()).toContain('BACKEND_STOPPED')
    expect(processResult.output()).toContain('VITE_STOPPED')
    expect(fs.existsSync(path.join(root, 'runtime', registryFile))).toBe(false)
  }, 20_000)

  it('reports backend startup failure immediately and preserves its reason after cleanup', async () => {
    const { root, write, copy, run } = fixture()
    for (const file of ['scripts/dev.mjs', 'scripts/dev-launcher.mjs', 'scripts/service-runtime.cjs']) copy(file)
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs', `
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(0) })
      process.send?.({ type: 'startup-failed', error: '数据库锁需要停机核查', code: 'DATABASE_LOCK_UNVERIFIED' })
    `)
    write('scripts/dev-server-worker.mjs', "console.log('FRONTEND_STARTED')")
    const result = run('relay.mjs')
    const outcome = await Promise.race([result.exited, delay(8_000).then(() => 'still-waiting')])
    expect(outcome, result.output()).toBe(1)
    expect(result.output()).not.toContain('FRONTEND_STARTED')
    const registryFile = fs.readdirSync(path.join(root, 'runtime')).find(name => name.endsWith('.json'))!
    const record = JSON.parse(fs.readFileSync(path.join(root, 'runtime', registryFile), 'utf8'))
    expect(record).toMatchObject({ state: 'failed', error: '数据库锁需要停机核查' })
    expect(result.output()).not.toContain('did not become ready')
  }, 15_000)

  it('cleans up the remaining service after a child terminates unexpectedly', async () => {
    const { root, write, copy, run } = fixture()
    for (const file of ['scripts/dev.mjs', 'scripts/dev-launcher.mjs', 'scripts/service-runtime.cjs']) copy(file)
    write('relay.mjs', "setTimeout(() => process.exit(91), 3000); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs', `
      import { createServer } from 'node:http'
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, instanceId: 'fixture', restartSupported: true }))
      }).listen(Number(process.env.ANIMESHELF_DEV_API_PORT), '127.0.0.1')
      process.on('message', message => {
        if (message?.type === 'shutdown') {
          console.log('BACKEND_STOPPED_AFTER_SIGNAL')
          server.close(() => process.exit(0))
        }
      })
    `)
    write('scripts/dev-server-worker.mjs', `
      console.log('VITE_STARTED')
      process.send?.({ type: 'service-status', clientPort: Number(process.env.ANIMESHELF_DEV_CLIENT_PORT) })
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100)
    `)
    const result = run('relay.mjs')
    await vi.waitFor(() => expect(result.output()).toContain('VITE_STARTED'), { timeout: 10_000 })
    expect(await result.exited, result.output()).toBe(1)
    expect(result.output()).toContain('BACKEND_STOPPED_AFTER_SIGNAL')
    const registryFile = fs.readdirSync(path.join(root, 'runtime')).find(name => name.endsWith('.json'))!
    const record = JSON.parse(fs.readFileSync(path.join(root, 'runtime', registryFile), 'utf8'))
    expect(record).toMatchObject({ state: 'failed' })
    expect(record.error).toMatch(/client exited unexpectedly \((?:signal SIGTERM|code 1)\)/)
  }, 10_000)

  it('does not replace the backend for client edits and replaces it once for each backend or manifest change', async () => {
    const { root, write, copy, run } = fixture()
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction')
    for (const file of ['scripts/dev-server.mjs', 'scripts/dev-server-worker.mjs', 'scripts/modules.mjs', 'scripts/module-boundaries.mjs']) copy(file)
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); await import('./scripts/dev-server.mjs')")
    const manifest = { id: 'example', name: 'example', version: '1.0.0', defaultEnabled: true, requires: [], optional: [] }
    write('modules/example/manifest.json', JSON.stringify(manifest))
    write('modules/example/client.tsx', 'export default {}')
    write('modules/example/client/Page.tsx', 'export const page = 1')
    write('modules/example/shared/value.ts', 'export const value = 1')
    write('modules/example/server.ts', 'export { value as default } from "./shared/value"')
    write('server/index.ts', `
      import { manifests } from '../.generated/modules'
      import { loaders } from '../.generated/server-modules'
      void Promise.all(Object.values(loaders).map(load => load())).then(modules => {
        console.log('FIXTURE_READY=' + JSON.stringify({ name: manifests[0].name, value: modules[0].default }))
      })
      setInterval(() => {}, 1000)
    `)
    const processResult = run('relay.mjs')
    const starts = () => processResult.output().split('\n').filter(line => line.startsWith('FIXTURE_READY='))
    await vi.waitFor(() => expect(starts(), processResult.output()).toHaveLength(1), { timeout: 10_000 })
    write('modules/example/client/Page.tsx', 'export const page = 2')
    await delay(700)
    expect(starts()).toHaveLength(1)

    write('modules/example/shared/value.ts', 'export const value = 2')
    await vi.waitFor(() => expect(starts(), processResult.output()).toHaveLength(2), { timeout: 10_000 })
    await delay(700)
    expect(starts()).toHaveLength(2)
    expect(starts()[1]).toContain('"value":2')

    write('modules/example/manifest.json', JSON.stringify({ ...manifest, name: 'Updated' }))
    await vi.waitFor(() => expect(starts(), processResult.output()).toHaveLength(3), { timeout: 10_000 })
    await delay(700)
    expect(starts()).toHaveLength(3)
    expect(starts()[2]).toContain('"name":"Updated"')
  }, 30_000)

  it('stops Vite while backend shutdown is delayed and completes after the late backend exit', async () => {
    const { write, copy, run } = fixture()
    copy('scripts/dev.mjs')
    copy('scripts/dev-launcher.mjs')
    copy('scripts/service-runtime.cjs')
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); setTimeout(() => process.exit(91), 3000); await import('./scripts/dev.mjs')")
    write('scripts/dev-server.mjs',       `import { createServer } from 'node:http'
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, instanceId: 'fixture', restartSupported: true }))
      }).listen(Number(process.env.ANIMESHELF_DEV_API_PORT), '127.0.0.1')
      setTimeout(() => {
        console.log('BACKEND_LATE_EXIT')
        process.exit(0)
      }, 1000)
      process.on('message', message => {
        if (message?.type === 'shutdown') console.log('BACKEND_SHUTDOWN_REQUESTED')
      })`)
    write('scripts/dev-server-worker.mjs',       `console.log('VITE_STARTED')
      process.send?.({ type: 'service-status', clientPort: Number(process.env.ANIMESHELF_DEV_CLIENT_PORT) })
      process.on('message', message => {
        if (message?.type === 'shutdown') { console.log('VITE_STOPPED'); process.exit(0) }
      })
      process.once('disconnect', () => process.exit(0))`)
    const result = run('relay.mjs', { ANIMESHELF_DEV_CHILD_SHUTDOWN_TIMEOUT_MS: '100' })
    await vi.waitFor(() => expect(result.output()).toContain('VITE_STARTED'), { timeout: 10_000 })
    result.stop()
    expect(await result.exited, result.output()).toBe(0)
    expect(result.output()).toContain('server did not finish graceful shutdown')
    expect(result.output().indexOf('VITE_STOPPED')).toBeLessThan(result.output().indexOf('BACKEND_LATE_EXIT'))
  }, 10_000)

  it('finishes watcher cleanup when the backend exits after its graceful deadline', async () => {
    const { root, write, copy, run } = fixture()
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction')
    copy('scripts/dev-server.mjs')
    for (const file of ['scripts/modules.mjs', 'scripts/module-boundaries.mjs']) copy(file)
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); setTimeout(() => process.exit(91), 1500); await import('./scripts/dev-server.mjs')")
    write('server/index.ts', "console.log('BUNDLE_READY')")
    write('scripts/dev-server-worker.mjs',       `console.log('BACKEND_WORKER_STARTED')
      process.on('message', message => {
        if (message?.type === 'shutdown') setTimeout(() => {
          console.log('BACKEND_WORKER_LATE_EXIT')
          process.exit(0)
        }, 350)
      })
      process.once('disconnect', () => process.exit(0))`)
    const result = run('relay.mjs', { ANIMESHELF_BACKEND_SHUTDOWN_TIMEOUT_MS: '100' })
    await vi.waitFor(() => expect(result.output()).toContain('BACKEND_WORKER_STARTED'), { timeout: 10_000 })
    result.stop()
    await expect(result.exited).resolves.toBe(0)
    expect(result.output()).toContain('Backend did not finish graceful shutdown')
    expect(result.output()).toContain('BACKEND_WORKER_LATE_EXIT')
  }, 10_000)

  it('recovers the backend restart queue after one graceful replacement timeout', async () => {
    const { root, write, copy, run } = fixture()
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction')
    copy('scripts/dev-server.mjs')
    for (const file of ['scripts/modules.mjs', 'scripts/module-boundaries.mjs']) copy(file)
    write('relay.mjs', "process.on('message', () => process.emit('SIGTERM')); setTimeout(() => process.exit(91), 5000); await import('./scripts/dev-server.mjs')")
    write('server/index.ts', "export const value = 1; setInterval(() => {}, 1000)")
    write('scripts/dev-server-worker.mjs',       `import fs from 'node:fs'
      const countFile = 'worker-count.txt'
      const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1
      fs.writeFileSync(countFile, String(count))
      console.log('BACKEND_WORKER_START=' + count)
      let shutdowns = 0
      process.on('message', message => {
        if (message?.type !== 'shutdown') return
        shutdowns++
        console.log('BACKEND_WORKER_SHUTDOWN=' + count + ':' + shutdowns)
        if (count > 1 || shutdowns > 1) process.exit(0)
      })
      process.once('disconnect', () => process.exit(0))`)
    const result = run('relay.mjs', { ANIMESHELF_BACKEND_SHUTDOWN_TIMEOUT_MS: '100' })
    await vi.waitFor(() => expect(result.output()).toContain('BACKEND_WORKER_START=1'), { timeout: 10_000 })
    write('server/index.ts', "export const value = 2; setInterval(() => {}, 1000)")
    await vi.waitFor(() => expect(result.output()).toContain('BACKEND_WORKER_SHUTDOWN=1:1'), { timeout: 10_000 })
    await delay(250)
    write('server/index.ts', "export const value = 3; setInterval(() => {}, 1000)")
    await vi.waitFor(() => expect(result.output()).toContain('BACKEND_WORKER_START=2'), { timeout: 10_000 })
    result.stop()
    await expect(result.exited).resolves.toBe(0)
  }, 20_000)

})
