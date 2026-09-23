import { Component, createContext, useCallback, useContext, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import type { ModuleSnapshot } from '../../shared/modules'
import { loaders as generatedLoaders } from '../../.generated/client-modules'
import { read, request } from '../api'
import type { ClientModuleLoader, LoadedClientModule } from './contracts'

export interface ClientModuleLoadResult {
  modules: LoadedClientModule[]
  errors: Record<string, string>
}

const CORE_CLIENT_ROUTES = new Set([
  '/',
  '/all',
  '/library/:param',
  '/folder/:param',
  '/file/:param',
  '/settings',
])

const normalizeClientRoute = (path: string) => (
  path.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/$/, '') || '/'
)

export async function loadClientModules(
  snapshot: ModuleSnapshot,
  loaders: Record<string, ClientModuleLoader>,
): Promise<ClientModuleLoadResult> {
  const active = snapshot.modules.filter(module => module.active)
  const activeById = new Map(active.map(module => [module.id, module]))
  const ordered: typeof active = []
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (status: (typeof active)[number]) => {
    if (visited.has(status.id)) return
    if (visiting.has(status.id)) return
    visiting.add(status.id)
    for (const requiredId of status.requires) {
      const required = activeById.get(requiredId)
      if (required) visit(required)
    }
    visiting.delete(status.id)
    visited.add(status.id)
    ordered.push(status)
  }
  for (const status of active) visit(status)

  const modules: LoadedClientModule[] = []
  const loadedIds = new Set<string>()
  const errors: Record<string, string> = {}
  const claimedRoutes = new Map<string, string>()

  for (const status of ordered) {
    const unavailable = status.requires.filter(requiredId => !loadedIds.has(requiredId))
    if (unavailable.length > 0) {
      errors[status.id] = `依赖模块加载失败：${unavailable.join('、')}`
      continue
    }

    try {
      const loader = loaders[status.id]
      if (!loader) throw new Error(`缺少前端入口：${status.id}`)
      const loaded = await loader()
      const contribution = loaded.default
      const declaredRoutes = [...new Set((status.pages ?? []).map(normalizeClientRoute))].sort()
      const actualRoutes = [...new Set((contribution.routes ?? []).map(route => normalizeClientRoute(route.path)))].sort()
      const coreCollision = actualRoutes.find(path => CORE_CLIENT_ROUTES.has(path))
      if (coreCollision) throw new Error(`页面 ${coreCollision} 与核心路由冲突`)
      const moduleCollision = actualRoutes.find(path => claimedRoutes.has(path))
      if (moduleCollision) throw new Error(`页面 ${moduleCollision} 与模块 ${claimedRoutes.get(moduleCollision)} 冲突`)
      if (declaredRoutes.length !== actualRoutes.length || declaredRoutes.some((path, index) => path !== actualRoutes[index])) {
        throw new Error(`前端页面与 manifest 声明不一致：声明 [${declaredRoutes.join(', ')}]，实际 [${actualRoutes.join(', ')}]`)
      }

      const next = { id: status.id, contribution } satisfies LoadedClientModule
      modules.push(next)
      loadedIds.add(status.id)
      for (const path of actualRoutes) claimedRoutes.set(path, status.id)
    } catch (reason) {
      errors[status.id] = reason instanceof Error ? reason.message : String(reason)
    }
  }

  return { modules, errors }
}

interface ModulesContextValue {
  ready: boolean
  snapshot: ModuleSnapshot | null
  modules: LoadedClientModule[]
  loadErrors: Record<string, string>
  snapshotError: string | null
  moduleEnabled: (id: string) => boolean
  services: ReadonlyMap<string, unknown>
  configure: (enabled: Record<string, boolean>) => Promise<ModuleSnapshot>
}

const ModulesContext = createContext<ModulesContextValue | null>(null)

export function ModulesProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [snapshot, setSnapshot] = useState<ModuleSnapshot | null>(null)
  const [modules, setModules] = useState<LoadedClientModule[]>([])
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [snapshotError, setSnapshotError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    const load = async () => {
      try {
        const nextSnapshot = await read<ModuleSnapshot>('/api/modules', controller.signal)
        const result = await loadClientModules(nextSnapshot, generatedLoaders as Record<string, ClientModuleLoader>)
        if (!current) return
        setSnapshot(nextSnapshot)
        setModules(result.modules)
        setLoadErrors(result.errors)
      } catch (error) {
        if (!current) return
        setSnapshotError(error instanceof Error ? error.message : String(error))
      } finally {
        if (current) setReady(true)
      }
    }
    void load()
    return () => { current = false; controller.abort() }
  }, [])

  const loadedIds = useMemo(() => new Set(modules.map(module => module.id)), [modules])
  const services = useMemo(() => {
    const registry = new Map<string, unknown>()
    for (const loaded of modules) {
      for (const [id, service] of Object.entries(loaded.contribution.services ?? {})) {
        if (!registry.has(id)) registry.set(id, service)
      }
    }
    return registry
  }, [modules])
  const moduleEnabled = useCallback((id: string) => (
    Boolean(snapshot?.modules.find(module => module.id === id)?.active && loadedIds.has(id))
  ), [loadedIds, snapshot])

  const configure = useCallback(async (enabled: Record<string, boolean>) => {
    const next = await request<ModuleSnapshot>('/api/modules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-AnimeShelf-Owner': '1' },
      body: JSON.stringify({ enabled }),
    })
    setSnapshot(next)
    return next
  }, [])

  const value = useMemo<ModulesContextValue>(() => ({
    ready,
    snapshot,
    modules,
    loadErrors,
    snapshotError,
    moduleEnabled,
    services,
    configure,
  }), [configure, loadErrors, moduleEnabled, modules, ready, services, snapshot, snapshotError])

  if (!ready) return <div className="clean-state flex h-screen items-center justify-center bg-bg text-text-secondary">正在加载模块…</div>
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>
}

export function useModules(): ModulesContextValue {
  const value = useContext(ModulesContext)
  if (!value) throw new Error('useModules must be used inside ModulesProvider')
  return value
}

export function useModuleEnabled(id: string): boolean {
  return useModules().moduleEnabled(id)
}

export function useModuleService<T>(id: string): T | undefined {
  return useModules().services.get(id) as T | undefined
}

interface ModuleErrorBoundaryProps {
  moduleId: string
  fallback?: ReactNode
  children: ReactNode
}

interface ModuleErrorBoundaryState { error: Error | null }

export class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, ModuleErrorBoundaryState> {
  state: ModuleErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ModuleErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Module ${this.props.moduleId} failed to render`, error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div role="alert" className="clean-notice rounded-xl border border-red-300/20 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200">
        模块“{this.props.moduleId}”加载失败：{this.state.error.message}
      </div>
    )
  }
}

export function ModuleProviders({ children }: { children: ReactNode }) {
  const { modules } = useModules()
  return modules.reduceRight<ReactNode>((content, loaded) => (
    (loaded.contribution.providers ?? []).reduceRight<ReactNode>((nested, Provider, index) => (
      <ModuleErrorBoundary key={`${loaded.id}:provider:${index}`} moduleId={loaded.id} fallback={nested}>
        <Provider>{nested}</Provider>
      </ModuleErrorBoundary>
    ), content)
  ), children)
}
