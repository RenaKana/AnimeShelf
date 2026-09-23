import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { ModuleSidebarSectionProps } from '../../../src/modules/contracts'
import type { FolderView } from '../../../src/types'
import { PinIcon } from '../../../src/components/ui/Icons'
import { SidebarNavItem, SidebarSectionLabel } from '../../../src/components/ui/SidebarNavigation'
import { read } from '../../../src/api'

export default function MediaCatalogSidebarSection({ collapsed }: ModuleSidebarSectionProps) {
  const [pinnedDirs, setPinnedDirs] = useState<FolderView[]>([])
  const loadController = useRef<AbortController | null>(null)
  const location = useLocation()
  const reloadPinnedDirs = useCallback(() => {
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    read<FolderView[]>('/api/folders?pinned=1', controller.signal).then(value => {
      if (!controller.signal.aborted) setPinnedDirs(value)
    }).catch(error => { if (!controller.signal.aborted) console.error(error) })
  }, [])

  useEffect(() => {
    reloadPinnedDirs()
    return () => loadController.current?.abort()
  }, [location.pathname, reloadPinnedDirs])

  useEffect(() => {
    const onCollectionChanged = () => reloadPinnedDirs()
    window.addEventListener('animeshelf:collection-changed', onCollectionChanged)
    return () => window.removeEventListener('animeshelf:collection-changed', onCollectionChanged)
  }, [reloadPinnedDirs])

  if (pinnedDirs.length === 0) return null
  return <>
    {!collapsed && <SidebarSectionLabel>合集</SidebarSectionLabel>}
    <div className={`${collapsed ? 'contents' : 'space-y-1'}`}>
      {pinnedDirs.map(dir => (
        <SidebarNavItem key={dir.id} to={`/folder/${dir.id}`} icon={<PinIcon />} label={dir.name} collapsed={collapsed} />
      ))}
    </div>
  </>
}
