import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MediaCatalogFolderGroup, MediaCatalogPhysicalFolder, MediaCatalogWorkGroupDisplay, MediaCatalogWorkGroupDisplayMember } from '../mediaCatalog'
import { formatSeasonNumbers, groupCanonicalMediaWorkGroups, groupCanonicalPhysicalFolders, groupCanonicalUngroupedMediaItems, mediaCatalogDisplayLabel, mediaCatalogKindLabel, mediaCatalogPhysicalFolderStatus, mediaCatalogWorkGroupMemberStatus, physicalFolderTypeLabels, shouldShowCanonicalItemTitle, shouldShowCanonicalMappingFolderName } from '../mediaCatalog'
import type { MediaCatalogEntry, MediaCatalogKind, MediaCatalogMapping, MediaCatalogSnapshot, MediaCatalogV2 } from '../../../../src/types'
import { api } from '../api'
import { mediaCatalogWorkGroupOpenKey, readBooleanPref, writePref } from '../../../../src/lib/uiPreferences'
import Button from '../../../../src/components/ui/Button'
import { ChevronDownIcon, FolderIcon } from '../../../../src/components/ui/Icons'
import SelectMenu from '../../../../src/components/ui/SelectMenu'
import { MEDIA_DOMAIN_LABELS } from '../../../../shared/media-domain'

export interface MediaCatalogWorkGroupsProps {
  folderId: number
  folderName: string
  catalog: MediaCatalogV2
  legacyGroupByFolderId: Map<number, MediaCatalogFolderGroup>
  catalogBusy: string | null
  setCatalogBusy: (busy: 'rename' | 'merge' | 'detach' | 'attach' | 'split' | null) => void
  catalogEditingFolderId: number | null
  catalogDraftKind: MediaCatalogKind
  catalogDraftCustomLabel: string
  catalogDraftSeasons: string
  catalogDraftPart: string
  catalogDraftError: string
  applyCatalogSnapshot: (snapshot: MediaCatalogSnapshot, expectedFolderId: number) => void
  beginCatalogEdit: (group: MediaCatalogFolderGroup) => void
  setCatalogEditingFolderId: (folderId: number | null) => void
  setCatalogDraftKind: (kind: MediaCatalogKind) => void
  setCatalogDraftCustomLabel: (value: string) => void
  setCatalogDraftSeasons: (value: string) => void
  setCatalogDraftPart: (value: string) => void
  runCatalogSave: () => Promise<void>
  runCatalogRestore: (folderId: number) => Promise<void>
  runCatalogExclude: (folderId: number) => void
}

const MEDIA_CATALOG_KIND_OPTIONS: { value: MediaCatalogKind; label: string }[] = [
  { value: 'season', label: '季度' },
  { value: 'movie', label: '剧场版' },
  { value: 'ova', label: 'OVA' },
  { value: 'special', label: 'SP' },
  { value: 'custom', label: '自定义' },
  { value: 'extras', label: '附加内容' },
  { value: 'unknown', label: '待确认' },
]

const RELATION_ROLE_LABEL: Record<string, string> = {
  main: '主线',
  side_story: '侧线',
  spin_off: '外传',
  unknown: '关系待确认',
}

const STATUS_LABEL = {
  confirmed: '已确认',
  pending: '待确认',
  automatic: '自动识别',
} as const

const STATUS_CLASS = {
  confirmed: 'border-emerald-300/25 bg-emerald-400/10 text-emerald-200',
  pending: 'border-amber-300/25 bg-amber-400/10 text-amber-200',
  automatic: 'border-white/10 bg-white/[0.045] text-text-secondary',
} as const

function mappingTitle(mapping: MediaCatalogMapping): string {
  if (mapping.kind === 'season') {
    return mapping.season_number === null ? '季号未指定' : '第 ' + mapping.season_number + ' 季'
  }
  return mappingDisplayLabel(mapping)
}

function mappingDisplayLabel(mapping: MediaCatalogMapping): string {
  return mediaCatalogDisplayLabel(mapping.kind, mapping.custom_label)
}

function legacyEditingGroup(
  group: MediaCatalogWorkGroupDisplay,
  legacyGroupByFolderId: Map<number, MediaCatalogFolderGroup>,
  editingFolderId: number | null,
): MediaCatalogFolderGroup | undefined {
  return group.members
    .flatMap(member => member.physicalFolders)
    .map(folder => legacyGroupByFolderId.get(folder.folderId))
    .find(candidate => candidate?.folderId === editingFolderId)
}

function inlineMappings(folder: MediaCatalogPhysicalFolder): MediaCatalogMapping[] {
  return folder.mappings
}

export default function MediaCatalogWorkGroups({
  folderId,
  folderName,
  catalog,
  legacyGroupByFolderId,
  catalogBusy,
  setCatalogBusy,
  catalogEditingFolderId,
  catalogDraftKind,
  catalogDraftCustomLabel,
  catalogDraftSeasons,
  catalogDraftPart,
  catalogDraftError,
  applyCatalogSnapshot,
  beginCatalogEdit,
  setCatalogEditingFolderId,
  setCatalogDraftKind,
  setCatalogDraftCustomLabel,
  setCatalogDraftSeasons,
  setCatalogDraftPart,
  runCatalogSave,
  runCatalogRestore,
  runCatalogExclude,
}: MediaCatalogWorkGroupsProps) {
  const canonicalWorkGroups = useMemo(() => groupCanonicalMediaWorkGroups(catalog), [catalog])
  const canonicalUngroupedItems = useMemo(() => groupCanonicalUngroupedMediaItems(catalog), [catalog])
  const navigate = useNavigate()
  const [openState, setOpenState] = useState<Record<string, boolean>>({})
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [mergeTargets, setMergeTargets] = useState<Record<number, number | ''>>({})
  const [attachTargets, setAttachTargets] = useState<Record<number, number | ''>>({})
  const [splitGroupId, setSplitGroupId] = useState<number | null>(null)
  const [splitSelection, setSplitSelection] = useState<number[]>([])
  const [splitTitle, setSplitTitle] = useState('')
  const [error, setError] = useState('')

  const openKey = (groupId: number) => mediaCatalogWorkGroupOpenKey(catalog.root_folder_id, groupId)
  const readWorkGroupOpen = (groupId: number) => {
    const key = openKey(groupId)
    return openState[key] ?? readBooleanPref(key, true)
  }
  const setWorkGroupOpen = (groupId: number, open: boolean) => {
    const key = openKey(groupId)
    setOpenState(current => ({ ...current, [key]: open }))
    writePref(key, open)
  }

  const clearEditing = () => {
    setEditingGroupId(null)
    setTitleDraft('')
    setSplitGroupId(null)
    setSplitSelection([])
    setSplitTitle('')
    setMergeTargets({})
    setError('')
  }

  const beginTitleEdit = (group: MediaCatalogWorkGroupDisplay) => {
    if (catalogBusy) return
    setEditingGroupId(group.id)
    setTitleDraft(group.title)
    setError('')
  }

  const saveTitle = async (group: MediaCatalogWorkGroupDisplay) => {
    if (catalogBusy) return
    const title = titleDraft.trim()
    if (!title) {
      setError('作品组标题不能为空')
      return
    }
    setCatalogBusy('rename')
    setError('')
    try {
      const snapshot = await api.folders.renameMediaWorkGroup(folderId, group.id, title)
      applyCatalogSnapshot(snapshot, folderId)
      clearEditing()
    } catch (caught: any) {
      setError(caught?.message ?? '作品组标题保存失败')
    } finally {
      setCatalogBusy(null)
    }
  }

  const mergeGroup = async (source: MediaCatalogWorkGroupDisplay) => {
    if (catalogBusy) return
    const targetId = mergeTargets[source.id]
    const target = canonicalWorkGroups.find(group => group.id === targetId)
    if (targetId === undefined || targetId === '' || !target) {
      setError('请选择要合并到的另一个作品组')
      return
    }
    if (!window.confirm('确认将“' + source.title + '”合并到“' + target.title + '”？')) return
    setCatalogBusy('merge')
    setError('')
    try {
      const snapshot = await api.folders.mergeMediaWorkGroups(folderId, target.id, source.id)
      applyCatalogSnapshot(snapshot, folderId)
      clearEditing()
    } catch (caught: any) {
      setError(caught?.message ?? '作品组合并失败')
    } finally {
      setCatalogBusy(null)
    }
  }

  const detachMember = async (group: MediaCatalogWorkGroupDisplay, member: MediaCatalogWorkGroupDisplayMember) => {
    if (catalogBusy) return
    setCatalogBusy('detach')
    setError('')
    try {
      const snapshot = await api.folders.detachMediaWorkGroupItem(folderId, group.id, member.item.id)
      applyCatalogSnapshot(snapshot, folderId)
      clearEditing()
    } catch (caught: any) {
      setError(caught?.message ?? '移出作品组失败')
    } finally {
      setCatalogBusy(null)
    }
  }

  const attachMember = async (mediaItemId: number) => {
    if (catalogBusy) return
    const targetGroupId = attachTargets[mediaItemId] ?? canonicalWorkGroups[0]?.id ?? ''
    if (targetGroupId === '') {
      setError('当前没有可加入的作品组')
      return
    }
    setCatalogBusy('attach')
    setError('')
    try {
      const snapshot = await api.folders.attachMediaWorkGroupItem(folderId, targetGroupId, mediaItemId)
      applyCatalogSnapshot(snapshot, folderId)
      setAttachTargets(current => {
        const next = { ...current }
        delete next[mediaItemId]
        return next
      })
    } catch (caught: any) {
      setError(caught?.message ?? '加入作品组失败')
    } finally {
      setCatalogBusy(null)
    }
  }

  const beginSplit = (group: MediaCatalogWorkGroupDisplay) => {
    if (catalogBusy) return
    setWorkGroupOpen(group.id, true)
    setSplitGroupId(group.id)
    setSplitSelection([])
    setSplitTitle(group.title + ' 特别篇')
    setError('')
  }

  const toggleSplitMember = (mediaItemId: number) => {
    setSplitSelection(current => current.includes(mediaItemId)
      ? current.filter(id => id !== mediaItemId)
      : [...current, mediaItemId])
  }

  const splitGroup = async (group: MediaCatalogWorkGroupDisplay) => {
    if (catalogBusy) return
    if (splitSelection.length === 0 || splitSelection.length >= group.members.length) {
      setError('拆分时请选择至少一个且少于全部成员的条目')
      return
    }
    const title = splitTitle.trim()
    if (!title) {
      setError('请输入新作品组标题')
      return
    }
    setCatalogBusy('split')
    setError('')
    try {
      const snapshot = await api.folders.splitMediaWorkGroup(folderId, group.id, splitSelection, title)
      applyCatalogSnapshot(snapshot, folderId)
      clearEditing()
    } catch (caught: any) {
      setError(caught?.message ?? '作品组拆分失败')
    } finally {
      setCatalogBusy(null)
    }
  }

  const renderLegacyEditor = (group: MediaCatalogFolderGroup | undefined, selected: MediaCatalogEntry | undefined, hasManual: boolean) => {
    if (!group || !selected) return null
    return (
      <div className="mt-3 rounded-lg border border-accent/20 bg-accent/[0.045] p-3">
        <div className="text-[10px] font-medium text-text-secondary">调整物理目录：{group.folderName}</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_100px]">
          <label className="min-w-0 text-[10px] text-text-secondary">类型<SelectMenu ariaLabel={group.folderName + ' 的清单类型'} value={catalogDraftKind} options={MEDIA_CATALOG_KIND_OPTIONS} onChange={setCatalogDraftKind} disabled={catalogBusy !== null} className="mt-1 w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" /></label>
          {catalogDraftKind === 'custom'
            ? <label className="min-w-0 text-[10px] text-text-secondary">自定义名称<input aria-label={group.folderName + ' 的自定义类型名称'} value={catalogDraftCustomLabel} onChange={event => setCatalogDraftCustomLabel(event.target.value)} disabled={catalogBusy !== null} maxLength={32} placeholder="输入自定义名称" className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 text-xs text-text-primary outline-none focus:border-accent disabled:opacity-50" /></label>
            : <label className="min-w-0 text-[10px] text-text-secondary">季号（逗号分隔）<input aria-label={group.folderName + ' 的季号'} value={catalogDraftSeasons} onChange={event => setCatalogDraftSeasons(event.target.value)} disabled={catalogBusy !== null || catalogDraftKind !== 'season'} placeholder="例如 1,2" className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 text-xs text-text-primary outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-45" /></label>}
          <label className="min-w-0 text-[10px] text-text-secondary">Part（可空）<input aria-label={group.folderName + ' 的 Part'} value={catalogDraftPart} onChange={event => setCatalogDraftPart(event.target.value)} disabled={catalogBusy !== null} inputMode="numeric" placeholder="—" className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent disabled:opacity-50" /></label>
        </div>
        {catalogDraftError && <p role="alert" className="mt-2 text-xs text-red-200">{catalogDraftError}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {hasManual && <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => { void runCatalogRestore(group.folderId) }}>{catalogBusy === 'restore' ? '恢复中…' : '恢复自动'}</Button>}
          <Button size="sm" variant="secondary" disabled={catalogBusy !== null} onClick={() => setCatalogEditingFolderId(null)}>取消</Button>
          <Button size="sm" variant="primary" disabled={catalogBusy !== null} onClick={() => { void runCatalogSave() }}>{catalogBusy === 'save' ? '保存中…' : '保存'}</Button>
        </div>
      </div>
    )
  }

  if (canonicalWorkGroups.length === 0 && canonicalUngroupedItems.length === 0) return null

  return (
    <div className="mt-4 space-y-3">
      {error && <div role="alert" className="rounded-lg border border-red-300/15 bg-red-400/[0.08] px-3 py-2 text-xs text-red-200">{error}</div>}
      {canonicalWorkGroups.map(group => {
        const workGroupOpen = readWorkGroupOpen(group.id)
        const editingTitle = editingGroupId === group.id
        const splitting = splitGroupId === group.id
        const editingGroup = legacyEditingGroup(group, legacyGroupByFolderId, catalogEditingFolderId)
        const selectedEditingEntry = editingGroup?.entries.find(entry => entry.manual_locked === 1) ?? editingGroup?.entries[0]
        const hasManualEditing = editingGroup?.entries.some(entry => entry.manual_locked === 1) ?? false
        return (
          <section key={group.id} aria-labelledby={'media-work-group-title-' + group.id} className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/15">
            <header className="flex min-w-0 flex-col gap-3 border-b border-white/[0.06] p-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-2">
                  <button
                    type="button"
                    aria-expanded={workGroupOpen}
                    aria-controls={'media-work-group-content-' + group.id}
                    aria-label={(workGroupOpen ? '收起' : '展开') + '作品组 ' + group.title}
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition hover:bg-white/[0.06] hover:text-white"
                    onClick={() => setWorkGroupOpen(group.id, !workGroupOpen)}>
                    <ChevronDownIcon width={15} height={15} className={'transition-transform ' + (workGroupOpen ? '' : '-rotate-90')} />
                  </button>
                  {editingTitle ? (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      <input
                        autoFocus
                        aria-label={'编辑作品组标题：' + group.title}
                        value={titleDraft}
                        onChange={event => setTitleDraft(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') { event.preventDefault(); void saveTitle(group) }
                          if (event.key === 'Escape' && !catalogBusy) clearEditing()
                        }}
                        className="min-w-0 flex-1 basis-40 rounded-lg border border-accent/30 bg-bg px-2.5 py-1.5 text-sm font-semibold text-text-primary outline-none focus:border-accent"
                        disabled={catalogBusy !== null}
                      />
                      <Button size="sm" variant="primary" disabled={catalogBusy !== null} onClick={() => { void saveTitle(group) }}>{catalogBusy === 'rename' ? '保存中…' : '保存'}</Button>
                      <Button size="sm" variant="secondary" disabled={catalogBusy !== null} onClick={clearEditing}>取消</Button>
                    </div>
                  ) : (
                    <button id={'media-work-group-title-' + group.id} type="button" className="min-w-0 truncate text-left text-sm font-semibold text-text-primary transition hover:text-accent" onClick={() => beginTitleEdit(group)} title="编辑作品组标题">
                      {group.title}
                    </button>
                  )}
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-9 text-[10px]">
                  {group.media_domain && <span className="text-text-secondary">{MEDIA_DOMAIN_LABELS[group.media_domain]}</span>}
                  <span className="rounded-md border border-white/[0.08] bg-white/[0.045] px-1.5 py-0.5 text-text-secondary">{group.summary.item_count} 个条目</span>
                  <span className="rounded-md border border-white/[0.08] bg-white/[0.045] px-1.5 py-0.5 text-text-secondary">{group.summary.physical_folder_count} 个物理目录</span>
                  {group.summary.season_numbers.length > 0 && <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-accent">{formatSeasonNumbers(group.summary.season_numbers)}</span>}
                  {group.manual_locked === 1 && <span className="rounded-md border border-amber-300/20 bg-amber-400/10 px-1.5 py-0.5 text-amber-200">人工分组</span>}
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:max-w-[min(100%,26rem)] sm:justify-end">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-[10px] text-text-secondary sm:flex-none">
                  <span className="sr-only">将此组</span>
                  <select
                    aria-label={'将' + group.title + '合并到'}
                    value={mergeTargets[group.id] ?? ''}
                    onChange={event => setMergeTargets(current => ({ ...current, [group.id]: event.target.value ? Number(event.target.value) : '' }))}
                    disabled={catalogBusy !== null || canonicalWorkGroups.length < 2}
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-bg px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent sm:w-36">
                    <option value="">合并到…</option>
                    {canonicalWorkGroups.filter(candidate => candidate.id !== group.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="ghost" disabled={catalogBusy !== null || canonicalWorkGroups.length < 2} onClick={() => { void mergeGroup(group) }}>合并到…</Button>
                <Button size="sm" variant={splitting ? 'secondary' : 'ghost'} disabled={catalogBusy !== null || group.members.length < 2} onClick={() => splitting ? clearEditing() : beginSplit(group)}>{splitting ? '取消拆分' : '拆分'}</Button>
              </div>
            </header>

            <div id={'media-work-group-content-' + group.id} hidden={!workGroupOpen} className="space-y-3 p-3">
              {splitting && <div className="rounded-lg border border-accent/20 bg-accent/[0.045] px-3 py-2 text-xs text-text-secondary">选择要拆出的条目（不能为空，也不能选择全部成员）。</div>}
              {group.members.map(canonicalMember => {
                const memberStatus = mediaCatalogWorkGroupMemberStatus(group, canonicalMember)
                const editingPhysicalGroup = legacyEditingGroup(group, legacyGroupByFolderId, catalogEditingFolderId)
                return (
                  <article key={canonicalMember.id} className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        {shouldShowCanonicalItemTitle(group.title, group.members.length, canonicalMember.item) && <div className="truncate text-sm font-medium text-text-primary" title={canonicalMember.item.title}>{canonicalMember.item.title}</div>}
                        {canonicalMember.item.title_zh && canonicalMember.item.title_zh !== canonicalMember.item.title && <div className="mt-0.5 truncate text-xs text-text-secondary" title={canonicalMember.item.title_zh}>{canonicalMember.item.title_zh}</div>}
                        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
                          {canonicalMember.item.kind !== 'unknown' && <span className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-medium text-text-secondary">{mediaCatalogDisplayLabel(canonicalMember.item.kind, canonicalMember.item.custom_label)}</span>}
                          {canonicalMember.seasonNumbers.length > 0 ? <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-accent">{formatSeasonNumbers(canonicalMember.seasonNumbers)}</span> : canonicalMember.item.kind === 'season' && <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-accent">{canonicalMember.item.season_number === null ? '季号未指定' : '第 ' + canonicalMember.item.season_number + ' 季'}</span>}
                          {canonicalMember.item.part_number !== null && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">Part {canonicalMember.item.part_number}</span>}
                          {canonicalMember.item.source_ids.map(source => <span key={source.source + ':' + source.external_id} className="max-w-full truncate rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{source.source}:{source.external_id}</span>)}
                          {canonicalMember.relation_role !== 'unknown' && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{RELATION_ROLE_LABEL[canonicalMember.relation_role] ?? canonicalMember.relation_role}</span>}
                          <span className={'rounded-md border px-1.5 py-0.5 ' + STATUS_CLASS[memberStatus]}>{STATUS_LABEL[memberStatus]}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {splitting && <label className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2 py-1.5 text-xs text-text-secondary"><input type="checkbox" checked={splitSelection.includes(canonicalMember.item.id)} onChange={() => toggleSplitMember(canonicalMember.item.id)} disabled={catalogBusy !== null} />选择</label>}
                        <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => { void detachMember(group, canonicalMember) }}>移出作品组</Button>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      {canonicalMember.physicalFolders.map(physicalFolder => {
                        const mapping = inlineMappings(physicalFolder)[0]
                        const legacyGroup = legacyGroupByFolderId.get(mapping.folder_id)
                        const editing = catalogEditingFolderId === physicalFolder.folderId
                        const folderStatus = mediaCatalogPhysicalFolderStatus(physicalFolder)
                        const typeLabels = physicalFolderTypeLabels(physicalFolder)
                        return (
                          <div key={physicalFolder.folderId} className="min-w-0 rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2">
                            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0 flex-1">
                                {shouldShowCanonicalMappingFolderName(canonicalMember.item, canonicalMember.mappings, mapping) && <button type="button" className="block max-w-full truncate text-left text-xs font-medium text-text-primary transition hover:text-accent" title={'打开 ' + physicalFolder.folderPath} onClick={() => navigate('/folder/' + physicalFolder.folderId)}>{physicalFolder.folderName}</button>}
                                <button type="button" className="mt-0.5 block max-w-full truncate text-left text-[10px] text-text-secondary/55 transition hover:text-accent" title={'打开 ' + physicalFolder.folderPath} onClick={() => navigate('/folder/' + physicalFolder.folderId)}>{physicalFolder.folderPath}</button>
                                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
                                  {physicalFolder.seasonNumbers.length > 0 && <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-accent">{formatSeasonNumbers(physicalFolder.seasonNumbers)}</span>}
                                  {typeLabels.map(label => <span key={label} className="rounded-md border border-sky-300/20 bg-sky-400/10 px-1.5 py-0.5 text-sky-200">{label}</span>)}
                                  {physicalFolder.seasonNumbers.length === 0 && typeLabels.length === 0 && mapping.kind === 'season' && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{mappingTitle(mapping)}</span>}
                                  {mapping.part_number !== null && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">Part {mapping.part_number}</span>}
                                  <span className={'rounded-md border px-1.5 py-0.5 ' + STATUS_CLASS[folderStatus]}>{STATUS_LABEL[folderStatus]}</span>
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                {legacyGroup && <Button size="sm" variant={editing ? 'secondary' : 'ghost'} disabled={catalogBusy !== null} onClick={() => editing ? setCatalogEditingFolderId(null) : beginCatalogEdit(legacyGroup)}>{editing ? '取消调整' : '调整'}</Button>}
                                <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => runCatalogExclude(physicalFolder.folderId)}>移出清单</Button>
                              </div>
                            </div>
                            {editing && renderLegacyEditor(editingPhysicalGroup, selectedEditingEntry, hasManualEditing)}
                          </div>
                        )
                      })}
                    </div>
                  </article>
                )
              })}

              {splitting && <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-accent/20 bg-accent/[0.045] p-3 sm:flex-row sm:items-end">
                <label className="min-w-0 flex-1 text-xs text-text-secondary">新作品组标题<input aria-label="新作品组标题" value={splitTitle} onChange={event => setSplitTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void splitGroup(group) } if (event.key === 'Escape' && !catalogBusy) clearEditing() }} className="mt-1 h-9 w-full min-w-0 rounded-lg border border-white/10 bg-bg px-2.5 text-sm text-text-primary outline-none focus:border-accent" disabled={catalogBusy !== null} /></label>
                <Button size="sm" variant="primary" disabled={catalogBusy !== null} onClick={() => { void splitGroup(group) }}>{catalogBusy === 'split' ? '拆分中…' : '确认拆分'}</Button>
              </div>}
            </div>
          </section>
        )
      })}

      {canonicalUngroupedItems.length > 0 && (
        <section aria-labelledby="media-catalog-ungrouped-title" className="overflow-hidden rounded-xl border border-amber-300/15 bg-amber-400/[0.035]">
          <header className="flex min-w-0 flex-col gap-2 border-b border-amber-300/10 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 id="media-catalog-ungrouped-title" className="text-sm font-semibold text-text-primary">未分组内容</h3>
              <p className="mt-0.5 text-[10px] text-text-secondary">这些内容仍在季度清单中，但不会被自动放回任何作品组。</p>
            </div>
            <span className="w-fit rounded-md border border-amber-300/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">{canonicalUngroupedItems.length} 个条目</span>
          </header>
          <div className="space-y-3 p-3">
            {canonicalUngroupedItems.map(ungrouped => {
              const targetGroupId = attachTargets[ungrouped.item.id] ?? canonicalWorkGroups[0]?.id ?? ''
              const physicalFolders = groupCanonicalPhysicalFolders(ungrouped.mappings)
              return (
                <article key={ungrouped.item.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-text-primary" title={ungrouped.item.title}>{ungrouped.item.title}</div>
                      {ungrouped.item.title_zh && ungrouped.item.title_zh !== ungrouped.item.title && <div className="mt-0.5 truncate text-xs text-text-secondary" title={ungrouped.item.title_zh}>{ungrouped.item.title_zh}</div>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                        {ungrouped.item.kind !== 'unknown' && <span className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{mediaCatalogDisplayLabel(ungrouped.item.kind, ungrouped.item.custom_label)}</span>}
                        {ungrouped.item.source_ids.map(source => <span key={source.source + ':' + source.external_id} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{source.source}:{source.external_id}</span>)}
                        <span className="rounded-md border border-amber-300/20 bg-amber-400/10 px-1.5 py-0.5 text-amber-200">未分组</span>
                      </div>
                    </div>
                    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
                      <select aria-label={'选择' + ungrouped.item.title + '要加入的作品组'} value={targetGroupId} onChange={event => setAttachTargets(current => ({ ...current, [ungrouped.item.id]: event.target.value ? Number(event.target.value) : '' }))} disabled={catalogBusy !== null || canonicalWorkGroups.length === 0} className="h-8 min-w-32 rounded-lg border border-white/10 bg-bg px-2 text-xs text-text-primary outline-none focus:border-accent disabled:opacity-50">
                        {canonicalWorkGroups.length === 0 && <option value="">暂无作品组</option>}
                        {canonicalWorkGroups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}
                      </select>
                      <Button size="sm" variant="secondary" disabled={catalogBusy !== null || targetGroupId === ''} onClick={() => { void attachMember(ungrouped.item.id) }}>{catalogBusy === 'attach' ? '加入中…' : '加入作品组'}</Button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {physicalFolders.map(physicalFolder => {
                      const mapping = physicalFolder.mappings[0]
                      const legacyGroup = legacyGroupByFolderId.get(physicalFolder.folderId)
                      const editing = catalogEditingFolderId === physicalFolder.folderId
                      const selected = legacyGroup?.entries.find(entry => entry.manual_locked === 1) ?? legacyGroup?.entries[0]
                      const hasManual = legacyGroup?.entries.some(entry => entry.manual_locked === 1) ?? false
                      const folderStatus = mediaCatalogPhysicalFolderStatus(physicalFolder)
                      const typeLabels = physicalFolderTypeLabels(physicalFolder)
                      return (
                        <div key={physicalFolder.folderId} className="rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2">
                          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <button type="button" className="block max-w-full truncate text-left text-xs font-medium text-text-primary transition hover:text-accent" title={'打开 ' + physicalFolder.folderPath} onClick={() => navigate('/folder/' + physicalFolder.folderId)}>{physicalFolder.folderName}</button>
                              <div className="mt-0.5 truncate text-[10px] text-text-secondary/55" title={physicalFolder.folderPath}>{physicalFolder.folderPath}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                                {physicalFolder.seasonNumbers.length > 0 && <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-accent">{formatSeasonNumbers(physicalFolder.seasonNumbers)}</span>}
                                {typeLabels.map(label => <span key={label} className="rounded-md border border-sky-300/20 bg-sky-400/10 px-1.5 py-0.5 text-sky-200">{label}</span>)}
                                {physicalFolder.seasonNumbers.length === 0 && typeLabels.length === 0 && mapping.kind === 'season' && <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-text-secondary">{mappingTitle(mapping)}</span>}
                                <span className={'rounded-md border px-1.5 py-0.5 ' + STATUS_CLASS[folderStatus]}>{STATUS_LABEL[folderStatus]}</span>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              {legacyGroup && <Button size="sm" variant={editing ? 'secondary' : 'ghost'} disabled={catalogBusy !== null} onClick={() => editing ? setCatalogEditingFolderId(null) : beginCatalogEdit(legacyGroup)}>{editing ? '取消调整' : '调整'}</Button>}
                              <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => runCatalogExclude(physicalFolder.folderId)}>移出清单</Button>
                            </div>
                          </div>
                          {editing && renderLegacyEditor(legacyGroup, selected, hasManual)}
                        </div>
                      )
                    })}
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
