import fs from 'node:fs'
import path from 'node:path'

export type WallpaperPathErrorCode =
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_ALLOWED_ROOT'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_REGULAR_FILE'
  | 'PATH_SYMLINK_FORBIDDEN'

export class WallpaperPathError extends Error {
  constructor(
    readonly code: WallpaperPathErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WallpaperPathError'
  }
}

interface AuthorizedRoot {
  lexical: string
  real: string
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WallpaperPathError('PATH_INVALID', 'path must be a non-empty string', 400)
  }
  const trimmed = value.trim()
  if (!path.isAbsolute(trimmed)) {
    throw new WallpaperPathError('PATH_INVALID', 'path must be absolute', 400)
  }
  let resolved: string
  try { resolved = path.resolve(trimmed) } catch { throw new WallpaperPathError('PATH_INVALID', 'path is invalid', 400) }
  return resolved
}

function pathKey(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function samePath(left: string, right: string): boolean {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right))
}

export function isInside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (allowRoot && relative === '')
    || (relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function isSymlinkComponent(target: string): boolean {
  const absolute = path.resolve(target)
  const root = path.parse(absolute).root
  let cursor = root
  const relative = path.relative(root, absolute)
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  return false
}

function authorizedRoots(values: readonly string[]): AuthorizedRoot[] {
  const roots: AuthorizedRoot[] = []
  for (const value of values) {
    let lexical: string
    try { lexical = absolutePath(value) } catch { continue }
    try {
      const stat = fs.lstatSync(lexical)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      roots.push({ lexical, real: fs.realpathSync(lexical) })
    } catch { /* Missing or unreadable configured roots are ignored. */ }
  }
  return roots
}

function findAuthorizedRoot(target: string, roots: readonly string[], allowRoot = false): AuthorizedRoot | undefined {
  return authorizedRoots(roots).find(root => isInside(root.lexical, target, allowRoot))
}

function ensureRealBoundary(target: string, root: AuthorizedRoot, allowRoot = false): void {
  let targetReal: string
  try { targetReal = fs.realpathSync(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WallpaperPathError('PATH_NOT_FOUND', 'file not found', 404)
    }
    throw new WallpaperPathError('PATH_INVALID', 'path cannot be resolved', 400)
  }
  if (!isInside(root.real, targetReal, allowRoot)) {
    throw new WallpaperPathError('PATH_SYMLINK_FORBIDDEN', 'symbolic links are not allowed', 403)
  }
}

function ensureRegularFile(target: string): string {
  if (isSymlinkComponent(target)) {
    throw new WallpaperPathError('PATH_SYMLINK_FORBIDDEN', 'symbolic links are not allowed', 403)
  }
  let stat: fs.Stats
  try { stat = fs.lstatSync(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WallpaperPathError('PATH_NOT_FOUND', 'file not found', 404)
    }
    throw new WallpaperPathError('PATH_INVALID', 'path cannot be read', 400)
  }
  if (stat.isSymbolicLink()) {
    throw new WallpaperPathError('PATH_SYMLINK_FORBIDDEN', 'symbolic links are not allowed', 403)
  }
  if (!stat.isFile()) {
    throw new WallpaperPathError('PATH_NOT_REGULAR_FILE', 'path is not a regular file', 400)
  }
  return target
}

export function resolveAllowedFile(value: unknown, roots: readonly string[], exactPaths: readonly string[] = []): string {
  const target = absolutePath(value)
  const exact = exactPaths.some(candidate => {
    try { return samePath(target, absolutePath(candidate)) } catch { return false }
  })
  const root = findAuthorizedRoot(target, roots)
  if (!exact && !root) {
    throw new WallpaperPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'path is outside the allowed roots', 403)
  }
  const file = ensureRegularFile(target)
  if (root) ensureRealBoundary(file, root)
  else {
    try { fs.realpathSync(file) } catch { throw new WallpaperPathError('PATH_NOT_FOUND', 'file not found', 404) }
  }
  return file
}

/**
 * Resolve a file explicitly selected by the local owner for a one-shot
 * preview. This intentionally does not consult the configured wallpaper roots
 * or saved settings; callers must perform their own content validation and
 * must not reuse this helper for general file serving.
 */
export function resolvePreviewFile(value: unknown): string {
  return ensureRegularFile(absolutePath(value))
}

export function resolveAllowedDirectory(value: unknown, roots: readonly string[], allowRoot = false): string {
  const target = absolutePath(value)
  const root = findAuthorizedRoot(target, roots, allowRoot)
  if (!root) throw new WallpaperPathError('PATH_OUTSIDE_ALLOWED_ROOT', 'path is outside the allowed roots', 403)
  if (isSymlinkComponent(target)) {
    throw new WallpaperPathError('PATH_SYMLINK_FORBIDDEN', 'symbolic links are not allowed', 403)
  }
  let stat: fs.Stats
  try { stat = fs.lstatSync(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WallpaperPathError('PATH_NOT_FOUND', 'directory not found', 404)
    throw new WallpaperPathError('PATH_INVALID', 'directory cannot be read', 400)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WallpaperPathError('PATH_INVALID', 'path is not a directory', 400)
  }
  ensureRealBoundary(target, root, allowRoot)
  return target
}

export function tryResolveAllowedFile(value: unknown, roots: readonly string[], exactPaths: readonly string[] = []): string | null {
  try { return resolveAllowedFile(value, roots, exactPaths) } catch { return null }
}
