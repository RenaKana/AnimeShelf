import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateModules, watchModules } from '../../../scripts/modules.mjs'

const cleanups: (() => void)[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-module-watch-'))
  const add = (id: string) => {
    const dir = path.join(root, 'modules', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'client.tsx'), 'export default {}')
    fs.writeFileSync(path.join(dir, 'server.ts'), 'export default () => ({})')
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      id, name: id, version: '1.0.0', defaultEnabled: true, requires: [], optional: [],
    }))
  }
  add('example')
  generateModules(root)
  const changed = vi.fn()
  const stop = watchModules(changed, root)
  cleanups.push(() => {
    stop()
    const target = path.resolve(root)
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('animeshelf-module-watch-')) {
      throw new Error('Unexpected watcher fixture path')
    }
    fs.rmSync(target, { recursive: true, force: true })
  })
  return { root, add, changed }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

describe('module discovery watch scope', () => {
  it('leaves frontend, backend, shared and test source edits to their own dependency watchers', async () => {
    const { root, changed } = fixture()
    for (const name of ['client/Page.tsx', 'server/route.ts', 'shared/value.ts', '__tests__/example.test.ts', 'client.tsx', 'server.ts']) {
      const file = path.join(root, 'modules/example', name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'export const value = 2')
    }
    await delay(350)
    expect(changed).not.toHaveBeenCalled()
  })

  it('ignores an unchanged manifest and reports a changed manifest once', async () => {
    const { root, changed } = fixture()
    const file = path.join(root, 'modules/example/manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
    await delay(350)
    expect(changed).not.toHaveBeenCalled()
    fs.writeFileSync(file, JSON.stringify({ ...manifest, name: 'Updated module' }))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(fs.readFileSync(path.join(root, '.generated/modules.ts'), 'utf8')).toContain('Updated module')
  })

  it('discovers a new module and removes it when its directory is renamed out of discovery', async () => {
    const { root, add, changed } = fixture()
    add('added')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(fs.readFileSync(path.join(root, '.generated/server-modules.ts'), 'utf8')).toContain('added/server')
    const source = path.resolve(root, 'modules/added')
    const destination = path.resolve(root, 'modules/.removed')
    if (![source, destination].every(target => path.dirname(target) === path.join(root, 'modules'))) throw new Error('Unexpected fixture module path')
    fs.renameSync(source, destination)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(fs.readFileSync(path.join(root, '.generated/server-modules.ts'), 'utf8')).not.toContain('added/server')
  })

  it('recovers when the missing entry point of a newly added module arrives later', async () => {
    const { root, add, changed } = fixture()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    add('pending')
    const entry = path.join(root, 'modules/pending/server.ts')
    fs.unlinkSync(entry)
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    expect(changed).not.toHaveBeenCalled()
    fs.writeFileSync(entry, 'export default () => ({})')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(fs.readFileSync(path.join(root, '.generated/server-modules.ts'), 'utf8')).toContain('pending/server')
  })
})
