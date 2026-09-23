import { useEffect, useRef } from 'react'
import type { Settings } from '../../../src/types'
import { attachVideoPlayback } from './videoPlayback'

function VideoBackground({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const snapshotRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) return attachVideoPlayback(ref.current, snapshotRef.current)
  }, [src])
  return (
    <div className="relative w-full h-full">
      <video ref={ref} src={src} autoPlay loop muted playsInline preload="auto" className="absolute inset-0 w-full h-full object-cover" />
      <canvas ref={snapshotRef} aria-hidden="true" data-wallpaper-frame="true" className="absolute inset-0 w-full h-full object-cover" style={{ visibility: 'hidden' }} />
    </div>
  )
}

export default function AppBackground({ settings }: { settings: Settings }) {
  const type = settings.background_type ?? 'solid'
  const rawDimmer = Number(settings.background_dimmer ?? '0.7')
  const dimmer = Number.isFinite(rawDimmer) ? Math.min(0.95, Math.max(0, rawDimmer)) : 0.7
  const src = settings.background_path ?? ''
  const previewSrc = typeof settings.background_preview_url === 'string' && settings.background_preview_url.startsWith('blob:')
    ? settings.background_preview_url : ''
  const videoPreviewSrc = settings.background_preview_type === 'video' && settings.background_preview_url?.startsWith('/api/background/video-preview/')
    ? settings.background_preview_url : ''
  if (type === 'solid') return null

  // 本地绝对路径（盘符或反斜杠开头）经 /api/background/file 代理读取；http(s):// URL 直接用
  const proxySrc = (s: string) => (/^https?:\/\//i.test(s) ? s : `/api/background/file?p=${encodeURIComponent(s)}`)

  const render = () => {
    if (videoPreviewSrc) return <VideoBackground src={videoPreviewSrc} />
    if (previewSrc) {
      return <img src={previewSrc} alt="" className="w-full h-full object-cover" />
    }
    if (type === 'we') {
      const lower = src.toLowerCase()
      if (lower.endsWith('.mp4') || lower.endsWith('.webm')) {
        return <VideoBackground src={`/api/wallpapers/file?p=${encodeURIComponent(src)}`} />
      }
      if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        return <iframe src={`/api/wallpapers/file?p=${encodeURIComponent(src)}`} className="w-full h-full border-0" title="wallpaper" />
      }
      // scene.pkg/application 无法在浏览器运行；这里显示扫描器选出的 GIF/静态预览。
      if (src) {
        return <img src={`/api/wallpapers/file?p=${encodeURIComponent(src)}`} alt="" className="w-full h-full object-cover" />
      }
    }
    if (type === 'video' && src) {
      return <VideoBackground src={proxySrc(src)} />
    }
    if (type === 'image' && src) {
      return <img src={proxySrc(src)} alt="" className="w-full h-full object-cover" />
    }
    return null
  }

  return (
    <div className="fixed inset-0 z-0">
      {render()}
      <div className="absolute inset-0" style={{ backgroundColor: `rgb(var(--ui-backdrop) / ${dimmer})` }} />
    </div>
  )
}
