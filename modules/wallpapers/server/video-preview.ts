import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePreviewFile, samePath, WallpaperPathError } from './path-access'

export const VIDEO_PREVIEW_IDLE_TTL_MS = 2 * 60 * 60 * 1000
const MAX_VIDEO_PREVIEWS = 64
const MAX_VIDEO_HEADER_BYTES = 64 * 1024

export type WallpaperVideoContentType = 'video/mp4' | 'video/webm'

export class WallpaperVideoPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WallpaperVideoPreviewError'
  }
}

interface FileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface VideoPreviewCapability {
  id: string
  path: string
  realPath: string
  identity: FileIdentity
  contentType: WallpaperVideoContentType
  lastAccess: number
}

export interface OpenedVideoPreview {
  fd: number
  path: string
  size: number
  contentType: WallpaperVideoContentType
}

const capabilities = new Map<string, VideoPreviewCapability>()

function errorForPath(error: unknown): never {
  if (error instanceof WallpaperPathError) throw error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new WallpaperVideoPreviewError('VIDEO_FILE_NOT_FOUND', '视频文件不存在', 404)
  }
  throw new WallpaperVideoPreviewError('VIDEO_READ_FAILED', '无法读取视频文件', 400)
}

function identityFrom(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function contentTypeFor(file: string): WallpaperVideoContentType {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.webm') return 'video/webm'
  throw new WallpaperVideoPreviewError('VIDEO_TYPE_UNSUPPORTED', '仅支持 MP4 和 WebM 视频', 415)
}

function readHeader(fd: number, size: bigint): Buffer {
  const length = Number(size < BigInt(MAX_VIDEO_HEADER_BYTES) ? size : BigInt(MAX_VIDEO_HEADER_BYTES))
  const header = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = fs.readSync(fd, header, offset, length - offset, offset)
    if (count === 0) break
    offset += count
  }
  return header.subarray(0, offset)
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'qt  ', '3gp4', '3gp5', 'MSNV', 'F4V '])

function validMp4(header: Buffer, fileSize: bigint): boolean {
  let offset = 0
  while (offset + 8 <= header.length) {
    const size32 = header.readUInt32BE(offset)
    const type = header.toString('ascii', offset + 4, offset + 8)
    let headerLength = 8
    let boxSize: bigint
    if (size32 === 1) {
      if (offset + 16 > header.length) return false
      boxSize = header.readBigUInt64BE(offset + 8)
      headerLength = 16
    } else if (size32 === 0) {
      boxSize = fileSize - BigInt(offset)
    } else {
      boxSize = BigInt(size32)
    }
    if (boxSize < BigInt(headerLength) || BigInt(offset) + boxSize > fileSize) return false
    if (type === 'ftyp') {
      if (boxSize < BigInt(headerLength + 8) || offset + headerLength + 8 > header.length) return false
      const brands: string[] = [header.toString('ascii', offset + headerLength, offset + headerLength + 4)]
      const compatibleStart = offset + headerLength + 8
      const compatibleEnd = Math.min(header.length, offset + Number(boxSize))
      for (let cursor = compatibleStart; cursor + 4 <= compatibleEnd; cursor += 4) {
        brands.push(header.toString('ascii', cursor, cursor + 4))
      }
      return brands.some(brand => MP4_BRANDS.has(brand))
    }
    if (size32 === 0 || boxSize > BigInt(Number.MAX_SAFE_INTEGER)) return false
    const next = BigInt(offset) + boxSize
    if (next > BigInt(header.length)) return false
    offset = Number(next)
  }
  return false
}

function readEbmlVint(data: Buffer, offset: number, keepMarker: boolean, maxLength: number): { value: bigint; length: number } | null {
  if (offset >= data.length) return null
  const first = data[offset]
  let marker = 0x80
  let length = 1
  while (length <= maxLength && (first & marker) === 0) {
    marker >>= 1
    length++
  }
  if (length > maxLength || offset + length > data.length) return null
  let value = BigInt(keepMarker ? first : first & (marker - 1))
  for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(data[offset + index])
  return { value, length }
}

function validWebm(header: Buffer, fileSize: bigint): boolean {
  const ebmlId = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
  if (header.length < 8 || !header.subarray(0, 4).equals(ebmlId)) return false
  const headerSize = readEbmlVint(header, 4, false, 8)
  if (!headerSize || headerSize.value > BigInt(MAX_VIDEO_HEADER_BYTES)) return false
  const headerEndBig = 4n + BigInt(headerSize.length) + headerSize.value
  if (headerEndBig > BigInt(header.length) || headerEndBig > fileSize) return false
  const headerEnd = Number(headerEndBig)
  let offset = 4 + headerSize.length
  let hasWebmDocType = false
  while (offset < headerEnd) {
    const id = readEbmlVint(header, offset, true, 4)
    if (!id) return false
    const size = readEbmlVint(header, offset + id.length, false, 8)
    if (!size) return false
    const payloadStart = offset + id.length + size.length
    const payloadEnd = BigInt(payloadStart) + size.value
    if (payloadEnd > BigInt(headerEnd)) return false
    if (id.value === 0x4282n) {
      hasWebmDocType = header.toString('ascii', payloadStart, Number(payloadEnd)) === 'webm'
    }
    offset = Number(payloadEnd)
  }
  if (!hasWebmDocType || offset !== headerEnd) return false
  const segmentId = Buffer.from([0x18, 0x53, 0x80, 0x67])
  if (!header.subarray(headerEnd, headerEnd + 4).equals(segmentId)) return false
  const segmentSize = readEbmlVint(header, headerEnd + 4, false, 8)
  if (!segmentSize) return false
  const unknownSize = segmentSize.value === (1n << BigInt(segmentSize.length * 7)) - 1n
  const segmentStart = BigInt(headerEnd + 4 + segmentSize.length)
  return segmentStart < fileSize && (unknownSize || segmentStart + segmentSize.value <= fileSize)
}

function validContainer(fd: number, size: bigint, contentType: WallpaperVideoContentType): boolean {
  if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WallpaperVideoPreviewError('VIDEO_TOO_LARGE', '视频文件过大，无法安全预览', 413)
    }
    return false
  }
  const header = readHeader(fd, size)
  return contentType === 'video/mp4' ? validMp4(header, size) : validWebm(header, size)
}

function openNoFollow(file: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  return fs.openSync(file, fs.constants.O_RDONLY | noFollow)
}

function pruneExpired(now: number): void {
  for (const [id, capability] of capabilities) {
    if (now - capability.lastAccess >= VIDEO_PREVIEW_IDLE_TTL_MS) capabilities.delete(id)
  }
}

export function createVideoPreview(value: unknown): string {
  pruneExpired(Date.now())
  if (capabilities.size >= MAX_VIDEO_PREVIEWS) {
    throw new WallpaperVideoPreviewError('VIDEO_PREVIEW_CAPACITY', '预览数量已达上限', 503)
  }

  const file = resolvePreviewFile(value)
  let expectedRealPath: string
  try { expectedRealPath = fs.realpathSync(file) }
  catch (error) { return errorForPath(error) }
  const contentType = contentTypeFor(file)
  let fd: number | undefined
  try {
    fd = openNoFollow(file)
    const before = identityFrom(fs.fstatSync(fd, { bigint: true }))
    if (before.size === 0n || !validContainer(fd, before.size, contentType)) {
      throw new WallpaperVideoPreviewError('VIDEO_CONTENT_INVALID', '文件不是有效的 MP4 或 WebM 视频', 415)
    }
    const after = identityFrom(fs.fstatSync(fd, { bigint: true }))
    resolvePreviewFile(file)
    const realPath = fs.realpathSync(file)
    const pathStat = fs.lstatSync(file, { bigint: true })
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !samePath(realPath, expectedRealPath)
      || !sameIdentity(before, after) || !sameIdentity(after, identityFrom(pathStat))) {
      throw new WallpaperVideoPreviewError('VIDEO_FILE_CHANGED', '视频文件在预览期间发生变化', 409)
    }
    const id = randomUUID()
    capabilities.set(id, { id, path: file, realPath, identity: after, contentType, lastAccess: Date.now() })
    return id
  } catch (error) {
    if (error instanceof WallpaperPathError || error instanceof WallpaperVideoPreviewError) throw error
    return errorForPath(error)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function openVideoPreview(id: string, refreshIdleTtl = true): OpenedVideoPreview | undefined {
  const now = Date.now()
  pruneExpired(now)
  const capability = capabilities.get(id)
  if (!capability) return undefined

  let fd: number | undefined
  try {
    const file = resolvePreviewFile(capability.path)
    if (!samePath(fs.realpathSync(file), capability.realPath)) throw new Error('video path changed')
    fd = openNoFollow(file)
    const before = identityFrom(fs.fstatSync(fd, { bigint: true }))
    if (!sameIdentity(before, capability.identity) || !validContainer(fd, before.size, capability.contentType)) {
      throw new Error('video identity changed')
    }
    const pathStat = fs.lstatSync(file, { bigint: true })
    resolvePreviewFile(file)
    const realPath = fs.realpathSync(file)
    const after = identityFrom(fs.fstatSync(fd, { bigint: true }))
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !samePath(realPath, capability.realPath)
      || !sameIdentity(before, identityFrom(pathStat)) || !sameIdentity(before, after)) {
      throw new Error('video identity changed')
    }
    if (refreshIdleTtl) {
      capability.lastAccess = now
      capabilities.delete(id)
      capabilities.set(id, capability)
    }
    const opened = { fd, path: file, size: Number(after.size), contentType: capability.contentType }
    fd = undefined
    return opened
  } catch {
    capabilities.delete(id)
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function closeVideoPreview(opened: OpenedVideoPreview): void {
  try { fs.closeSync(opened.fd) } catch { /* The response stream may already have closed it. */ }
}

export function revokeVideoPreview(id: string): boolean {
  pruneExpired(Date.now())
  return capabilities.delete(id)
}
