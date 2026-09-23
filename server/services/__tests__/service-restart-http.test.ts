import { it, expect } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'node-sqlite3-wasm'
import { manifests } from '../../../.generated/modules'

it('restarts the built web service twice on the same port, applies module switches and preserves stored data', async () => {
  const generated = path.resolve('.generated')
  fs.mkdirSync(generated, { recursive: true })
  const directory = fs.mkdtempSync(path.join(generated, 'restart-http-'))
  const dataDir = path.join(directory, 'data')
  fs.mkdirSync(dataDir)
  const seed = new Database(path.join(dataDir, 'animeshelf.db'))
  seed.exec('CREATE TABLE module_config(module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
  for (const manifest of manifests) {
    const statement = seed.prepare('INSERT INTO module_config VALUES (?, ?)')
    try { statement.run([manifest.id, manifest.id === 'wallpapers' ? 1 : 0]) }
    finally { statement.finalize() }
  }
  seed.close()
  const bundle = path.join(directory, 'server.cjs')
  await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', packages: 'external', outfile: bundle, logLevel: 'silent' })
  const worker = spawn(process.execPath, ['-e', `const host=require(${JSON.stringify(bundle)});process.on('message',async()=>{try{await host.shutdownServer();process.disconnect()}catch(error){console.error(error);process.exit(1)}})`], {
    env: { ...process.env, PORT: '0', LISTEN_HOST: '127.0.0.1', ANIMESHELF_DATA_DIR: dataDir, ANIMESHELF_DIST_DIR: directory },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  worker.stdout!.on('data', chunk => { output += chunk })
  worker.stderr!.on('data', chunk => { output += chunk })
  const exited = new Promise<number | null>(resolve => worker.once('exit', resolve))
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  try {
    const deadline = Date.now() + 15_000
    while (!/API running on port (\d+)/.test(output) && Date.now() < deadline && worker.exitCode === null) await pause()
    const port = output.match(/API running on port (\d+)/)?.[1]
    expect(port, output).toBeTruthy()
    const base = `http://127.0.0.1:${port}`
    const get = (url: string) => fetch(base + url, { signal: AbortSignal.timeout(2000) })
    const send = (url: string, method: string, body?: object) => fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000),
    })
    expect((await send('/api/libraries', 'POST', { name: 'Restart test library', path: dataDir, type: 'anime' })).ok).toBe(true)
    expect((await send('/api/settings', 'PUT', { player_path: 'restart-preserved-player' })).ok).toBe(true)
    let health = await (await get('/api/health')).json()
    expect(health).toMatchObject({ ok: true, instanceId: expect.any(String), restartSupported: true })
    const identities = new Set([health.instanceId])
    for (const enabled of [false, true]) {
      const configured = await send('/api/modules', 'PATCH', { enabled: { wallpapers: enabled } })
      expect(await configured.json()).toMatchObject({ restartRequired: true })
      expect((await get('/api/wallpapers')).status).toBe(enabled ? 404 : 200)
      const acknowledged = await send('/api/service/restart', 'POST')
      expect(acknowledged.status).toBe(202)
      expect(await acknowledged.json()).toMatchObject({ instanceId: health.instanceId })
      const restartingUntil = Date.now() + 15_000
      let next = health
      while (Date.now() < restartingUntil && next.instanceId === health.instanceId) {
        await pause()
        try {
          const response = await get('/api/health')
          if (response.ok) next = await response.json()
        } catch { /* Listener can briefly close while the application drains. */ }
      }
      expect(next.instanceId, output).not.toBe(health.instanceId)
      expect(identities.has(next.instanceId)).toBe(false)
      identities.add(next.instanceId)
      health = next
      const snapshot = await (await get('/api/modules')).json()
      expect(snapshot.restartRequired).toBe(false)
      expect(snapshot.modules.find((module: { id: string }) => module.id === 'wallpapers')).toMatchObject({ active: enabled, configuredEnabled: enabled })
      expect((await get('/api/wallpapers')).status).toBe(enabled ? 200 : 404)
      expect(await (await get('/api/libraries')).json()).toEqual([expect.objectContaining({ name: 'Restart test library' })])
      expect(await (await get('/api/settings')).json()).toMatchObject({ player_path: 'restart-preserved-player' })
      expect(worker.exitCode).toBeNull()
    }
  } finally {
    if (worker.connected) worker.send({ type: 'shutdown' })
    const timeout = setTimeout(() => worker.kill(), 10_000)
    try { expect(await exited, output).toBe(0) }
    finally {
      clearTimeout(timeout)
      if (!directory.startsWith(generated + path.sep)) throw new Error('Unsafe restart test cleanup path')
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}, 45_000)
