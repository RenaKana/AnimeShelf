import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { createDb } from '../../db/schema'
import { createApplication } from '../../application'
import { manifests } from '../../../.generated/modules'
import { requestLocalHttp } from './http-test-client'
import { MAX_PREVIEW_BYTES } from '../../../modules/wallpapers/server/image-validation'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function startWallpapers(settings: Record<string, string>) {
  const db = createDb(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS module_config(module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)')
  for (const manifest of manifests) {
    const statement = db.prepare('INSERT INTO module_config VALUES (?, ?)')
    try { statement.run([manifest.id, manifest.id === 'wallpapers' ? 1 : 0]) } finally { statement.finalize() }
  }
  for (const [key, value] of Object.entries(settings)) {
    const statement = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)')
    try { statement.run([key, value]) } finally { statement.finalize() }
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

function wallpaperFile(file: string): string {
  return `/api/wallpapers/file?p=${encodeURIComponent(file)}`
}

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const previewHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' }

function backgroundPreview(server: Server, file: string, headers: Record<string, string> = previewHeaders) {
  return requestLocalHttp(server, '/api/background/preview', {
    method: 'POST', headers, body: JSON.stringify({ path: file }),
  })
}

describe('wallpaper local file boundaries', () => {
  it('keeps background access to the saved file and rejects arbitrary local paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-background-security-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const configured = path.join(root, 'background.jpg')
    const secret = path.join(root, 'secret.txt')
    fs.writeFileSync(configured, 'configured-background')
    fs.writeFileSync(secret, 'do-not-serve')
    const { server } = await startWallpapers({ background_path: configured })

    const allowed = await requestLocalHttp(server, `/api/background/file?p=${encodeURIComponent(configured)}`)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('configured-background')

    const arbitrary = await requestLocalHttp(server, `/api/background/file?p=${encodeURIComponent(secret)}`)
    expect(arbitrary.status).toBe(403)
    expect((await arbitrary.json()).code).toBe('PATH_OUTSIDE_ALLOWED_ROOT')

    const missing = await requestLocalHttp(server, '/api/background/file')
    expect(missing.status).toBe(400)
    expect((await missing.json()).code).toBe('PATH_INVALID')
  })

  it('previews an explicitly selected image without widening the saved-file GET route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-background-preview-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const saved = path.join(root, 'saved.png')
    const explicit = path.join(root, 'explicit.png')
    fs.writeFileSync(saved, ONE_PIXEL_PNG)
    fs.writeFileSync(explicit, ONE_PIXEL_PNG)
    const started = await startWallpapers({ background_path: saved })

    const preview = await backgroundPreview(started.server, explicit)
    expect(preview.status).toBe(200)
    expect(preview.headers['content-type']).toMatch(/^image\/png/)
    expect(preview.headers['cache-control']).toBe('no-store')
    expect(preview.headers['x-content-type-options']).toBe('nosniff')
    expect(await preview.binary()).toEqual(ONE_PIXEL_PNG)

    const arbitraryGet = await requestLocalHttp(started.server, wallpaperFile(explicit))
    expect(arbitraryGet.status).toBe(403)
    expect((await arbitraryGet.json()).code).toBe('PATH_OUTSIDE_ALLOWED_ROOT')
    const savedSettings = await requestLocalHttp(started.server, '/api/settings')
    expect(savedSettings.status).toBe(200)
    expect((await savedSettings.json()).background_path).toBe(saved)
  })

  it('rejects non-images, oversized files, oversized dimensions, and junction paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-background-preview-validation-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const text = path.join(root, 'notes.png')
    const oversized = path.join(root, 'oversized.png')
    const dimensions = path.join(root, 'dimensions.png')
    const outside = path.join(root, 'outside')
    const junction = path.join(root, 'linked')
    fs.mkdirSync(outside)
    fs.writeFileSync(text, 'not an image')
    fs.writeFileSync(oversized, ONE_PIXEL_PNG)
    fs.truncateSync(oversized, MAX_PREVIEW_BYTES + 1)
    const oversizedDimensions = Buffer.from(ONE_PIXEL_PNG)
    oversizedDimensions.writeUInt32BE(20_001, 16)
    fs.writeFileSync(dimensions, oversizedDimensions)
    fs.writeFileSync(path.join(outside, 'image.png'), ONE_PIXEL_PNG)
    fs.symlinkSync(outside, junction, 'junction')
    const { server } = await startWallpapers({})

    const invalid = await backgroundPreview(server, text)
    expect(invalid.status).toBe(415)
    expect((await invalid.json()).code).toBe('IMAGE_INVALID')
    const tooLarge = await backgroundPreview(server, oversized)
    expect(tooLarge.status).toBe(413)
    expect((await tooLarge.json()).code).toBe('IMAGE_TOO_LARGE')
    const tooWide = await backgroundPreview(server, dimensions)
    expect(tooWide.status).toBe(413)
    expect((await tooWide.json()).code).toBe('IMAGE_DIMENSIONS_TOO_LARGE')
    const linked = await backgroundPreview(server, path.join(junction, 'image.png'))
    expect(linked.status).toBe(403)
    expect((await linked.json()).code).toBe('PATH_SYMLINK_FORBIDDEN')
  })

  it('requires the local owner boundary for preview mutations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-background-preview-owner-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const image = path.join(root, 'image.png')
    fs.writeFileSync(image, ONE_PIXEL_PNG)
    const { server } = await startWallpapers({})

    const missingOwner = await backgroundPreview(server, image, { 'Content-Type': 'application/json' })
    expect(missingOwner.status).toBe(403)
    expect((await missingOwner.json()).code).toBe('OWNER_REQUIRED')
    const bearer = await backgroundPreview(server, image, { ...previewHeaders, Authorization: 'Bearer external-token' })
    expect(bearer.status).toBe(403)
    const hostileHost = await backgroundPreview(server, image, { ...previewHeaders, Host: 'evil.example' })
    expect(hostileHost.status).toBe(403)
    const hostileOrigin = await backgroundPreview(server, image, { ...previewHeaders, Origin: 'https://evil.example' })
    expect(hostileOrigin.status).toBe(403)
  })

  it('serves an allowed wallpaper and rejects outside, prefix, traversal, and junction paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-wallpaper-security-'))
    cleanup.push(async () => { fs.rmSync(root, { recursive: true, force: true }) })
    const allowedRoot = path.join(root, 'wallpapers')
    const siblingRoot = path.join(root, 'wallpapers-sibling')
    const outsideRoot = path.join(root, 'outside')
    const project = path.join(allowedRoot, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(siblingRoot)
    fs.mkdirSync(outsideRoot)
    const allowed = path.join(project, 'asset.txt')
    const sibling = path.join(siblingRoot, 'secret.txt')
    const outside = path.join(outsideRoot, 'secret.txt')
    fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ title: 'Safe', type: 'web', file: 'asset.txt' }))
    fs.writeFileSync(allowed, 'allowed-asset')
    fs.writeFileSync(sibling, 'sibling-secret')
    fs.writeFileSync(outside, 'outside-secret')
    const junction = path.join(allowedRoot, 'escape')
    fs.symlinkSync(outsideRoot, junction, 'junction')
    const { server } = await startWallpapers({ we_dirs: allowedRoot })

    const served = await requestLocalHttp(server, wallpaperFile(allowed))
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('allowed-asset')

    for (const file of [outside, sibling, path.join(allowedRoot, '..', 'outside', 'secret.txt'), path.join(junction, 'secret.txt')]) {
      const response = await requestLocalHttp(server, wallpaperFile(file))
      expect(response.status, file).toBe(403)
      expect((await response.json()).code).toMatch(/PATH_(OUTSIDE_ALLOWED_ROOT|SYMLINK_FORBIDDEN)/)
    }

    const token = Buffer.from(project, 'utf8').toString('base64url')
    const webAsset = await requestLocalHttp(server, `/api/wallpapers/web/${token}/asset.txt`)
    expect(webAsset.status).toBe(200)
    expect(await webAsset.text()).toBe('allowed-asset')
    const webTraversal = await requestLocalHttp(server, `/api/wallpapers/web/${token}/../outside/secret.txt`)
    expect(webTraversal.status).toBe(403)
    const invalidToken = await requestLocalHttp(server, '/api/wallpapers/web/a/asset.txt')
    expect(invalidToken.status).toBe(400)
    expect((await invalidToken.json()).code).toBe('PATH_INVALID')
  })

  it('allows local origins and no Origin while rejecting hostile browser origins', async () => {
    const { server } = await startWallpapers({})
    const hostile = await requestLocalHttp(server, '/api/health', { headers: { Origin: 'https://evil.example' } })
    expect(hostile.status).toBe(403)
    expect(hostile.headers['access-control-allow-origin']).toBeUndefined()
    const hostileMutation = await requestLocalHttp(server, '/api/settings', {
      method: 'PUT',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ background_path: 'should-not-be-written' }),
    })
    expect(hostileMutation.status).toBe(403)

    const local = await requestLocalHttp(server, '/api/health', { headers: { Origin: 'http://localhost:5173' } })
    expect(local.status).toBe(200)
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173')

    const noOrigin = await requestLocalHttp(server, '/api/health')
    expect(noOrigin.status).toBe(200)
    expect(noOrigin.headers['access-control-allow-origin']).toBeUndefined()
  })
})
