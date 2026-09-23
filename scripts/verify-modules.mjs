import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generateModules } from './modules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cases = { core: [], extension: [], full: fs.readdirSync(path.join(root, 'modules')).filter(id => fs.existsSync(path.join(root, 'modules', id, 'manifest.json'))) }
const selected = process.argv.slice(2)
const unknown = selected.filter(name => !Object.hasOwn(cases, name))
if (unknown.length) throw new Error(`Unknown verification case: ${unknown.join(', ')}. Choose: ${Object.keys(cases).join(', ')}`)
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-module-acceptance-'))
const report = { staging, cases: [] }
function run(directory, args) {
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout + result.stderr
}
async function stopWorker(worker) {
  if (worker.exitCode !== null) {
    if (worker.exitCode !== 0) throw new Error(`Backend exited with code ${worker.exitCode}`)
    return
  }
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.kill(); reject(new Error('Graceful shutdown timed out')) }, 10000)
    worker.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Backend shutdown failed: ${code}`))
    })
  })
  if (worker.connected) worker.send({ type: 'shutdown' })
  await closed
}
for (const [name, keep] of Object.entries(cases)) {
  if (selected.length && !selected.includes(name)) continue
  const directory = path.join(staging, name)
  fs.mkdirSync(directory)
  try {
    for (const source of ['server', 'src', 'shared', 'modules', 'scripts', 'public', 'electron', 'docs/module-template', 'index.html', 'package.json', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.node.json', 'vite.config.ts', 'tailwind.config.cjs', 'postcss.config.js']) {
      if (!fs.existsSync(path.join(root, source))) continue
      fs.cpSync(path.join(root, source), path.join(directory, source), { recursive: true, filter: source => !source.includes(`${path.sep}__tests__${path.sep}`) && !source.endsWith(`${path.sep}__tests__`) })
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction')
    // Delete source only in this freshly created isolated copy, never in the checkout.
    for (const id of fs.readdirSync(path.join(directory, 'modules'))) {
      const target = path.resolve(directory, 'modules', id)
      if (!target.startsWith(path.resolve(staging) + path.sep)) throw new Error('Unsafe removal target')
      if (!keep.includes(id)) fs.rmSync(target, { recursive: true, force: true })
    }
    if (name === 'extension') fs.cpSync(path.join(directory, 'docs/module-template'), path.join(directory, 'modules/sample'), { recursive: true })
    const modules = generateModules(directory)
    run(directory, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
    run(directory, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.server.json'])
    fs.writeFileSync(path.join(directory, 'build.log'), run(directory, ['node_modules/vite/bin/vite.js', 'build']) + run(directory, ['scripts/build-server.mjs']))
    const worker = spawn(process.execPath, ['-e', "const m=require('./dist-electron/server.cjs');process.on('message',async()=>{try{await m.shutdownServer();process.disconnect()}catch(e){console.error(e);process.exit(1)}})"], {
      cwd: directory, env: { ...process.env, PORT: '0', LISTEN_HOST: '127.0.0.1', ANIMESHELF_DATA_DIR: path.join(directory, 'test-data'), ANIMESHELF_DIST_DIR: path.join(directory, 'dist') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    let verified
    worker.stdout.on('data', chunk => { output += chunk })
    worker.stderr.on('data', chunk => { output += chunk })
    try {
      const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('Startup timeout: ' + output)) }, 15000)
        const poll = setInterval(() => { const match = output.match(/API running on port (\d+)/); if (match) { clearInterval(poll); clearTimeout(timeout); resolve(Number(match[1])) } }, 50)
        worker.once('exit', code => { clearInterval(poll); clearTimeout(timeout); reject(new Error('Backend exited: ' + code + '\n' + output)) })
      })
      const base = `http://127.0.0.1:${port}`
      const response = await fetch(base + '/api/modules'), snapshot = await response.json()
      if (!response.ok || snapshot.modules.length !== modules.length || snapshot.modules.some(m => !m.active)) throw new Error('Unexpected active modules: ' + JSON.stringify(snapshot))
      for (const url of ['/api/health', '/api/libraries', '/api/folders', '/api/tags', '/api/settings', '/']) if (!(await fetch(base + url)).ok) throw new Error('Core endpoint failed: ' + url)
      if (name === 'extension' && !(await fetch(base + '/api/sample')).ok) throw new Error('Extension route missing')
      if (!keep.includes('season') && (await fetch(base + '/api/season/favorites')).status !== 404) throw new Error('Removed season route is still mounted')
      verified = { name, modules: modules.map(m => m.id), typecheck: 'passed', frontendBuild: 'passed', backendBuild: 'passed', startupAndHttp: 'passed', gracefulShutdown: 'passed' }
    } finally {
      try { await stopWorker(worker) } finally { fs.writeFileSync(path.join(directory, 'runtime.log'), output) }
    }
    report.cases.push(verified)
    console.log(`${name}: type checks, frontend/backend builds, startup, HTTP and graceful shutdown passed`)
  } catch (error) {
    report.cases.push({ name, error: String(error) }); console.error(name + ': ' + error); process.exitCode = 1
  }
}
fs.writeFileSync(path.join(staging, 'report.json'), JSON.stringify(report, null, 2))
console.log('Verification report: ' + path.join(staging, 'report.json'))
