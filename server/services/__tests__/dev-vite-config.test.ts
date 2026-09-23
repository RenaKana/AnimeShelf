import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, optimizeDeps, resolveConfig, type UserConfig } from 'vite'
import desktopConfig from '../../../vite.config'

const fixtures: string[] = []
const scenarios = [
  { name: 'desktop', config: desktopConfig as UserConfig, generatedDirectories: ['mobile/.toolchain/docs', 'mobile/android/app/build/assets', 'data/test-copy', '.artifacts/preview', 'release/old-build'] },
]

function writeFixtureFile(root: string, name: string, content: string) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createFixture(generatedDirectories: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-vite-scope-'))
  fixtures.push(root)
  writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'vite-scope-fixture', type: 'module' }))
  for (const name of ['fixture-app-dependency', 'fixture-generated-dependency']) {
    writeFixtureFile(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }))
    writeFixtureFile(root, `node_modules/${name}/index.js`, 'export default "fixture"')
  }
  writeFixtureFile(root, 'index.html', '<script type="module" src="/main.js"></script>')
  writeFixtureFile(root, 'main.js', 'import value from "fixture-app-dependency"; console.log(value)')
  for (const directory of generatedDirectories) {
    writeFixtureFile(root, `${directory}/index.html`, '<script type="module">import value from "fixture-generated-dependency"; console.log(value)</script>')
  }
  return root
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('animeshelf-vite-scope-')) {
      throw new Error('Refusing to remove a directory outside the Vite test fixtures')
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

it('binds the desktop development frontend to the registered IPv4 loopback address', () => {
  expect((desktopConfig as UserConfig).server?.host).toBe('127.0.0.1')
})

describe('Vite application entry discovery', () => {
  it.each(scenarios)('$name does not prebundle dependencies from generated HTML', async ({ config, generatedDirectories }) => {
    const root = createFixture(generatedDirectories)
    const resolved = await resolveConfig({
      configFile: false,
      root,
      logLevel: 'silent',
      optimizeDeps: config.optimizeDeps,
    }, 'serve')
    const metadata = await optimizeDeps(resolved, true)
    expect(Object.keys(metadata.optimized)).toEqual(['fixture-app-dependency'])
  }, 30_000)

  it.each(scenarios)('$name watches application sources without traversing generated trees', async ({ config, generatedDirectories }) => {
    const root = createFixture(generatedDirectories)
    const sourceDirectories = ['src', 'modules/example', '.generated', 'shared']
    for (const directory of sourceDirectories) writeFixtureFile(root, `${directory}/fixture.ts`, 'export const value = 1')
    let watchReady: Promise<void> = Promise.resolve()
    const server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: config.server?.watch },
      plugins: [{
        name: 'fixture-watch-ready',
        enforce: 'pre',
        configureServer(server) {
          watchReady = new Promise(resolve => server.watcher.once('ready', resolve))
        },
      }],
    })
    try {
      await watchReady
      // Windows may emit ready before all of the initial recursive adds settle.
      await vi.waitFor(() => {
        const directories = Object.keys(server.watcher.getWatched()).map(directory => path.relative(root, directory).replace(/\\/g, '/'))
        for (const directory of sourceDirectories) expect(directories).toContain(directory)
      }, { timeout: 10_000, interval: 20 })
      const watched = Object.keys(server.watcher.getWatched()).map(directory => path.relative(root, directory).replace(/\\/g, '/'))
      for (const directory of generatedDirectories) expect(watched).not.toContain(directory)
    } finally {
      await server.close()
    }
  }, 30_000)
})
