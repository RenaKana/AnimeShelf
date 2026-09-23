import type { ComponentType, ReactNode } from 'react'
import type { FolderDetail, FolderView, Library, Settings } from '../types'

export interface ModuleSettingsProps {
  onRefresh?: () => void
  onBackgroundPreview?: (patch: Partial<Settings>) => void
  embedded?: boolean
}

export interface ModuleFolderProps {
  folder: FolderDetail
  onRefresh: () => Promise<void> | void
  onUpdate: (folder: FolderDetail) => void
  onNotice: (message: string) => void
}

export interface ModuleFolderViewProps extends ModuleFolderProps {
  onOpenCoreView: () => void
}

export interface ModuleLibraryToolbarProps {
  libraryId?: number
  items: FolderView[]
  onRefresh: () => Promise<void> | void
  onStatus: (message: string) => void
}

export type ModuleLibraryTaskScope = 'current-library' | 'all-libraries'

export interface ModuleLibraryTaskPanelProps extends ModuleLibraryToolbarProps {
  scopeLabel: string
}

/** Controllers stay mounted outside the menu; only their action buttons are portaled. */
export interface ModuleLibraryActionsProps extends ModuleLibraryToolbarProps {
  folderIds: number[]
  scopeLabel: string
  scopeKey: string
  scopeReady: boolean
  menuContainer: HTMLElement | null
  closeMenu: () => void
}

export interface ModuleSidebarSectionProps {
  collapsed: boolean
}

export interface ModuleFolderPanel {
  id: string
  slot: 'sidebar' | 'content'
  component: ComponentType<ModuleFolderProps>
}

export interface ModuleFolderView {
  id: string
  matches: (folder: FolderDetail) => boolean
  component: ComponentType<ModuleFolderViewProps>
  coreViewReturnLabel?: string
}

export interface ClientModule {
  routes?: Array<{ path: string; element: ReactNode }>
  navItems?: Array<{ to: string; label: string; icon: ReactNode; order?: number }>
  sidebarSections?: Array<{ id: string; order?: number; component: ComponentType<ModuleSidebarSectionProps> }>
  settingsSections?: Array<{ id: string; label: string; order?: number; group?: 'appearance'; component: ComponentType<ModuleSettingsProps> }>
  providers?: Array<ComponentType<{ children: ReactNode }>>
  Background?: ComponentType<{ settings: Settings }>
  folderPanels?: ModuleFolderPanel[]
  folderViews?: ModuleFolderView[]
  libraryToolbars?: Array<{ id: string; component: ComponentType<ModuleLibraryToolbarProps>; supportsAllLibraries?: boolean }>
  libraryActions?: Array<{ id: string; component: ComponentType<ModuleLibraryActionsProps> }>
  libraryTaskPanels?: Array<{
    id: string
    label: string
    description: string
    scope: ModuleLibraryTaskScope
    component: ComponentType<ModuleLibraryTaskPanelProps>
    supportsAllLibraries?: boolean
  }>
  services?: Record<string, unknown>
}

export type ClientModuleLoader = () => Promise<{ default: ClientModule }>

export interface LoadedClientModule {
  id: string
  contribution: ClientModule
}
