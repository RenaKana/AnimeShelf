import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../../src/api'
import type { Settings } from '../../../src/types'
import type { ModuleSettingsProps } from '../../../src/modules/contracts'
import { fetchBackgroundPreview, fetchVideoPreview, replacePreviewObjectUrl, revokePreviewObjectUrl } from './backgroundPreview'

interface Wallpaper {
  id: string
  name: string
  type: 'video' | 'web' | 'scene' | 'application' | 'unknown'
  mediaFile: string | null
  preview: string | null
  renderMode: 'video' | 'web' | 'preview' | 'unavailable'
}

const MODE_LABEL: Record<Wallpaper['renderMode'], string> = {
  video: '动态视频',
  web: '动态网页',
  preview: '场景预览',
  unavailable: '不可用',
}

const KEYS = ['background_type', 'background_path', 'we_dirs', 'background_dimmer'] as const

function savedBackgroundPatch(settings: Settings): Settings {
  const patch: Settings = {}
  for (const key of KEYS) patch[key] = settings[key] ?? ''
  return patch
}

export default function WallpaperSettings({ onRefresh, onBackgroundPreview, embedded }: ModuleSettingsProps) {
  const [settings, setSettings] = useState<Settings>({})
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const savedBackground = useRef<Settings | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewPath = useRef('')
  const previewUrl = useRef<string | null>(null)
  const onBackgroundPreviewRef = useRef(onBackgroundPreview)
  const supported = wallpapers.filter(wallpaper => wallpaper.renderMode === 'video' || wallpaper.renderMode === 'web')
  const hiddenCount = wallpapers.length - supported.length

  useEffect(() => { onBackgroundPreviewRef.current = onBackgroundPreview }, [onBackgroundPreview])

  const cancelPreviewWork = useCallback(() => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current)
      previewTimer.current = null
    }
    previewController.current?.abort()
    previewController.current = null
  }, [])

  const disposePreview = useCallback((publish = true) => {
    cancelPreviewWork()
    previewPath.current = ''
    previewUrl.current = replacePreviewObjectUrl(previewUrl.current, null)
    setPreviewBusy(false)
    if (publish) onBackgroundPreviewRef.current?.({ background_preview_url: '' })
  }, [cancelPreviewWork])

  const restoreSavedBackground = useCallback(() => {
    const saved = savedBackground.current
    if (saved) onBackgroundPreviewRef.current?.({ ...saved, background_preview_url: '' })
    else onBackgroundPreviewRef.current?.({ background_preview_url: '' })
  }, [])

  const schedulePreview = useCallback((source: string, type: 'image' | 'video') => {
    const candidate = source.trim()
    cancelPreviewWork()
    previewPath.current = candidate
    if (!candidate) {
      previewUrl.current = replacePreviewObjectUrl(previewUrl.current, null)
      setPreviewBusy(false)
      restoreSavedBackground()
      return
    }
    setPreviewBusy(true)
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null
      const controller = new AbortController()
      previewController.current = controller
      const fetchPreview = type === 'video' ? fetchVideoPreview : fetchBackgroundPreview
      void fetchPreview(candidate, controller.signal).then(url => {
        if (controller.signal.aborted || previewPath.current !== candidate) {
          revokePreviewObjectUrl(url)
          return
        }
        previewUrl.current = replacePreviewObjectUrl(previewUrl.current, url)
        onBackgroundPreviewRef.current?.({ background_type: type, background_preview_url: url, background_preview_type: type })
        setMessage('')
      }).catch(error => {
        if (controller.signal.aborted || previewPath.current !== candidate) return
        previewUrl.current = replacePreviewObjectUrl(previewUrl.current, null)
        onBackgroundPreviewRef.current?.({ background_preview_url: '' })
        restoreSavedBackground()
        setMessage(`背景预览失败：${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => {
        if (previewController.current === controller) {
          previewController.current = null
          setPreviewBusy(false)
        }
      })
    }, 180)
  }, [cancelPreviewWork, restoreSavedBackground])

  const load = useCallback(async () => {
    const [nextSettings, nextWallpapers] = await Promise.all([
      request<Settings>('/api/settings'),
      request<Wallpaper[]>('/api/wallpapers').catch(() => []),
    ])
    savedBackground.current = savedBackgroundPatch(nextSettings)
    setSettings(nextSettings)
    setWallpapers(nextWallpapers)
  }, [])

  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : String(error))) }, [load])

  useEffect(() => () => {
    cancelPreviewWork()
    previewPath.current = ''
    previewUrl.current = replacePreviewObjectUrl(previewUrl.current, null)
    const saved = savedBackground.current
    if (saved) onBackgroundPreviewRef.current?.({ ...saved, background_preview_url: '' })
  }, [cancelPreviewWork])

  const set = (key: string, value: string, preview = false) => {
    setSettings(current => ({ ...current, [key]: value }))
    if (!preview) return
    if (key === 'background_path') {
      if (settings.background_type === 'image' || settings.background_type === 'video') schedulePreview(value, settings.background_type)
      return
    }
    if (key === 'background_type' && value !== settings.background_type) {
      disposePreview()
      if (value === 'image' || value === 'video') {
        schedulePreview(settings.background_path ?? '', value)
        return
      }
      onBackgroundPreviewRef.current?.({ background_type: value, background_path: '' })
      return
    }
    onBackgroundPreviewRef.current?.({ [key]: value })
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const patch: Settings = {}
      for (const key of KEYS) patch[key] = settings[key] ?? ''
      await request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) })
      savedBackground.current = patch
      disposePreview()
      onBackgroundPreviewRef.current?.({ ...patch, background_preview_url: '' })
      setMessage('壁纸设置已保存')
      onRefresh?.()
      setWallpapers(await request<Wallpaper[]>('/api/wallpapers'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="settings-wallpapers" className={embedded ? 'scroll-mt-4 space-y-3 border-t border-border pt-4' : 'ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg'}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">背景与壁纸</h3>
          <p className="mt-1 text-xs text-text-secondary">背景改动会立即预览，保存后在下次打开时继续生效。</p>
        </div>
        <button type="button" disabled={busy} className="rounded-lg border border-accent/40 px-2.5 py-1 text-xs text-accent transition hover:bg-accent/10 disabled:opacity-45" onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {[['solid', '纯色'], ['image', '图片'], ['video', '视频'], ['we', 'Wallpaper Engine']].map(([value, label]) => (
          <button key={value} type="button" disabled={busy} onClick={() => set('background_type', value, true)} className={`rounded-lg px-3 py-1.5 ${(settings.background_type ?? 'solid') === value ? 'bg-accent text-white' : 'border border-border bg-[var(--ui-control-bg)] text-text-secondary'}`}>{label}</button>
        ))}
      </div>

      {(settings.background_type === 'image' || settings.background_type === 'video') && (
        <label className="block text-sm text-text-secondary">文件路径（本地绝对路径）
          <input disabled={busy} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" value={settings.background_path ?? ''} onChange={event => set('background_path', event.target.value, true)} />
        </label>
      )}

      {settings.background_type === 'we' && (
        <>
          <label className="block text-sm text-text-secondary">WE 目录（分号分隔多个）
            <input disabled={busy} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" value={settings.we_dirs ?? ''} onChange={event => set('we_dirs', event.target.value)} />
          </label>
          <div className="grid max-h-80 gap-2 overflow-y-auto pr-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
            {supported.map(wallpaper => {
              const choice = wallpaper.mediaFile ?? wallpaper.preview ?? ''
              const selected = Boolean(choice) && settings.background_path === choice
              return (
                <button key={wallpaper.id} type="button" disabled={!choice || busy} title={wallpaper.name} onClick={() => {
                  if (!choice) return
                  disposePreview()
                  setSettings(current => ({ ...current, background_type: 'we', background_path: choice }))
                  onBackgroundPreviewRef.current?.({ background_type: 'we', background_path: choice, background_preview_url: '' })
                }} className={`group overflow-hidden rounded-xl border bg-[var(--ui-control-bg)] text-left transition ${selected ? 'border-accent shadow-[0_0_0_1px_rgb(var(--ui-accent)/0.25)]' : 'border-border hover:border-white/20'} disabled:opacity-45`}>
                  <div className="relative aspect-video overflow-hidden bg-white/[0.025]">
                    {wallpaper.preview ? <img loading="lazy" src={`/api/wallpapers/file?p=${encodeURIComponent(wallpaper.preview)}`} alt="" className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" /> : <div className="flex h-full items-center justify-center text-2xl text-white/15">▧</div>}
                    <span className="media-overlay absolute bottom-1.5 left-1.5 rounded-md border border-white/10 bg-black/65 px-1.5 py-0.5 text-[9px] text-white/80 backdrop-blur-sm">{MODE_LABEL[wallpaper.renderMode]}</span>
                  </div>
                  <div className="px-2.5 py-2"><div className="truncate text-xs font-medium">{wallpaper.name}</div><div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-secondary/60">{wallpaper.type}</div></div>
                </button>
              )
            })}
            {supported.length === 0 && <p className="text-sm text-text-secondary">未发现可用的 Video 或 Web 壁纸，请检查 WE 目录</p>}
          </div>
          <p className="text-[11px] leading-5 text-text-secondary/65">仅显示可在应用内动态运行的 Video 与 Web 壁纸。Scene、SceneScript 和 Application 依赖 Wallpaper Engine 专用运行时，已从选项中隐藏{hiddenCount > 0 ? `（共 ${hiddenCount} 个）` : ''}。</p>
        </>
      )}

      <label className="block text-sm text-text-secondary">背景遮罩强度
        <input disabled={busy} type="range" min="0" max="0.95" step="0.05" className="mt-1 w-full" value={Number(settings.background_dimmer ?? '0.7')} onChange={event => set('background_dimmer', event.target.value, true)} />
      </label>
      {previewBusy && <p role="status" className="text-xs text-text-secondary">正在预览…</p>}
      {message && <p role="status" className="text-xs text-text-secondary">{message}</p>}
    </section>
  )
}
