import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.tsx']
const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS)
const SOURCE_ALTERNATES = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])
const isSourceFile = file => SOURCE_EXTENSION_SET.has(path.extname(file).toLowerCase())
const isTestFile = file => /\.(?:test|spec)\.(?:js|jsx|mjs|cjs|mts|cts|ts|tsx)$/.test(file)
const isFile = file => {
  try { return fs.statSync(file).isFile() } catch { return false }
}
const isDirectory = file => {
  try { return fs.statSync(file).isDirectory() } catch { return false }
}

function resolveRelativeImport(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier)
  const extension = path.extname(base).toLowerCase()
  const fileCandidates = [base]
  if (extension) {
    for (const alternate of SOURCE_ALTERNATES.get(extension) ?? []) fileCandidates.push(base.slice(0, -extension.length) + alternate)
  } else {
    for (const candidateExtension of SOURCE_EXTENSIONS) fileCandidates.push(base + candidateExtension)
  }
  for (const candidate of fileCandidates) if (isFile(candidate)) return candidate
  if (isDirectory(base)) {
    for (const candidateExtension of SOURCE_EXTENSIONS) {
      const candidate = path.join(base, `index${candidateExtension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return base
}

/** Source dependencies must still resolve after deleting every optional integration. */
export function validateModuleBoundaries(root, manifests) {
  const modules = new Map(manifests.map(m => [m.id, m]))
  const owner = file => {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    if (relative.startsWith('../') || path.isAbsolute(relative)) return undefined
    return relative.match(/^modules\/([^/]+)(?:\/|$)/)?.[1]
  }
  const visited = new Set()
  function visit(directory) {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '__tests__') visit(file); continue }
      if (!isSourceFile(file) || isTestFile(file) || visited.has(file)) continue
      visited.add(file)
      const sourceOwner = owner(file)
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const check = specifier => {
        if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return
        const target = resolveRelativeImport(file, specifier.text)
        const targetOwner = owner(target)
        if (!targetOwner || targetOwner === sourceOwner) return
        if (!sourceOwner) throw new Error(`Core imports optional implementation: ${path.relative(root, file)} -> ${specifier.text}`)
        if (!modules.get(sourceOwner)?.requires.includes(targetOwner)) throw new Error(`Module ${sourceOwner} statically imports ${targetOwner} without a required dependency: ${path.relative(root, file)}`)
      }
      const walk = node => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier)
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) check(node.arguments[0])
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
  }
  for (const directory of ['src', 'server', 'shared', 'modules']) visit(path.join(root, directory))
}
