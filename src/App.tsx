import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { api } from './api'
import type { Library, Settings as AppSettings } from './types'
import Sidebar from './components/Sidebar'
import { DesktopPresentation } from './components/design/DesktopPresentation'
import LibraryView from './pages/LibraryView'
import FolderDetail from './pages/FolderDetail'
import FileDetail from './pages/FileDetail'
import Settings from './pages/Settings'
import { colorTheme, textContrastMode } from './lib/appearance'
import { recoverRead } from './lib/readRecovery'
import { ModuleErrorBoundary, ModuleProviders, useModules } from './modules/registry'

// 必须在 <Route> 的 element 上下文内调用 useParams（App 本身不在 RouteContext 中）
function LibraryRoute({ libraries, onLibrariesChange }: { libraries: Library[]; onLibrariesChange: () => void | Promise<void> }) {
  const { id } = useParams()
  const n = Number(id)
  return <LibraryView libraryId={Number.isFinite(n) ? n : undefined} libraries={libraries} onLibrariesChange={onLibrariesChange} />
}

function FolderRoute() {
  const { id } = useParams()
  const n = Number(id)
  return <FolderDetail folderId={Number.isFinite(n) ? n : 0} />
}

function FileRoute() {
  const { id } = useParams()
  const n = Number(id)
  return <FileDetail fileId={Number.isFinite(n) ? n : 0} />
}

function UnavailableRoute() {
  const location = useLocation()
  return (
    <div className="clean-state p-6 text-text-secondary">
      <h1 className="text-lg font-semibold text-text-primary">此功能当前不可用</h1>
      <p className="mt-2 text-sm">路径 {location.pathname} 对应的模块未启用、未安装或加载失败。可在设置的模块管理中查看状态。</p>
    </div>
  )
}

export default function App() {
  const location = useLocation()
  const { modules, loadErrors, snapshotError } = useModules()
  const [libraries, setLibraries] = useState<Library[]>([])
  const [savedSettings, setSavedSettings] = useState<AppSettings>({})
  const [backgroundPreview, setBackgroundPreview] = useState<AppSettings>({})
  const settings = useMemo(() => ({ ...savedSettings, ...backgroundPreview }), [savedSettings, backgroundPreview])
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const refreshController = useRef<AbortController | null>(null)
  const contrast = textContrastMode(settings)
  const theme = colorTheme(settings)
  const backgroundType = settings.background_type ?? 'solid'
  const moduleRoutes = useMemo(() => modules.flatMap(loaded => (
    (loaded.contribution.routes ?? []).map(route => ({ ...route, moduleId: loaded.id }))
  )), [modules])
  const moduleBackgrounds = useMemo(() => modules.flatMap(loaded => (
    loaded.contribution.Background ? [{ moduleId: loaded.id, Background: loaded.contribution.Background }] : []
  )), [modules])

  // The document also owns portaled menus and dialogs outside the React app root.
  useEffect(() => {
    const root = document.documentElement
    const attributes = { 'data-text-contrast': contrast, 'data-theme': theme, 'data-background-type': backgroundType }
    const previous = Object.keys(attributes).map(key => [key, root.getAttribute(key)] as const)
    root.setAttribute('data-text-contrast', contrast)
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-background-type', backgroundType)
    return () => {
      for (const [key, value] of previous) {
        if (value === null) root.removeAttribute(key)
        else root.setAttribute(key, value)
      }
    }
  }, [contrast, theme, backgroundType])

  const refresh = useCallback(async () => {
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    const { signal } = controller
    setLoadError('')
    const failed = (error: unknown) => {
      if (!signal.aborted) setLoadError(error instanceof Error ? error.message : String(error))
    }
    await Promise.all([
      recoverRead(attemptSignal => api.libraries.list(attemptSignal), signal).then(value => {
        if (!signal.aborted) { setLibraries(value); setReady(true) }
      }).catch(failed),
      recoverRead(attemptSignal => api.settings.get(attemptSignal), signal).then(value => {
        if (!signal.aborted) setSavedSettings(value)
      }).catch(failed),
    ])
  }, [])

  // 外观实时预览：设置页改动背景或壁纸文字对比度时立即应用（只改内存状态，不写库；点「保存」才持久化）
  const applyBackgroundPreview = useCallback((patch: Partial<AppSettings>) => {
    const values: AppSettings = {}
    for (const [key, value] of Object.entries(patch)) if (typeof value === 'string') values[key] = value
    setBackgroundPreview(previous => ({ ...previous, ...values }))
  }, [])

  // Drafts only belong to the settings page. Persisted reads never erase an
  // in-progress preview; leaving the page restores the last saved appearance.
  useEffect(() => {
    if (location.pathname !== '/settings') setBackgroundPreview({})
  }, [location.pathname])

  useEffect(() => {
    void refresh()
    return () => refreshController.current?.abort()
  }, [refresh])

  return (
    <div className="h-screen overflow-clip bg-bg text-text-primary" data-background-type={backgroundType}>
      {moduleBackgrounds.map(({ moduleId, Background }) => (
        <ModuleErrorBoundary key={moduleId} moduleId={moduleId} fallback={null}>
          <Background settings={settings} />
        </ModuleErrorBoundary>
      ))}
      <DesktopPresentation>
        <Sidebar libraries={libraries} onRefresh={refresh} />
        <main className="desktop-content min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <ModuleProviders>
            {loadError && (
              <div role="alert" className="clean-notice m-4 rounded-xl border border-red-300/20 bg-red-400/[0.08] px-4 py-3 text-sm text-red-200">
                媒体库或外观设置读取失败：{loadError}
                <button type="button" className="ml-3 underline" onClick={() => { void refresh() }}>重试</button>
              </div>
            )}
            {(snapshotError || Object.keys(loadErrors).length > 0) && (
              <div role="alert" className="clean-notice fixed right-4 top-4 z-[70] max-w-sm rounded-xl border border-red-300/20 bg-[#2a1118]/95 px-4 py-3 text-xs text-red-100 shadow-xl">
                {snapshotError ? `模块状态读取失败：${snapshotError}` : `模块加载失败：${Object.entries(loadErrors).map(([id, message]) => `${id}: ${message}`).join('；')}`}
              </div>
            )}
            {!ready ? <div className="clean-state p-6 text-text-secondary">加载中…</div> : (
              <Routes>
                <Route path="/" element={libraries.length > 0 ? <Navigate to={`/library/${libraries[0].id}`} replace /> : <Navigate to="/settings" replace />} />
                <Route path="/library/:id" element={<LibraryRoute libraries={libraries} onLibrariesChange={refresh} />} />
                <Route path="/folder/:id" element={<FolderRoute />} />
                <Route path="/file/:id" element={<FileRoute />} />
                <Route path="/all" element={<LibraryView showAll libraries={libraries} onLibrariesChange={refresh} />} />
                <Route path="/settings" element={<Settings onLibrariesChange={refresh} onBackgroundPreview={applyBackgroundPreview} />} />
                {moduleRoutes.map(route => (
                  <Route key={`${route.moduleId}:${route.path}`} path={route.path} element={<ModuleErrorBoundary moduleId={route.moduleId}>{route.element}</ModuleErrorBoundary>} />
                ))}
                <Route path="*" element={<UnavailableRoute />} />
              </Routes>
            )}
          </ModuleProviders>
        </main>
      </DesktopPresentation>
    </div>
  )
}
