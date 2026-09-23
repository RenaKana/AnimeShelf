import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateModuleBoundaries } from './module-boundaries.mjs'

const normalizeMethod = method => method.toUpperCase().replace(/^_ALL$/, 'ALL')
const normalizePath = value => {
  const routePath = value.split('?', 1)[0].replace(/\/+$/, '')
  return routePath || '/'
}
const routeKey = route => `${normalizeMethod(route.method)} ${normalizePath(route.path).replace(/:[A-Za-z0-9_]+/g, ':param').toLowerCase()}`
const routeSegments = routePath => normalizePath(routePath).split('/').filter(Boolean)
const methodsOverlap = (left, right) => {
  const a = normalizeMethod(left), b = normalizeMethod(right)
  return a === b || a === 'ALL' || b === 'ALL' || (a === 'GET' && b === 'HEAD') || (a === 'HEAD' && b === 'GET')
}
const routePathsOverlap = (left, right) => {
  const a = routeSegments(left), b = routeSegments(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const leftSegment = a[index], rightSegment = b[index]
    if (leftSegment === '*' || rightSegment === '*') return true
    if (leftSegment === undefined || rightSegment === undefined) return false
    if (!leftSegment.startsWith(':') && !rightSegment.startsWith(':') && leftSegment.toLowerCase() !== rightSegment.toLowerCase()) return false
  }
  return true
}

export function discoverModules(root = process.cwd()) {
  const directory = path.join(root, 'modules')
  const modules = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter(entry => fs.existsSync(path.join(directory, entry.name, 'manifest.json')))
    .map(entry => {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'manifest.json'), 'utf8'))
      if (!/^[a-z][a-z0-9-]*$/.test(manifest.id) || manifest.id !== entry.name) throw new Error(`Invalid module id: ${entry.name}`)
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.defaultEnabled !== 'boolean'
        || !Array.isArray(manifest.requires) || !Array.isArray(manifest.optional)
        || [...manifest.requires, ...manifest.optional].some(id => typeof id !== 'string')) throw new Error(`Invalid module manifest: ${entry.name}`)
      for (const file of ['client.tsx', 'server.ts']) if (!fs.existsSync(path.join(directory, entry.name, file))) throw new Error(`Missing ${entry.name}/${file}`)
      return manifest
    }) : []
  const ids = new Map(modules.map(module => [module.id, module]))
  const visiting = new Set(), visited = new Set(), sorted = []
  const routes = []
  const coreFile = path.join(root, 'shared/core-routes.json')
  if (fs.existsSync(coreFile)) {
    for (const route of JSON.parse(fs.readFileSync(coreFile, 'utf8'))) routes.push({ ...route, owner: 'core' })
  }
  const pages = new Map(['/', '/all', '/library/:param', '/folder/:param', '/file/:param', '/settings'].map(p => [p, 'core']))
  function visit(module) {
    if (visited.has(module.id)) return
    if (visiting.has(module.id)) throw new Error(`Module dependency cycle: ${[...visiting, module.id].join(' -> ')}`)
    visiting.add(module.id)
    for (const id of module.requires) {
      if (!ids.has(id)) throw new Error(`Module ${module.id} requires missing module ${id}`)
      visit(ids.get(id))
    }
    // Optional providers load first when present; optional cycles are also errors.
    for (const id of module.optional) if (ids.has(id)) visit(ids.get(id))
    visiting.delete(module.id); visited.add(module.id); sorted.push(module)
    for (const route of module.routes ?? []) {
      if (!route || typeof route.method !== 'string' || typeof route.path !== 'string' || !route.path.startsWith('/')) throw new Error(`Invalid route in ${module.id}`)
      const key = routeKey(route)
      if (/^\/api\/modules(?:\/|$)/.test(route.path) || normalizePath(route.path) === '/api/health') throw new Error(`Reserved core route: ${key} (${module.id})`)
      const conflict = routes.find(existing => methodsOverlap(route.method, existing.method) && routePathsOverlap(route.path, existing.path)
        && (existing.owner !== module.id || normalizePath(existing.path).toLowerCase() !== normalizePath(route.path).toLowerCase()))
      if (conflict) throw new Error(`Module route conflict: ${key} (${conflict.owner}, ${module.id})`)
      routes.push({ ...route, owner: module.id })
    }
    for (const page of module.pages ?? []) {
      if (typeof page !== 'string' || !page.startsWith('/')) throw new Error(`Invalid page in ${module.id}`)
      const key = page.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/$/, '') || '/'
      if (pages.has(key)) throw new Error(`Module page conflict: ${page} (${pages.get(key)}, ${module.id})`)
      pages.set(key, module.id)
    }
  }
  modules.sort((a, b) => a.id.localeCompare(b.id)).forEach(visit)
  return sorted
}

function writeChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export function generateModules(root = process.cwd()) {
  const modules = discoverModules(root)
  validateModuleBoundaries(root, modules)
  const header = '// Generated by scripts/modules.mjs. Do not edit.\n'
  writeChanged(path.join(root, '.generated/modules.ts'), `${header}import type { ModuleManifest } from '../shared/modules'\nexport const manifests: ModuleManifest[] = ${JSON.stringify(modules, null, 2)}\n`)
  for (const target of ['client', 'server']) {
    const loaders = modules.map(m => `  ${JSON.stringify(m.id)}: () => import('../modules/${m.id}/${target}'),`).join('\n')
    writeChanged(path.join(root, `.generated/${target}-modules.ts`), `${header}export const loaders = {\n${loaders}\n}\n`)
  }
  return modules
}

/** Watch discovery metadata; Vite/esbuild own ordinary source dependency changes. */
export function watchModules(onChange, root = process.cwd()) {
  const directory = path.join(root, 'modules')
  fs.mkdirSync(directory, { recursive: true })
  let previous = JSON.stringify(discoverModules(root))
  let debounce
  const watcher = fs.watch(directory, { recursive: true }, (event, filename) => {
    const changed = String(filename ?? '').replace(/\\/g, '/')
    // Directory additions/removals, manifest edits and entry-point creation can
    // change discovery. Editing a component, route, shared helper or test cannot.
    if (changed && !/^[^/]+$/.test(changed)
      && !/^[^/]+\/manifest\.json$/.test(changed)
      && !(event === 'rename' && /^[^/]+\/(?:client\.tsx|server\.ts)$/.test(changed))) return
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        const next = JSON.stringify(generateModules(root))
        if (next !== previous) { previous = next; onChange?.() }
      } catch (error) { console.error('Module discovery failed:', error.message) }
    }, 100)
  })
  return () => { clearTimeout(debounce); watcher.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Discovered ${generateModules().length} modules`)
}
