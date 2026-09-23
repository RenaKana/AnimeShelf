/** Data-only module contract. Safe to import from either runtime. */
export interface ModuleManifest {
  id: string
  name: string
  version: string
  defaultEnabled: boolean
  requires: string[]
  optional: string[]
  routes?: Array<{ method: string; path: string }>
  pages?: string[]
}

export interface ModuleStatus extends ModuleManifest {
  configuredEnabled: boolean
  active: boolean
  reason: string | null
}

export interface ModuleSnapshot {
  modules: ModuleStatus[]
  restartRequired: boolean
}

export interface ModuleConfigurationPatch {
  enabled: Record<string, boolean>
}
