import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = path.resolve(process.cwd())
const packageJsonPath = path.join(root, 'package.json')
const lockfilePath = path.join(root, 'pnpm-lock.yaml')
const licensesDir = path.join(root, 'licenses')
const manifestPath = path.join(licensesDir, 'dependency-license-manifest.json')
const licenseTextsPath = path.join(licensesDir, 'dependency-license-texts.txt')
const noticesPath = path.join(root, 'THIRD-PARTY-NOTICES.txt')
const boolbaseLicense = {
  path: 'licenses/boolbase-1.0.0-LICENSE.txt',
  source: 'https://raw.githubusercontent.com/fb55/boolbase/be0bcd8a4e917a0a5895e95b523fbbed05a64871/LICENSE',
  upstreamCommit: 'be0bcd8a4e917a0a5895e95b523fbbed05a64871',
  licenseSha256: 'cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6',
  indexSha256: 'c62510fca8738c7444cdf5012bdd0ce214a1b6f7eaff7facb3a919e4656d7341',
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function scalar(value) {
  const text = value.trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

function packageKey(raw) {
  const base = raw.replace(/^['"]|['"]$/g, '').split('(')[0]
  const separator = base.lastIndexOf('@')
  if (separator <= 0) return { name: base, version: null }
  return { name: base.slice(0, separator), version: base.slice(separator + 1) }
}

function isPackageHeader(line) {
  return /^  [^\s]/.test(line) && /:$/.test(line)
}

function parseLockfile(text) {
  const lines = text.split(/\r?\n/)
  const packagesLine = lines.findIndex(line => line === 'packages:')
  const snapshotsLine = lines.findIndex((line, index) => index > packagesLine && line === 'snapshots:')
  if (packagesLine < 0 || snapshotsLine < 0) throw new Error('pnpm-lock.yaml is missing packages/snapshots sections')

  const records = []
  for (let index = packagesLine + 1; index < snapshotsLine; index += 1) {
    const match = lines[index].match(/^  (.+):$/)
    if (!match || !isPackageHeader(lines[index])) continue
    const end = lines.findIndex((line, candidate) => candidate > index && isPackageHeader(line))
    const block = lines.slice(index + 1, end < 0 ? snapshotsLine : end).join('\n')
    const parsed = packageKey(match[1])
    if (!parsed.name || !parsed.version) continue
    const key = `${parsed.name}@${parsed.version}`
    const existing = records.find(record => record.key === key)
    const platformConstrained = /\n\s+(?:os|cpu|libc):/.test(`\n${block}`)
    if (existing) {
      existing.platformConstrained ||= platformConstrained
    } else {
      records.push({ key, name: parsed.name, version: parsed.version, platformConstrained })
    }
  }
  return records
}

function parseImporter(text) {
  const lines = text.split(/\r?\n/)
  const importerLine = lines.findIndex(line => line === '  .:')
  const packagesLine = lines.findIndex(line => line === 'packages:')
  if (importerLine < 0 || packagesLine < 0) throw new Error('pnpm-lock.yaml is missing the root importer')
  const direct = []
  let section = null
  let current = null
  for (let index = importerLine + 1; index < packagesLine; index += 1) {
    const line = lines[index]
    const sectionMatch = line.match(/^    (dependencies|devDependencies):$/)
    if (sectionMatch) {
      section = sectionMatch[1] === 'dependencies' ? 'production' : 'development'
      current = null
      continue
    }
    const packageMatch = line.match(/^      (.+):$/)
    if (packageMatch && section) {
      current = { name: scalar(packageMatch[1]), role: section, specifier: null, lockedVersion: null }
      direct.push(current)
      continue
    }
    if (!current) continue
    const specifier = line.match(/^        specifier:\s*(.+)$/)
    if (specifier) current.specifier = scalar(specifier[1])
    const version = line.match(/^        version:\s*(.+)$/)
    if (version) current.lockedVersion = scalar(version[1])
  }
  return direct
}

function packageLicense(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim()
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses.map(value => typeof value === 'string' ? value : value?.type).filter(Boolean)
    if (values.length) return values.join(' OR ')
  }
  return null
}

function licenseFiles(packageDir) {
  const entries = readdirSync(packageDir, { withFileTypes: true }).filter(entry => entry.isFile())
  const explicit = entries
    .filter(entry => /^(license|licence|copying|notice)([._-]|$)/i.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (explicit.length) return explicit
  // Some exact package archives place the copyright and permission text only
  // in README. Copy that section, not the unrelated examples or credentials.
  return entries.filter(entry => /^readme(?:\.|$)/i.test(entry.name)
    && embeddedLicense(readFileSync(path.join(packageDir, entry.name), 'utf8')) !== null)
    .map(entry => entry.name).sort()
}

function embeddedLicense(text) {
  const match = /(?:^|\n)(?:#{1,6}[ \t]*(?:licen[cs]e|copyright)\b[^\n]*\r?\n|(?:licen[cs]e|copyright)[ \t]*\r?\n[-=]+[ \t]*\r?\n)/i.exec(text)
  if (!match) return null
  return text.slice(match.index).trim()
}

function collectLocalPackages() {
  const store = path.join(root, 'node_modules', '.pnpm')
  const packages = new Map()
  if (!existsSync(store)) return packages

  for (const storeEntry of readdirSync(store, { withFileTypes: true })) {
    if (!storeEntry.isDirectory() || storeEntry.name.startsWith('.') || storeEntry.name === 'node_modules') continue
    const nodeModules = path.join(store, storeEntry.name, 'node_modules')
    if (!existsSync(nodeModules)) continue
    const packageDirs = []
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(nodeModules, entry.name)
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (scoped.isDirectory()) packageDirs.push(path.join(scopeDir, scoped.name))
        }
      } else if (entry.isDirectory()) {
        packageDirs.push(path.join(nodeModules, entry.name))
      }
    }
    for (const packageDir of packageDirs) {
      const manifestPath = path.join(packageDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = readJson(manifestPath)
        if (!manifest.name || !manifest.version) continue
        const key = `${manifest.name}@${manifest.version}`
        if (!packages.has(key)) {
          packages.set(key, {
            key,
            name: manifest.name,
            version: manifest.version,
            license: packageLicense(manifest),
            repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
            licenseFiles: licenseFiles(packageDir),
            packagePath: relative(packageDir),
          })
        }
      } catch {
        // Ignore malformed or transient package directories; the lockfile record remains visible.
      }
    }
  }
  return packages
}

function fileEvidence(relativePath, note) {
  const file = path.join(root, relativePath)
  return { path: relativePath, present: existsSync(file), note }
}

const packageJson = readJson(packageJsonPath)
const lockText = readFileSync(lockfilePath, 'utf8')
const lockPackages = parseLockfile(lockText)
const direct = parseImporter(lockText)
const directRoles = new Map(direct.map(item => [item.name, item.role]))
const localPackages = collectLocalPackages()
const boolbase = localPackages.get('boolbase@1.0.0')
if (boolbase) {
  const digest = file => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')
  if (digest(boolbaseLicense.path) !== boolbaseLicense.licenseSha256
    || digest(path.join(boolbase.packagePath, 'index.js')) !== boolbaseLicense.indexSha256) {
    throw new Error('boolbase supplemental license evidence no longer matches its verified source')
  }
}
// Follow installed production dependencies through pnpm's actual node_modules graph.
// This is distinct from the complete development/platform inventory in the lockfile.
const runtimeKeys = new Set()
function resolveManifest(name, from) {
  let current = from
  while (true) {
    const file = path.join(current, 'node_modules', name, 'package.json')
    if (existsSync(file)) return realpathSync(file)
    const parent = path.dirname(current)
    if (current === parent) return null
    current = parent
  }
}
function visitRuntime(name, from) {
  const file = resolveManifest(name, from)
  if (!file) return
  const entry = readJson(file)
  const key = `${entry.name}@${entry.version}`
  if (runtimeKeys.has(key)) return
  runtimeKeys.add(key)
  for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) visitRuntime(dependency, path.dirname(file))
}
for (const name of Object.keys(packageJson.dependencies ?? {})) visitRuntime(name, root)

const packageRecords = lockPackages.map(lockPackage => {
  const local = localPackages.get(lockPackage.key)
  return {
    key: lockPackage.key,
    name: lockPackage.name,
    version: lockPackage.version,
    role: directRoles.get(lockPackage.name) ?? 'transitive',
    distributionRole: runtimeKeys.has(lockPackage.key) ? 'installed-runtime' : local ? 'development-tooling' : 'unverified-platform-or-development',
    source: { registry: `https://registry.npmjs.org/${encodeURIComponent(lockPackage.name)}/${lockPackage.version}`, repository: local?.repository ?? null },
    lockStatus: local ? 'installed' : 'unverified-not-installed',
    platformConstrained: lockPackage.platformConstrained,
    license: local?.license ?? null,
    licenseFiles: local?.licenseFiles ?? [],
    ...(lockPackage.key === 'boolbase@1.0.0' && boolbase ? { supplementalLicense: boolbaseLicense } : {}),
    packagePath: local?.packagePath ?? null,
  }
})

for (const local of localPackages.values()) {
  if (!lockPackages.some(lockPackage => lockPackage.key === local.key)) {
    packageRecords.push({
      key: local.key,
      name: local.name,
      version: local.version,
      role: directRoles.get(local.name) ?? 'transitive',
      lockStatus: 'local-not-in-lock',
      platformConstrained: false,
      license: local.license,
      licenseFiles: local.licenseFiles,
      packagePath: local.packagePath,
    })
  }
}

packageRecords.sort((left, right) => `${left.role}:${left.name}@${left.version}`.localeCompare(`${right.role}:${right.name}@${right.version}`))

const installed = packageRecords.filter(record => record.lockStatus === 'installed')
const unverified = packageRecords.filter(record => record.lockStatus === 'unverified-not-installed')
const licenseCounts = Object.create(null)
for (const record of installed) licenseCounts[record.license ?? 'NO_MANIFEST_LICENSE'] = (licenseCounts[record.license ?? 'NO_MANIFEST_LICENSE'] ?? 0) + 1

const runtime = [
  fileEvidence('node_modules/electron/LICENSE', 'Electron package MIT license'),
  fileEvidence('node_modules/electron/dist/LICENSE', 'Electron runtime license'),
  fileEvidence('node_modules/electron/dist/LICENSES.chromium.html', 'Chromium and bundled third-party attributions'),
  fileEvidence('node_modules/electron/dist/electron.exe', 'Windows Electron runtime binary'),
  fileEvidence('node_modules/node-sqlite3-wasm/LICENSE', 'node-sqlite3-wasm MIT license'),
  fileEvidence('node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm', 'SQLite WASM runtime'),
]

const manifest = {
  generatedAt: '2026-09-21',
  sourceOfTruth: {
    packageJson: 'package.json',
    lockfile: 'pnpm-lock.yaml',
    npmLockfile: 'intentionally absent in this candidate',
  },
  direct,
  counts: {
    lockPackageEntries: lockPackages.length,
    localPackageEntries: localPackages.size,
    installedFromLock: installed.length,
    unverifiedNotInstalled: unverified.length,
    localNotInLock: packageRecords.filter(record => record.lockStatus === 'local-not-in-lock').length,
    installedWithManifestLicense: installed.filter(record => record.license).length,
    installedWithLicenseFile: installed.filter(record => record.licenseFiles.length > 0).length,
    installedRuntimeWithLicenseEvidence: installed.filter(record => record.distributionRole === 'installed-runtime' && (record.licenseFiles.length > 0 || record.supplementalLicense)).length,
    installedRuntimePackages: installed.filter(record => record.distributionRole === 'installed-runtime').length,
    licenseCounts,
  },
  runtime,
  caveats: [
    'Uninstalled lock entries are retained as unverified; most are platform/CPU-specific optional packages, but no legal license conclusion is made without the package archive.',
    'Electron Chromium notices are referenced by relative path when the clean Electron runtime is present; the release owner must re-run this script after preparing that runtime.',
    'This manifest does not select the project license and does not cover poster caches, real-site fixtures, or user media.',
  ],
  packages: packageRecords,
}

mkdirSync(licensesDir, { recursive: true })
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const licenseTextLines = [
  'AnimeShelf desktop candidate third-party license texts',
  'Generated by scripts/generate-notices.mjs. Paths are relative to the candidate root.',
  '',
]
const copiedTextKeys = new Set()
for (const record of installed) {
  if (!record.packagePath) continue
  for (const fileName of record.licenseFiles) {
    const file = path.join(root, record.packagePath, fileName)
    const key = `${record.key}:${fileName}`
    if (copiedTextKeys.has(key)) continue
    copiedTextKeys.add(key)
    const size = readFileSync(file).byteLength
    licenseTextLines.push(`===== ${record.name}@${record.version} | ${relative(file)} =====`)
    if (size > 512 * 1024) {
      licenseTextLines.push(`[not copied: ${size} bytes; retain the original file in the runtime/package]`, '')
      continue
    }
    const originalText = readFileSync(file, 'utf8')
    licenseTextLines.push((/^readme(?:\.|$)/i.test(fileName) ? embeddedLicense(originalText) : originalText).trimEnd(), '')
  }
}
licenseTextLines.push('===== Special attribution notes =====')
if (boolbase) {
  licenseTextLines.push(`===== boolbase@1.0.0 | ${boolbaseLicense.source} =====`)
  licenseTextLines.push(readFileSync(path.join(root, boolbaseLicense.path), 'utf8').trimEnd(), '')
}
licenseTextLines.push('bangumi-data: CC BY 4.0. Attribute the source as bangumi-data. See node_modules/bangumi-data/README.md in the installed package.')
licenseTextLines.push('SQLite: node-sqlite3-wasm is MIT; its README identifies SQLite as public domain. Preserve both package/license evidence where the runtime is distributed.')
licenseTextLines.push('Electron/Chromium: retain node_modules/electron/dist/LICENSES.chromium.html from the exact runtime used for the release.')
writeFileSync(licenseTextsPath, `${licenseTextLines.join('\n')}\n`, 'utf8')

const grouped = new Map()
for (const record of installed) {
  const license = record.license ?? 'NO_MANIFEST_LICENSE'
  if (!grouped.has(license)) grouped.set(license, [])
  grouped.get(license).push(`${record.name}@${record.version}`)
}

const noticeLines = [
  'AnimeShelf desktop candidate — THIRD-PARTY-NOTICES',
  'Generated by scripts/generate-notices.mjs on 2026-09-21.',
  'This file records dependency/runtime obligations only; it does not select a project license.',
  '',
  'SOURCE OF TRUTH',
  '- Direct dependency roles/specifiers: package.json and the root importer in pnpm-lock.yaml.',
  '- Exact package inventory: licenses/dependency-license-manifest.json.',
  '- Copied package license text where available: licenses/dependency-license-texts.txt.',
  '',
  'SPECIAL ATTRIBUTION / RUNTIME ITEMS',
  '- bangumi-data@0.3.223 is CC BY 4.0. Attribute the source as “bangumi-data”; its package README carries the attribution instruction.',
  '- node-sqlite3-wasm is MIT and ships a SQLite WASM runtime. Its README describes SQLite as public domain; retain the package MIT notice and the exact runtime evidence.',
  '- Electron is MIT. The exact Electron runtime also carries Chromium and other bundled notices in dist/LICENSES.chromium.html; retain that file or an equivalent exact-runtime notice bundle.',
  '- boolbase@1.0.0: the npm archive omits a license file. The supplemental ISC notice comes from upstream commit be0bcd8a4e917a0a5895e95b523fbbed05a64871, whose package version is 1.0.0 and whose index.js exactly matches the installed package; see licenses/boolbase-1.0.0-LICENSE.txt.',
  '- Apache-2.0, BSD, ISC, BlueOak, WTFPL, CC-BY and other non-MIT entries remain separately listed in the manifest. No GPL prohibition is inferred from this inventory.',
  '',
  'LICENSE COUNTS (installed packages)',
]
for (const [license, names] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  noticeLines.push(`- ${license}: ${names.length}`)
}
noticeLines.push('', 'INSTALLED PACKAGE INVENTORY')
for (const [license, names] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  noticeLines.push(`\n[${license}]`)
  noticeLines.push(...names.sort().map(name => `- ${name}`))
}
noticeLines.push('', 'UNVERIFIED LOCK ENTRIES')
noticeLines.push('- These entries are in pnpm-lock.yaml but were not present in this Windows candidate node_modules store. They are retained as unverified, not treated as license-free.')
for (const record of unverified.sort((left, right) => left.key.localeCompare(right.key))) {
  noticeLines.push(`- ${record.name}@${record.version}${record.platformConstrained ? ' [platform/CPU constrained]' : ''}`)
}
noticeLines.push('', 'RUNTIME EVIDENCE')
for (const item of runtime) noticeLines.push(`- ${item.present ? 'present' : 'UNVERIFIED'}: ${item.path} — ${item.note}`)
noticeLines.push('', 'REGENERATION', '- From the candidate root: node scripts/generate-notices.mjs')
writeFileSync(noticesPath, `${noticeLines.join('\n')}\n`, 'utf8')

console.log(JSON.stringify({
  manifest: relative(manifestPath),
  licenseTexts: relative(licenseTextsPath),
  notices: relative(noticesPath),
  counts: manifest.counts,
}, null, 2))
