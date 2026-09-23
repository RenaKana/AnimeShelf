import fs from 'node:fs'
import { inflateSync } from 'node:zlib'
import { resolvePreviewFile } from './path-access'

export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
export const MAX_PREVIEW_DIMENSION = 20_000
export const MAX_DECODED_PREVIEW_BYTES = 128 * 1024 * 1024

export type WallpaperPreviewContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type WallpaperImageErrorCode =
  | 'IMAGE_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSIONS_TOO_LARGE'
  | 'IMAGE_READ_FAILED'

export class WallpaperImageError extends Error {
  constructor(
    readonly code: WallpaperImageErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WallpaperImageError'
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < PNG_CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  PNG_CRC_TABLE[index] = value >>> 0
}

function pngCrc32(data: Buffer, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index++) crc = PNG_CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function exceedsDecodedImageLimit(width: number, height: number, channels = 4): boolean {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || channels <= 0) return true
  return width > Math.floor(MAX_DECODED_PREVIEW_BYTES / channels / height)
}

function checkDimensions(width: number, height: number, channels = 4): boolean {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return false
  if (width > MAX_PREVIEW_DIMENSION || height > MAX_PREVIEW_DIMENSION || exceedsDecodedImageLimit(width, height, channels)) {
    throw new WallpaperImageError('IMAGE_DIMENSIONS_TOO_LARGE', '图片尺寸过大', 413)
  }
  return true
}

function validPng(data: Buffer): boolean {
  if (data.length < 57 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = -1
  let sawHeader = false, sawPalette = false, sawImageData = false, sawEnd = false
  const imageData: Buffer[] = []
  let imageDataBytes = 0
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset)
    const typeStart = offset + 4
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + length
    const chunkEnd = payloadEnd + 4
    if (length > MAX_PREVIEW_BYTES || chunkEnd > data.length) return false
    const type = data.subarray(typeStart, payloadStart).toString('ascii')
    // Check the declared dimensions before CRC/decompression work so a
    // forged oversized header is rejected as a resource limit violation too.
    if (!sawHeader && type === 'IHDR' && length === 13) {
      const width = data.readUInt32BE(payloadStart)
      const height = data.readUInt32BE(payloadStart + 4)
      const colorType = data[payloadStart + 9]
      checkDimensions(width, height, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 4)
    }
    if (!/^[A-Za-z]{4}$/.test(type) || pngCrc32(data, typeStart, payloadEnd) !== data.readUInt32BE(payloadEnd)) return false
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false
      width = data.readUInt32BE(payloadStart)
      height = data.readUInt32BE(payloadStart + 4)
      bitDepth = data[payloadStart + 8]
      colorType = data[payloadStart + 9]
      interlace = data[payloadStart + 12]
      const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!checkDimensions(width, height, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 4)
        || !allowedDepths[colorType]?.includes(bitDepth) || data[payloadStart + 10] !== 0 || data[payloadStart + 11] !== 0
        || (interlace !== 0 && interlace !== 1)) return false
      sawHeader = true
    } else if (type === 'IHDR') return false
    if (type === 'PLTE') sawPalette = length > 0 && length % 3 === 0 && length <= 768
    if (type === 'IDAT') {
      if (colorType === 3 && !sawPalette) return false
      sawImageData = true
      imageData.push(data.subarray(payloadStart, payloadEnd))
      imageDataBytes += length
      if (imageDataBytes > MAX_PREVIEW_BYTES) return false
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawImageData || chunkEnd !== data.length) return false
      sawEnd = true
      offset = chunkEnd
      break
    }
    offset = chunkEnd
  }
  if (!sawHeader || !sawEnd || offset !== data.length) return false
  try {
    const decoded = inflateSync(Buffer.concat(imageData, imageDataBytes), { maxOutputLength: MAX_DECODED_PREVIEW_BYTES })
    if (decoded.length === 0) return false
    if (interlace === 0) {
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
      const rowBytes = Math.ceil(width * channels * bitDepth / 8)
      const expected = height * (rowBytes + 1)
      if (expected > MAX_DECODED_PREVIEW_BYTES || decoded.length !== expected) return false
    }
    return true
  } catch { return false }
}

function validJpeg(data: Buffer): boolean {
  if (data.length < 32 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return false
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  let sawFrame = false
  while (offset < data.length - 2) {
    if (data[offset] !== 0xff) return false
    while (offset < data.length && data[offset] === 0xff) offset++
    const marker = data[offset++]
    if (marker === 0x00 || marker === 0xd9) return false
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > data.length - 2) return false
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length - 2) return false
    const payload = offset + 2
    if (startOfFrame.has(marker)) {
      if (length < 8) return false
      const height = data.readUInt16BE(payload + 1)
      const width = data.readUInt16BE(payload + 3)
      const components = data[payload + 5]
      if (components === 0 || length !== 8 + 3 * components || !checkDimensions(width, height, Math.min(components, 4))) return false
      sawFrame = true
    }
    if (marker === 0xda) {
      const entropyStart = offset + length
      const components = data[payload]
      return sawFrame && components > 0 && length === 6 + 2 * components && entropyStart < data.length - 2
    }
    offset += length
  }
  return false
}

function validWebp(data: Buffer): boolean {
  if (data.length < 30 || data.subarray(0, 4).toString('ascii') !== 'RIFF'
    || data.subarray(8, 12).toString('ascii') !== 'WEBP' || data.readUInt32LE(4) !== data.length - 8) return false
  let offset = 12
  let sawImage = false, sawAnimation = false, sawAnimationFrame = false
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString('ascii')
    const length = data.readUInt32LE(offset + 4)
    const payload = offset + 8
    const payloadEnd = payload + length
    const chunkEnd = payloadEnd + (length & 1)
    if (!/^[A-Z0-9 ]{4}$/.test(type) || length > MAX_PREVIEW_BYTES || chunkEnd > data.length) return false
    if ((length & 1) && data[payloadEnd] !== 0) return false
    if (type === 'VP8 ') {
      if (length < 10 || (data[payload] & 1) !== 0 || data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a) return false
      const width = data.readUInt16LE(payload + 6) & 0x3fff
      const height = data.readUInt16LE(payload + 8) & 0x3fff
      const firstPartition = (data[payload] | (data[payload + 1] << 8) | (data[payload + 2] << 16)) >>> 5
      if (!checkDimensions(width, height, 3) || firstPartition === 0 || firstPartition > length - 10) return false
      sawImage = true
    } else if (type === 'VP8L') {
      if (length < 5 || data[payload] !== 0x2f) return false
      const bits = data.readUInt32LE(payload + 1)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >>> 14) & 0x3fff) + 1
      if ((bits >>> 29) !== 0 || !checkDimensions(width, height)) return false
      sawImage = true
    } else if (type === 'VP8X') {
      if (length !== 10) return false
      const width = data.readUIntLE(payload + 4, 3) + 1
      const height = data.readUIntLE(payload + 7, 3) + 1
      if ((data[payload] & 0xc1) !== 0 || data[payload + 1] !== 0 || data[payload + 2] !== 0 || data[payload + 3] !== 0
        || !checkDimensions(width, height)) return false
      sawAnimation = (data[payload] & 0x02) !== 0
    } else if (type === 'ANMF') sawAnimationFrame = length >= 16
    offset = chunkEnd
  }
  return offset === data.length && (sawImage || (sawAnimation && sawAnimationFrame))
}

function skipGifSubBlocks(data: Buffer, start: number): number {
  let offset = start
  while (offset < data.length) {
    const length = data[offset++]
    if (length === 0) return offset
    if (offset + length > data.length) return -1
    offset += length
  }
  return -1
}

function validGif(data: Buffer): boolean {
  if (data.length < 14 || (data.subarray(0, 6).toString('ascii') !== 'GIF87a' && data.subarray(0, 6).toString('ascii') !== 'GIF89a')) return false
  const width = data.readUInt16LE(6)
  const height = data.readUInt16LE(8)
  if (!checkDimensions(width, height)) return false
  const packed = data[10]
  let offset = 13
  if ((packed & 0x80) !== 0) {
    offset += 3 * (1 << ((packed & 0x07) + 1))
    if (offset > data.length) return false
  }
  let sawImage = false
  while (offset < data.length) {
    const marker = data[offset++]
    if (marker === 0x3b) return offset === data.length && sawImage
    if (marker === 0x21) {
      if (offset >= data.length) return false
      offset = skipGifSubBlocks(data, offset + 1)
      if (offset < 0) return false
      continue
    }
    if (marker !== 0x2c || offset + 9 > data.length) return false
    const frameWidth = data.readUInt16LE(offset + 4)
    const frameHeight = data.readUInt16LE(offset + 6)
    if (!checkDimensions(frameWidth, frameHeight)) return false
    const imagePacked = data[offset + 8]
    offset += 9
    if ((imagePacked & 0x80) !== 0) {
      offset += 3 * (1 << ((imagePacked & 0x07) + 1))
      if (offset > data.length) return false
    }
    if (offset >= data.length) return false
    offset = skipGifSubBlocks(data, offset + 1)
    if (offset < 0) return false
    sawImage = true
  }
  return false
}

function validateImage(data: Buffer): WallpaperPreviewContentType {
  if (data.length > MAX_PREVIEW_BYTES) {
    throw new WallpaperImageError('IMAGE_TOO_LARGE', '图片文件过大', 413)
  }
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (validPng(data)) return 'image/png'
  } else if (data[0] === 0xff && data[1] === 0xd8) {
    if (validJpeg(data)) return 'image/jpeg'
  } else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    if (validWebp(data)) return 'image/webp'
  } else if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') {
    if (validGif(data)) return 'image/gif'
  }
  throw new WallpaperImageError('IMAGE_INVALID', '文件不是有效的图片', 415)
}

export function readWallpaperPreview(value: unknown): { data: Buffer; contentType: WallpaperPreviewContentType } {
  const file = resolvePreviewFile(value)
  let stat: fs.Stats
  try { stat = fs.statSync(file) } catch { throw new WallpaperImageError('IMAGE_READ_FAILED', '图片无法读取', 400) }
  if (!stat.isFile()) throw new WallpaperImageError('IMAGE_READ_FAILED', '图片无法读取', 400)
  if (stat.size > MAX_PREVIEW_BYTES) throw new WallpaperImageError('IMAGE_TOO_LARGE', '图片文件过大', 413)
  let data: Buffer
  try { data = fs.readFileSync(file) } catch { throw new WallpaperImageError('IMAGE_READ_FAILED', '图片无法读取', 400) }
  const contentType = validateImage(data)
  return { data, contentType }
}
