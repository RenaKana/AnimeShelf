/** User organization references canonical media, never directory copies or global season numbers. */
export interface CollectionWatchEntry { id: string; targetKey: string; pending?: boolean }
export interface CollectionStructureGroup { id: string; title: string; memberKeys: string[] }
export interface CollectionOrganization {
  version: 1
  orderSource: 'existing' | 'user'
  watchEntries: CollectionWatchEntry[]
  groups: CollectionStructureGroup[]
}
export const collectionMemberKey = (itemKey: string) => `item:${itemKey}`
export const collectionWatchId = (targetKey: string) => `watch:${targetKey}`

/** Missing references stay in place. Only explicit membership removal may delete them. */
export function resolveCollectionOrganization(value: CollectionOrganization | null | undefined, memberKeys: readonly string[]): CollectionOrganization {
  const result: CollectionOrganization = value ? structuredClone(value) : { version: 1, orderSource: 'existing', watchEntries: [], groups: [] }
  const present = new Set(result.watchEntries.map(entry => entry.targetKey))
  const ids = new Set(result.watchEntries.map(entry => entry.id))
  for (const targetKey of memberKeys) if (!present.has(targetKey)) {
    const baseId=collectionWatchId(targetKey)
    let id=baseId, suffix=2
    while(ids.has(id)) id=`${baseId}:${suffix++}`
    result.watchEntries.push({ id, targetKey, ...(result.orderSource === 'user' ? { pending: true } : {}) })
    ids.add(id)
    present.add(targetKey)
  }
  return result
}

export function nextCollectionEntry(organization: CollectionOrganization, entryId: string): CollectionWatchEntry | null {
  const index = organization.watchEntries.findIndex(entry => entry.id === entryId)
  return index < 0 ? null : organization.watchEntries[index + 1] ?? null
}

export function removeCollectionMembers(organization: CollectionOrganization, keys: readonly string[]): CollectionOrganization {
  const removed = new Set(keys)
  return { ...organization, watchEntries: organization.watchEntries.filter(entry => !removed.has(entry.targetKey)),
    groups: organization.groups.map(group => ({ ...group, memberKeys: group.memberKeys.filter(key => !removed.has(key)) })) }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1500

/** Validate edits without silently repairing them. Existing dangling references may be retained/removed. */
export function validateCollectionOrganization(input: unknown, memberKeys: readonly string[], previous?: CollectionOrganization | null): CollectionOrganization {
  const fail = (message: string): never => { throw new Error(message) }
  if (!record(input) || !exact(input, ['version', 'orderSource', 'watchEntries', 'groups']) || input.version !== 1
    || !['existing', 'user'].includes(String(input.orderSource)) || !Array.isArray(input.watchEntries) || !Array.isArray(input.groups)
    || input.watchEntries.length > 5000 || input.groups.length > 200) return fail('合集组织配置无效')
  const allowed = new Set([...memberKeys, ...(previous?.watchEntries.map(entry => entry.targetKey) ?? []), ...(previous?.groups.flatMap(group => group.memberKeys) ?? [])])
  const ids = new Set<string>(), targets = new Set<string>()
  const watchEntries: CollectionWatchEntry[] = input.watchEntries.map(candidate => {
    if (!record(candidate) || !exact(candidate, ['id', 'targetKey', 'pending']) || !identifier(candidate.id) || !identifier(candidate.targetKey)
      || !allowed.has(candidate.targetKey) || ids.has(candidate.id) || targets.has(candidate.targetKey)
      || (candidate.pending !== undefined && typeof candidate.pending !== 'boolean')) return fail('观看顺序包含重复或不属于本合集的条目')
    ids.add(candidate.id); targets.add(candidate.targetKey)
    return { id: candidate.id, targetKey: candidate.targetKey, ...(candidate.pending ? { pending: true } : {}) }
  })
  if (memberKeys.some(key => !targets.has(key))) return fail('观看顺序必须保留全部合集成员')
  const groupIds = new Set<string>()
  const groups: CollectionStructureGroup[] = input.groups.map(candidate => {
    if (!record(candidate) || !exact(candidate, ['id', 'title', 'memberKeys']) || !identifier(candidate.id) || groupIds.has(candidate.id)
      || typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.trim().length > 200 || !Array.isArray(candidate.memberKeys)
      || candidate.memberKeys.length > 5000 || candidate.memberKeys.some(key => typeof key !== 'string' || !allowed.has(key))
      || new Set(candidate.memberKeys).size !== candidate.memberKeys.length) return fail('系列分组包含无效名称或成员')
    groupIds.add(candidate.id)
    return { id: candidate.id, title: candidate.title.trim(), memberKeys: candidate.memberKeys as string[] }
  })
  return { version: 1, orderSource: input.orderSource as CollectionOrganization['orderSource'], watchEntries, groups }
}
