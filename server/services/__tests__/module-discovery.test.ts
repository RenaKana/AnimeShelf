import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverModules, generateModules } from '../../../scripts/modules.mjs'

function fixture(run: (root: string, add: (id: string, patch?: object) => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-modules-'))
  const add = (id: string, patch = {}) => {
    const dir = path.join(root, 'modules', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', defaultEnabled: true, requires: [], optional: [], ...patch }))
    fs.writeFileSync(path.join(dir, 'client.tsx'), 'export default {}')
    fs.writeFileSync(path.join(dir, 'server.ts'), 'export default () => ({})')
  }
  try { run(root, add) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

describe('source module discovery', () => {
  it('rejects core routes, wildcard collisions, duplicate pages and optional source imports', () => fixture((root, add) => {
    add('one', { routes: [{ method: 'GET', path: '/api/modules' }] })
    expect(() => discoverModules(root)).toThrow(/core/i)
    add('one', { routes: [{ method: 'ALL', path: '/api/items' }] })
    add('two', { routes: [{ method: 'GET', path: '/api/items' }] })
    expect(() => discoverModules(root)).toThrow(/conflict/i)
    add('one', { pages: ['/same'] }); add('two', { pages: ['/same'] })
    expect(() => discoverModules(root)).toThrow(/page/i)
    add('one'); add('two')
    fs.writeFileSync(path.join(root, 'modules/one/server.ts'), "import '../two/server'; export default () => ({})")
    expect(() => generateModules(root)).toThrow(/required dependency/i)
  }))
  it('discovers only modules present on disk in dependency order', () => fixture((root, add) => {
    add('consumer', { requires: ['provider'] }); add('provider')
    expect(discoverModules(root).map((m: any) => m.id)).toEqual(['provider', 'consumer'])
    fs.rmSync(path.join(root, 'modules', 'consumer'), { recursive: true })
    expect(discoverModules(root).map((m: any) => m.id)).toEqual(['provider'])
  }))
  it('rejects missing required dependencies and cycles', () => fixture((root, add) => {
    add('consumer', { requires: ['provider'] })
    expect(() => discoverModules(root)).toThrow(/provider/)
    add('provider', { requires: ['consumer'] })
    expect(() => discoverModules(root)).toThrow(/cycle/i)
  }))
  it('rejects duplicate IDs and equivalent parameter routes', () => fixture((root, add) => {
    add('one', { routes: [{ method: 'GET', path: '/api/items/:id' }] })
    add('two', { routes: [{ method: 'GET', path: '/api/items/:other' }] })
    expect(() => discoverModules(root)).toThrow(/route/i)
    add('two', { id: 'one' })
    expect(() => discoverModules(root)).toThrow(/id/i)
  }))
  it('rejects patterned routes that can shadow a core endpoint', () => fixture((root, add) => {
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(root, 'shared', 'core-routes.json'), JSON.stringify([
      { method: 'PUT', path: '/api/folders/:id/rename' },
    ]))
    add('one', { routes: [{ method: 'ALL', path: '/api/folders/:id/:action' }] })
    expect(() => discoverModules(root)).toThrow(/conflict/i)
  }))
  it('checks JavaScript helpers and directory index imports across module boundaries', () => fixture((root, add) => {
    add('one'); add('two')
    fs.writeFileSync(path.join(root, 'modules/one/server.ts'), "import './bridge.js'; export default () => ({})")
    fs.writeFileSync(path.join(root, 'modules/one/bridge.js'), "import '../two/server.ts'")
    expect(() => generateModules(root)).toThrow(/required dependency/i)

    fs.rmSync(path.join(root, 'modules/one/bridge.js'))
    fs.writeFileSync(path.join(root, 'modules/two/index.ts'), 'export default 1')
    fs.writeFileSync(path.join(root, 'modules/one/server.ts'), "import '../two'; export default () => ({})")
    expect(() => generateModules(root)).toThrow(/required dependency/i)
  }))
})
