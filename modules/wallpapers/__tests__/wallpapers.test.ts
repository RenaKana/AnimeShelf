import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanWallpapers } from '../server/wallpapers'

describe('wallpapers', () => {
  let tmp: string
  const mk = (rel: string, content: string) => {
    const p = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'we-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('parses video/web/scene wallpapers and skips broken dirs', () => {
    mk('w1/project.json', JSON.stringify({ title: '星空视频', type: 'video', file: 'star.mp4', preview: 'preview.jpg' }))
    mk('w1/star.mp4', ''); mk('w1/preview.jpg', '')
    mk('w2/project.json', JSON.stringify({ title: '动态网页', type: 'web', file: 'index.html' }))
    mk('w2/index.html', '')
    mk('w3/project.json', JSON.stringify({ title: '场景', type: 'scene', preview: 'missing.jpg' }))
    mk('w3/preview.gif', '')
    mk('w3/material.mp4', '')
    mk('broken/not-json.txt', 'x')

    const r = scanWallpapers([tmp])
    expect(r).toHaveLength(3)
    const v = r.find(x => x.name === '星空视频')!
    expect(v.type).toBe('video')
    expect(v.mediaFile).toContain('star.mp4')
    expect(v.preview).toContain('preview.jpg')
    expect(v.renderMode).toBe('video')
    expect(r.find(x => x.name === '动态网页')!.renderMode).toBe('web')
    const scene = r.find(x => x.name === '场景')!
    expect(scene.type).toBe('scene')
    expect(scene.mediaFile).toBeNull()
    expect(scene.preview).toContain('preview.gif')
    expect(scene.renderMode).toBe('preview')
  })

  it('ignores project assets that cross a junction boundary', () => {
    const outside = path.join(tmp, 'outside')
    const project = path.join(tmp, 'safe')
    fs.mkdirSync(outside)
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(outside, 'secret.mp4'), 'secret')
    fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ title: '链接项目', type: 'video', file: 'escape/secret.mp4' }))
    fs.symlinkSync(outside, path.join(project, 'escape'), 'junction')

    const wallpaper = scanWallpapers([tmp])[0]
    expect(wallpaper.mediaFile).toBeNull()
    expect(wallpaper.renderMode).toBe('unavailable')
  })
})
