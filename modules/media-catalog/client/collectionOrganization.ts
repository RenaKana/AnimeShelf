import { collectionMemberKey, resolveCollectionOrganization, type CollectionOrganization, type CollectionStructureGroup, type CollectionWatchEntry } from '../../../shared/collection-organization'
import type { CollectionRow, CollectionWork } from './collectionNavigation'

export interface ResolvedCollectionTarget {
  targetKey: string
  entryId: string
  work: CollectionWork | null
  pending: boolean
  missing: boolean
}

export interface ResolvedCollectionGroup {
  group: CollectionStructureGroup
  members: ResolvedCollectionTarget[]
}

export interface ResolvedCollectionViews {
  works: Map<string, CollectionWork>
  watch: ResolvedCollectionTarget[]
  groups: ResolvedCollectionGroup[]
  ungrouped: ResolvedCollectionTarget[]
}

export function flattenCollectionWorks(rows: readonly CollectionRow[]): CollectionWork[] {
  const works = new Map<string, CollectionWork>()
  const add = (work: CollectionWork) => works.set(collectionMemberKey(work.item.item_key), work)
  for (const row of rows) {
    if (row.type === 'work') add(row)
    else row.works.forEach(add)
  }
  return [...works.values()]
}

const targetFrom = (entry: CollectionWatchEntry, works: Map<string, CollectionWork>): ResolvedCollectionTarget => ({
  targetKey: entry.targetKey,
  entryId: entry.id,
  work: works.get(entry.targetKey) ?? null,
  pending: entry.pending === true,
  missing: !works.has(entry.targetKey),
})

export function resolveCollectionViews(rows: readonly CollectionRow[], organization: CollectionOrganization): ResolvedCollectionViews {
  const works = new Map(flattenCollectionWorks(rows).map(work => [collectionMemberKey(work.item.item_key), work]))
  const resolved = resolveCollectionOrganization(organization, [...works.keys()])
  const entryByTarget = new Map(resolved.watchEntries.map(entry => [entry.targetKey, entry]))
  const watch = resolved.watchEntries.map(entry => targetFrom(entry, works))
  const grouped = new Set<string>()
  const groups = organization.groups.map(group => ({
    group,
    members: group.memberKeys.map(targetKey => {
      grouped.add(targetKey)
      const entry = entryByTarget.get(targetKey) ?? { id: `watch:${targetKey}`, targetKey }
      return targetFrom(entry, works)
    }),
  }))
  return { works, watch, groups, ungrouped: watch.filter(target => !grouped.has(target.targetKey)) }
}

export function resolvedTargetTitle(target: ResolvedCollectionTarget): string {
  return target.work?.title ?? target.targetKey.replace(/^item:/, '')
}

export function filterCollectionTargets(targets: readonly ResolvedCollectionTarget[], query: string): ResolvedCollectionTarget[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...targets]
  return targets.filter(target => `${resolvedTargetTitle(target)} ${target.work?.label ?? ''}`.toLocaleLowerCase().includes(normalized))
}

export function moveWatchEntry(organization: CollectionOrganization, entryId: string, offset: number): CollectionOrganization {
  const watchEntries = organization.watchEntries.map(entry => ({ ...entry }))
  const index = watchEntries.findIndex(entry => entry.id === entryId)
  const destination = index + offset
  if (index < 0 || destination < 0 || destination >= watchEntries.length) return organization
  ;[watchEntries[index], watchEntries[destination]] = [watchEntries[destination], watchEntries[index]]
  watchEntries[destination] = { ...watchEntries[destination], pending: false }
  return { ...organization, orderSource: 'user', watchEntries }
}

export function acknowledgeWatchEntry(organization: CollectionOrganization, entryId: string): CollectionOrganization {
  return { ...organization, orderSource: 'user', watchEntries: organization.watchEntries.map(entry => entry.id === entryId ? { ...entry, pending: false } : entry) }
}

export function confirmWatchOrder(organization: CollectionOrganization): CollectionOrganization {
  return { ...organization, orderSource: 'user', watchEntries: organization.watchEntries.map(entry => ({ id: entry.id, targetKey: entry.targetKey })) }
}

export function moveStructureGroup(organization: CollectionOrganization, groupId: string, offset: number): CollectionOrganization {
  const groups = organization.groups.map(group => ({ ...group, memberKeys: [...group.memberKeys] }))
  const index = groups.findIndex(group => group.id === groupId)
  const destination = index + offset
  if (index < 0 || destination < 0 || destination >= groups.length) return organization
  ;[groups[index], groups[destination]] = [groups[destination], groups[index]]
  return { ...organization, groups }
}

export function moveStructureMember(organization: CollectionOrganization, groupId: string, targetKey: string, offset: number): CollectionOrganization {
  return { ...organization, groups: organization.groups.map(group => {
    if (group.id !== groupId) return group
    const memberKeys = [...group.memberKeys]
    const index = memberKeys.indexOf(targetKey)
    const destination = index + offset
    if (index < 0 || destination < 0 || destination >= memberKeys.length) return group
    ;[memberKeys[index], memberKeys[destination]] = [memberKeys[destination], memberKeys[index]]
    return { ...group, memberKeys }
  }) }
}

export function setStructureMembership(organization: CollectionOrganization, groupId: string, targetKey: string, included: boolean): CollectionOrganization {
  return { ...organization, groups: organization.groups.map(group => {
    if (group.id !== groupId) return group
    const current = group.memberKeys.includes(targetKey)
    if (current === included) return group
    return { ...group, memberKeys: included ? [...group.memberKeys, targetKey] : group.memberKeys.filter(key => key !== targetKey) }
  }) }
}

export function nextCollectionTarget(views: ResolvedCollectionViews, entryId: string): ResolvedCollectionTarget | null {
  const index = views.watch.findIndex(target => target.entryId === entryId)
  return index < 0 ? null : views.watch[index + 1] ?? null
}

export function collectionFolderUrl(folderId: number, rootId: number, entryId: string, view: 'watch' | 'structure'): string {
  const search = new URLSearchParams({ collection: String(rootId), entry: entryId, view })
  return `/folder/${folderId}?${search.toString()}`
}