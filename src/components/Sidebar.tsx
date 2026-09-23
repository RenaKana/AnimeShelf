import { useEffect, useRef, useState } from 'react'
import type { Library } from '../types'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  HomeIcon,
  LibraryIcon,
  RefreshIcon,
  SettingsIcon,
} from './ui/Icons'
import { SidebarNavItem, SidebarSectionLabel } from './ui/SidebarNavigation'
import { readBooleanPref, UI_PREF_KEYS, writePref } from '../lib/uiPreferences'
import { ModuleErrorBoundary, useModules } from '../modules/registry'
import ServiceRestartControl from './ServiceRestartControl'
import { SidebarPresentation } from './design/DesktopPresentation'

export default function Sidebar({ libraries }: { libraries: Library[]; onRefresh: () => void }) {
  const { modules } = useModules()
  const [pinned, setPinned] = useState(() => { try { return readBooleanPref(UI_PREF_KEYS.sidebarPinned) } catch { return false } })
  const [revealed, setRevealed] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const focusInside = useRef(false)
  const ownedOverlay = useRef<HTMLElement | null>(null)
  const [saveError, setSaveError] = useState('')
  const [compactViewport, setCompactViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  ))
  const open = pinned || revealed
  // One navigation tree: compact icons remain reachable while unpinned.
  const effectiveCollapsed = !open
  const cancelClose = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const scheduleClose = () => {
    cancelClose()
    timer.current = setTimeout(() => {
      if (!pointerInside.current && !focusInside.current && !ownedOverlay.current?.isConnected) setRevealed(false)
    }, 200)
  }
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      const inNav = Boolean(dockRef.current?.querySelector('aside')?.contains(target))
      const overlay = target.closest<HTMLElement>('[role="dialog"], [role="listbox"]')
      if (overlay && (focusInside.current || dockRef.current?.contains(event.relatedTarget as Node))) ownedOverlay.current = overlay
      else if (!overlay || !ownedOverlay.current?.contains(target)) ownedOverlay.current = null
      focusInside.current = inNav && target.matches(':focus-visible')
      if (focusInside.current || ownedOverlay.current) { cancelClose(); setRevealed(true) }
      else if (!pointerInside.current) scheduleClose()
    }
    const stored = (event: StorageEvent) => {
      if (event.key === UI_PREF_KEYS.sidebarPinned || event.key === null) setPinned(event.newValue === '1')
    }
    document.addEventListener('focusin', focus)
    window.addEventListener('storage', stored)
    return () => { cancelClose(); document.removeEventListener('focusin', focus); window.removeEventListener('storage', stored) }
  }, [])
  useEffect(() => {
    if (!open || pinned) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (dockRef.current?.contains(target) || ownedOverlay.current?.contains(target)) return
      pointerInside.current = false; focusInside.current = false
      cancelClose(); setRevealed(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, pinned])
  const moduleNavItems = modules.flatMap(loaded => (
    (loaded.contribution.navItems ?? []).map(item => ({ ...item, moduleId: loaded.id }))
  )).sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
  const moduleSidebarSections = modules.flatMap(loaded => (
    (loaded.contribution.sidebarSections ?? []).map(section => ({ ...section, moduleId: loaded.id }))
  )).sort((left, right) => (left.order ?? 100) - (right.order ?? 100))

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const updateCompactViewport = (event: MediaQueryListEvent) => setCompactViewport(event.matches)
    setCompactViewport(media.matches)
    media.addEventListener('change', updateCompactViewport)
    return () => media.removeEventListener('change', updateCompactViewport)
  }, [])

  const toggle = () => {
    const next = !pinned
    setPinned(next)
    setRevealed(true)
    const saved = writePref(UI_PREF_KEYS.sidebarPinned, next)
    setSaveError(saved ? '' : '侧栏状态已生效，但无法保存到本机。')
  }

  return (
    <div ref={dockRef} className="sidebar-dock" data-pinned={pinned && !compactViewport} data-open={open}
      onPointerEnter={event => { if (event.pointerType === 'touch') return; pointerInside.current = true; cancelClose(); setRevealed(true) }}
      onPointerLeave={event => { if (event.pointerType === 'touch') return; pointerInside.current = false; scheduleClose() }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || pinned || ownedOverlay.current) return
        event.preventDefault(); focusInside.current = false; pointerInside.current = false; cancelClose(); setRevealed(false); edgeRef.current?.focus()
      }}>
    <button ref={edgeRef} type="button" className="sidebar-edge" aria-label="展开主导航" aria-expanded={open} aria-controls="desktop-navigation"
      onClick={event => {
        cancelClose(); setRevealed(true)
        if (event.detail === 0) {
          focusInside.current = true
          requestAnimationFrame(() => dockRef.current?.querySelector<HTMLAnchorElement>('nav a')?.focus())
        }
      }}><ChevronRightIcon width={15} height={15} /></button>
    <SidebarPresentation id="desktop-navigation" collapsed={effectiveCollapsed}
      className="flex h-full flex-col border-r border-white/[0.08]">
      <div className={`sidebar-brand flex h-[68px] shrink-0 items-center border-b border-white/[0.06] ${effectiveCollapsed ? 'justify-center px-2' : 'gap-3 px-4'}`}>
        <div className="sidebar-logo flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-fill/90 to-accent-fill/80 text-on-accent shadow-[0_8px_22px_rgb(var(--ui-accent)/0.28)]">
          <LibraryIcon width={19} height={19} />
        </div>
        {!effectiveCollapsed && (
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight text-white">AnimeShelf</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-text-secondary/55">Media Library</div>
          </div>
        )}
      </div>

      <nav aria-label="主导航" className={`flex-1 overflow-y-auto py-3 ${effectiveCollapsed ? 'flex flex-col items-center gap-1 px-2' : 'px-2'}`}>
        <SidebarSectionLabel>浏览</SidebarSectionLabel>
        <div className="space-y-1">
          <SidebarNavItem to="/all" icon={<HomeIcon />} label="全部媒体" collapsed={effectiveCollapsed} />
          {moduleNavItems.map(item => <SidebarNavItem key={`${item.moduleId}:${item.to}`} to={item.to} icon={item.icon} label={item.label} collapsed={effectiveCollapsed} />)}
        </div>

        {libraries.length > 0 && <SidebarSectionLabel>媒体库</SidebarSectionLabel>}
        <div className="space-y-1">
          {libraries.map(lib => (
            <SidebarNavItem key={lib.id} to={`/library/${lib.id}`} icon={<LibraryIcon />} label={lib.name} collapsed={effectiveCollapsed} />
          ))}
          {libraries.length === 0 && <SidebarNavItem to="/settings" icon={<LibraryIcon />} label="添加媒体库" collapsed={effectiveCollapsed} />}
        </div>

        {moduleSidebarSections.map(({ moduleId, id, component: Section }) => (
          <ModuleErrorBoundary key={`${moduleId}:${id}`} moduleId={moduleId} fallback={null}>
            <Section collapsed={effectiveCollapsed} />
          </ModuleErrorBoundary>
        ))}
      </nav>

      <div className={`sidebar-footer shrink-0 border-t border-white/[0.06] p-2 ${effectiveCollapsed ? 'flex flex-col items-center gap-1' : 'space-y-1'}`}>
        <button
          type="button"
          onClick={() => window.location.reload()}
          title="刷新界面"
          className={`flex h-9 items-center rounded-lg text-text-secondary transition-colors hover:bg-white/[0.055] hover:text-text-primary ${effectiveCollapsed ? 'w-9 justify-center' : 'w-full gap-2.5 px-3'}`}>
          <RefreshIcon />
          {!effectiveCollapsed && <span className="text-sm font-medium">刷新</span>}
        </button>
        <ServiceRestartControl compact={effectiveCollapsed} />
        <SidebarNavItem to="/settings" icon={<SettingsIcon />} label="设置" collapsed={effectiveCollapsed} />
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-pressed={pinned}
        aria-label={pinned ? '取消固定侧栏' : '固定侧栏'}
        title={pinned ? '取消固定侧栏' : '固定侧栏'}
        className="flex h-9 shrink-0 items-center justify-center border-t border-white/[0.06] text-text-secondary transition hover:bg-white/[0.035] hover:text-text-primary disabled:cursor-default disabled:opacity-45">
        <span className="flex items-center gap-1.5 text-xs"><ChevronLeftIcon width={15} height={15} />{!effectiveCollapsed && (pinned ? '取消固定侧栏' : '固定侧栏')}</span>
      </button>
      {saveError && <span role="status" className="px-3 py-1 text-xs text-amber-300">{saveError}</span>}
    </SidebarPresentation>
    </div>
  )
}
