import type { ModuleManifest } from '../shared/modules'
export function discoverModules(root?: string): ModuleManifest[]
export function generateModules(root?: string): ModuleManifest[]
export function watchModules(onChange?: () => void, root?: string): () => void
