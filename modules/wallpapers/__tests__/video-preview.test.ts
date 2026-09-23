import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { createDb } from '../../../server/db/schema'
import { createApplication } from '../../../server/application'
import { manifests } from '../../../.generated/modules'
import { requestLocalHttp } from '../../../server/services/__tests__/http-test-client'
import { VIDEO_PREVIEW_IDLE_TTL_MS } from '../server/video-preview'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function startWallpapers() {
  const db = createDb(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS module_config(module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
  for (const manifest of manifests) {
    const statement = db.prepare('INSERT INTO module_config VALUES (?, ?)')
    try { statement.run([manifest.id, manifest.id === 'wallpapers' ? 1 : 0]) } finally { statement.finalize() }
  }
  const application = await createApplication({ database: db, backgroundTasks: false, distDir: 'nonexistent-test-build' })
  const server: Server = await new Promise(resolve => {
    const listener = application.app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  cleanup.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await application.stop()
    db.close()
  })
  return { server }
}

const ownerJson = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

function mp4Bytes(payload: Buffer = Buffer.from('video-payload')): Buffer {
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(ftyp.length, 0)
  ftyp.write('ftyp', 4, 'ascii')
  ftyp.write('isom', 8, 'ascii')
  ftyp.writeUInt32BE(0, 12)
  ftyp.write('isom', 16, 'ascii')
  ftyp.write('mp42', 20, 'ascii')
  const mdat = Buffer.alloc(8 + payload.length)
  mdat.writeUInt32BE(mdat.length, 0)
  mdat.write('mdat', 4, 'ascii')
  payload.copy(mdat, 8)
  return Buffer.concat([ftyp, mdat])
}

function webmBytes(): Buffer {
  const header = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f,
    0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02,
    0x18, 0x53, 0x80, 0x67, 0xff, 0x00,
  ])
  header[4] = 0x9f
  return header
}

async function createPreview(server: Server, file: string, headers: Record<string, string> = ownerJson) {
  return requestLocalHttp(server, '/api/background/video-preview', {
    method: 'POST', headers, body: JSON.stringify({ path: file }),
  })
}

describe('background video preview capabilities', () => {
  it('streams original MP4 bytes with HEAD and byte ranges, then revokes the capability', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-video-preview-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const video = path.join(root, 'preview.mp4')
    const original = mp4Bytes(Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]))
    fs.writeFileSync(video, original)
    const { server } = await startWallpapers()

    const created = await createPreview(server, video)
    expect(created.status).toBe(201)
    const { url } = await created.json<{ url: string }>()
    expect(url).toMatch(/^\/api\/background\/video-preview\/[0-9a-f-]{36}$/i)

    const full = await requestLocalHttp(server, url)
    expect(full.status).toBe(200)
    expect(full.headers['content-type']).toMatch(/^video\/mp4/)
    expect(full.headers['cache-control']).toBe('no-store')
    expect(full.headers['x-content-type-options']).toBe('nosniff')
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(await full.binary()).toEqual(original)

    const head = await requestLocalHttp(server, url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(original.length))
    expect(await head.binary()).toHaveLength(0)

    const partial = await requestLocalHttp(server, url, { headers: { Range: 'bytes=7-18' } })
    expect(partial.status).toBe(206)
    expect(partial.headers['content-range']).toBe(`bytes 7-18/${original.length}`)
    expect(await partial.binary()).toEqual(original.subarray(7, 19))

    const suffix = await requestLocalHttp(server, url, { headers: { Range: 'bytes=-5' } })
    expect(suffix.status).toBe(206)
    expect(await suffix.binary()).toEqual(original.subarray(original.length - 5))

    const impossible = await requestLocalHttp(server, url, { headers: { Range: `bytes=${original.length}-` } })
    expect(impossible.status).toBe(416)
    expect(impossible.headers['content-range']).toBe(`bytes */${original.length}`)

    const arbitraryGet = await requestLocalHttp(server, `/api/background/file?p=${encodeURIComponent(video)}`)
    expect(arbitraryGet.status).toBe(403)
    expect((await arbitraryGet.json()).code).toBe('PATH_OUTSIDE_ALLOWED_ROOT')

    const deleted = await requestLocalHttp(server, url, { method: 'DELETE', headers: ownerJson })
    expect(deleted.status).toBe(204)
    expect((await requestLocalHttp(server, url)).status).toBe(404)
  })

  it('validates extension and bounded MP4/WebM container headers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-video-validation-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const validMp4 = path.join(root, 'valid.mp4')
    const validWebm = path.join(root, 'valid.webm')
    const wrongExtension = path.join(root, 'video.mkv')
    const fakeMp4 = path.join(root, 'fake.mp4')
    fs.writeFileSync(validMp4, mp4Bytes())
    fs.writeFileSync(validWebm, webmBytes())
    fs.writeFileSync(wrongExtension, mp4Bytes())
    fs.writeFileSync(fakeMp4, 'not an MP4 container')
    const { server } = await startWallpapers()

    const mp4 = await createPreview(server, validMp4)
    expect(mp4.status).toBe(201)
    const mp4Url = (await mp4.json<{ url: string }>()).url
    const mp4Response = await requestLocalHttp(server, mp4Url)
    expect(mp4Response.headers['content-type']).toMatch(/^video\/mp4/)
    expect(await mp4Response.binary()).toEqual(mp4Bytes())
    const webm = await createPreview(server, validWebm)
    expect(webm.status).toBe(201)
    const webmUrl = (await webm.json<{ url: string }>()).url
    const webmResponse = await requestLocalHttp(server, webmUrl)
    expect(webmResponse.headers['content-type']).toMatch(/^video\/webm/)
    expect(await webmResponse.binary()).toEqual(webmBytes())
    const extension = await createPreview(server, wrongExtension)
    expect(extension.status).toBe(415)
    expect((await extension.json()).code).toBe('VIDEO_TYPE_UNSUPPORTED')
    const content = await createPreview(server, fakeMp4)
    expect(content.status).toBe(415)
    expect((await content.json()).code).toBe('VIDEO_CONTENT_INVALID')
    expect((await createPreview(server, 'relative.mp4')).status).toBe(400)
    await requestLocalHttp(server, mp4Url, { method: 'DELETE', headers: ownerJson })
    await requestLocalHttp(server, webmUrl, { method: 'DELETE', headers: ownerJson })
  })

  it('rejects symlink paths and invalidates a capability when its registered file is replaced', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-video-identity-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const media = path.join(root, 'media')
    const movedMedia = path.join(root, 'media-original')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(media)
    fs.mkdirSync(outside)
    const video = path.join(media, 'selected.mp4')
    fs.writeFileSync(video, mp4Bytes())
    const outsideVideo = path.join(outside, 'selected.mp4')
    fs.writeFileSync(outsideVideo, mp4Bytes())
    const linked = path.join(root, 'linked')
    fs.symlinkSync(outside, linked, 'junction')
    const { server } = await startWallpapers()

    const symlinkPreview = await createPreview(server, path.join(linked, 'selected.mp4'))
    expect(symlinkPreview.status).toBe(403)
    expect((await symlinkPreview.json()).code).toBe('PATH_SYMLINK_FORBIDDEN')

    const replaced = await createPreview(server, video)
    const replacedUrl = (await replaced.json<{ url: string }>()).url
    fs.renameSync(video, path.join(media, 'selected-original.mp4'))
    fs.writeFileSync(video, mp4Bytes(Buffer.from('replacement-content')))
    expect((await requestLocalHttp(server, replacedUrl)).status).toBe(404)

    const linkedLater = await createPreview(server, video)
    const linkedUrl = (await linkedLater.json<{ url: string }>()).url
    fs.renameSync(media, movedMedia)
    fs.symlinkSync(outside, media, 'junction')
    const linkedResponse = await requestLocalHttp(server, linkedUrl)
    expect(linkedResponse.status).toBe(404)
  })

  it('invalidates a capability after in-place modification and expires it after two idle hours', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-video-lifecycle-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const changedFile = path.join(root, 'changed.mp4')
    fs.writeFileSync(changedFile, mp4Bytes())
    const { server } = await startWallpapers()

    const changed = await createPreview(server, changedFile)
    const changedUrl = (await changed.json<{ url: string }>()).url
    const modified = Buffer.from(mp4Bytes())
    modified[modified.length - 1] ^= 0xff
    fs.writeFileSync(changedFile, modified)
    expect((await requestLocalHttp(server, changedUrl)).status).toBe(404)

    const expiringFile = path.join(root, 'expiring.mp4')
    fs.writeFileSync(expiringFile, mp4Bytes())
    const expiring = await createPreview(server, expiringFile)
    const expiringUrl = (await expiring.json<{ url: string }>()).url
    const originalTime = Date.now()
    try {
      vi.setSystemTime(originalTime + VIDEO_PREVIEW_IDLE_TTL_MS - 1000)
      expect((await requestLocalHttp(server, expiringUrl)).status).toBe(200)
      vi.setSystemTime(originalTime + VIDEO_PREVIEW_IDLE_TTL_MS * 2 - 1500)
      expect((await requestLocalHttp(server, expiringUrl, { headers: { Range: 'bytes=0-3' } })).status).toBe(206)
      vi.setSystemTime(originalTime + VIDEO_PREVIEW_IDLE_TTL_MS * 3 - 1500)
      expect((await requestLocalHttp(server, expiringUrl)).status).toBe(404)
    } finally {
      vi.setSystemTime(originalTime)
    }
  })

  it('keeps POST and DELETE behind the owner boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-video-owner-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const video = path.join(root, 'owner.mp4')
    fs.writeFileSync(video, mp4Bytes())
    const { server } = await startWallpapers()

    const deniedCreate = await createPreview(server, video, { 'Content-Type': 'application/json' })
    expect(deniedCreate.status).toBe(403)
    const created = await createPreview(server, video)
    const { url } = await created.json<{ url: string }>()
    const deniedDelete = await requestLocalHttp(server, url, { method: 'DELETE' })
    expect(deniedDelete.status).toBe(403)
    const hostileGet = await requestLocalHttp(server, url, { headers: { Host: 'evil.example' } })
    expect(hostileGet.status).toBe(403)
    expect((await requestLocalHttp(server, url, { method: 'DELETE', headers: ownerJson })).status).toBe(204)
  })
})
