import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FolderView, MediaCatalogCandidate, MediaCatalogKind } from '../../../../src/types'
import type { MediaCatalogDirectoryRow, MediaCatalogFolderGroup } from '../mediaCatalog'
import { buildMediaCatalogDirectoryRows, formatSeasonNumbers, mediaCatalogDisplayLabel, mediaCatalogKindLabel } from '../mediaCatalog'
import Button from '../../../../src/components/ui/Button'
import { ChevronDownIcon } from '../../../../src/components/ui/Icons'
import SelectMenu from '../../../../src/components/ui/SelectMenu'

export interface MediaCatalogDirectoryListProps {
  children: FolderView[]
  catalogGroups: MediaCatalogFolderGroup[]
  showDirectoryRows: boolean
  media_catalog_candidates: MediaCatalogCandidate[]
  catalogBusy: string | null
  catalogCandidatesOpen: boolean
  setCatalogCandidatesOpen: (open: boolean) => void
  catalogEditingFolderId: number | null
  catalogDraftKind: MediaCatalogKind
  catalogDraftCustomLabel: string
  catalogDraftSeasons: string
  catalogDraftPart: string
  catalogDraftError: string
  onDirectoryAdjust: (row: MediaCatalogDirectoryRow) => void
  beginCatalogCandidateEdit: (candidate: MediaCatalogCandidate) => void
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

const STATUS_CLASS = {
  automatic: 'border-white/10 bg-white/[0.045] text-text-secondary',
  manual: 'border-sky-300/20 bg-sky-400/10 text-sky-200',
  pending: 'border-amber-300/20 bg-amber-400/10 text-amber-200',
  directory: 'border-white/10 bg-white/[0.035] text-text-secondary',
} as const

function groupStatus(group: MediaCatalogFolderGroup | null): keyof typeof STATUS_CLASS {
  if (!group) return 'directory'
  if (group.entries.some(entry => entry.kind === 'unknown' || entry.conflict_reason)) return 'pending'
  return group.entries.some(entry => entry.manual_locked === 1) ? 'manual' : 'automatic'
}

function statusLabel(status: keyof typeof STATUS_CLASS): string {
  return status === 'manual' ? '手动' : status === 'pending' ? '待识别' : status === 'directory' ? '目录' : '自动'
}

function seasonLabel(numbers: number[]): string | null {
  return numbers.length > 0 ? formatSeasonNumbers(numbers) : null
}

function partLabel(group: MediaCatalogFolderGroup | null): string | null {
  if (!group) return null
  const parts = [...new Set(group.entries.map(entry => entry.part_number).filter((part): part is number => part !== null && part > 0))]
    .sort((left, right) => left - right)
  return parts.length > 0 ? `Part ${parts.join('/')}` : null
}

function groupTypeLabels(group: MediaCatalogFolderGroup | null): string[] {
  if (!group) return []
  return [...new Set(group.entries
    .filter(entry => entry.kind !== 'season' && entry.kind !== 'unknown')
    .map(entry => mediaCatalogDisplayLabel(entry.kind, entry.custom_label)))]
}

interface CatalogEditorProps {
  folderName: string
  catalogBusy: string | null
  catalogEditingFolderId: number | null
  catalogDraftKind: MediaCatalogKind
  catalogDraftCustomLabel: string
  catalogDraftSeasons: string
  catalogDraftPart: string
  catalogDraftError: string
  hasManual: boolean
  setCatalogDraftKind: (kind: MediaCatalogKind) => void
  setCatalogDraftCustomLabel: (value: string) => void
  setCatalogDraftSeasons: (value: string) => void
  setCatalogDraftPart: (value: string) => void
  setCatalogEditingFolderId: (folderId: number | null) => void
  runCatalogSave: () => Promise<void>
  runCatalogRestore?: (folderId: number) => Promise<void>
  folderId: number
}

function CatalogEditor({
  folderName,
  catalogBusy,
  catalogEditingFolderId,
  catalogDraftKind,
  catalogDraftCustomLabel,
  catalogDraftSeasons,
  catalogDraftPart,
  catalogDraftError,
  hasManual,
  setCatalogDraftKind,
  setCatalogDraftCustomLabel,
  setCatalogDraftSeasons,
  setCatalogDraftPart,
  setCatalogEditingFolderId,
  runCatalogSave,
  runCatalogRestore,
  folderId,
}: CatalogEditorProps) {
  return (
    <div className="mt-3 rounded-xl border border-accent/20 bg-accent/[0.045] p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_100px]">
        <label className="min-w-0 text-[10px] text-text-secondary">
          类型
          <SelectMenu
            ariaLabel={`${folderName} 的清单类型`}
            value={catalogDraftKind}
            options={MEDIA_CATALOG_KIND_OPTIONS}
            onChange={setCatalogDraftKind}
            disabled={catalogBusy !== null}
            className="mt-1 w-full"
            minWidthClass="min-w-0"
            menuPosition="fixed"
            menuWidth="trigger" />
        </label>
        {catalogDraftKind === 'custom' ? (
          <label className="min-w-0 text-[10px] text-text-secondary">
            自定义名称
            <input
              aria-label={`${folderName} 的自定义类型名称`}
              value={catalogDraftCustomLabel}
              onChange={event => setCatalogDraftCustomLabel(event.target.value)}
              disabled={catalogBusy !== null}
              maxLength={32}
              placeholder="输入自定义名称"
              className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 text-xs text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:opacity-50" />
          </label>
        ) : (
          <label className="min-w-0 text-[10px] text-text-secondary">
            季号（逗号分隔）
            <input
              aria-label={`${folderName} 的季号`}
              value={catalogDraftSeasons}
              onChange={event => setCatalogDraftSeasons(event.target.value)}
              disabled={catalogBusy !== null || catalogDraftKind !== 'season'}
              placeholder="例如 1,2"
              className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 text-xs text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:cursor-not-allowed disabled:opacity-45" />
          </label>
        )}
        <label className="min-w-0 text-[10px] text-text-secondary">
          Part（可空）
          <input
            aria-label={`${folderName} 的 Part`}
            value={catalogDraftPart}
            onChange={event => setCatalogDraftPart(event.target.value)}
            disabled={catalogBusy !== null}
            inputMode="numeric"
            placeholder="—"
            className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-2.5 text-xs text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:opacity-50" />
        </label>
      </div>
      {catalogDraftError && <p role="alert" className="mt-2 text-xs text-red-200">{catalogDraftError}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {hasManual && runCatalogRestore && <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => { void runCatalogRestore(folderId) }}>{catalogBusy === 'restore' ? '恢复中…' : '恢复自动'}</Button>}
        <Button size="sm" variant="secondary" disabled={catalogBusy !== null} onClick={() => setCatalogEditingFolderId(null)}>取消</Button>
        <Button size="sm" variant="primary" disabled={catalogBusy !== null} onClick={() => { void runCatalogSave() }}>
          {catalogBusy === 'save' ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

export default function MediaCatalogDirectoryList({
  children,
  catalogGroups,
  showDirectoryRows,
  media_catalog_candidates,
  catalogBusy,
  catalogCandidatesOpen,
  setCatalogCandidatesOpen,
  catalogEditingFolderId,
  catalogDraftKind,
  catalogDraftCustomLabel,
  catalogDraftSeasons,
  catalogDraftPart,
  catalogDraftError,
  onDirectoryAdjust,
  beginCatalogCandidateEdit,
  setCatalogEditingFolderId,
  setCatalogDraftKind,
  setCatalogDraftCustomLabel,
  setCatalogDraftSeasons,
  setCatalogDraftPart,
  runCatalogSave,
  runCatalogRestore,
  runCatalogExclude,
}: MediaCatalogDirectoryListProps) {
  const navigate = useNavigate()
  const rows = useMemo(
    () => showDirectoryRows ? buildMediaCatalogDirectoryRows(children, catalogGroups, media_catalog_candidates) : [],
    [children, catalogGroups, media_catalog_candidates, showDirectoryRows],
  )
  const [openRows, setOpenRows] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    const closeInlineDetails = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setOpenRows(new Set())
      setCatalogEditingFolderId(null)
      setCatalogCandidatesOpen(false)
    }
    window.addEventListener('keydown', closeInlineDetails)
    return () => window.removeEventListener('keydown', closeInlineDetails)
  }, [setCatalogCandidatesOpen, setCatalogEditingFolderId])

  const toggleRow = (folderId: number) => {
    setOpenRows(current => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const openForEdit = (folderId: number) => {
    setOpenRows(current => new Set(current).add(folderId))
  }

  const closeRow = (folderId: number) => {
    setOpenRows(current => {
      const next = new Set(current)
      next.delete(folderId)
      return next
    })
  }

  return (
    <div className="mt-4 space-y-3">
      {showDirectoryRows && rows.length === 0 && media_catalog_candidates.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 bg-black/10 px-4 py-7 text-center text-sm text-text-secondary">
          <p className="text-text-primary">暂无季度或目录记录</p>
          <p className="mt-1 text-xs text-text-secondary/65">可以点击上方“重新识别”建立目录清单。</p>
        </div>
      )}

      {showDirectoryRows && rows.map(row => {
        const folderId = row.folder?.id ?? row.group?.folderId
        if (folderId === undefined) return null
        const folderName = row.folder?.name ?? row.group?.folderName ?? '未命名目录'
        const folderPath = row.folder?.path ?? row.group?.folderPath ?? ''
        const status = groupStatus(row.group)
        const seasons = row.group?.seasonNumbers ?? []
        const part = partLabel(row.group)
        const typeLabels = groupTypeLabels(row.group)
        return (
          <article key={folderId} className="min-w-0 rounded-xl border border-white/[0.08] bg-black/15 p-3">
            <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
                aria-label={`打开目录 ${folderName}`}
                onClick={() => navigate(`/folder/${folderId}`)}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary transition hover:text-accent" title={folderName}>{folderName}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-secondary/55" title={folderPath}>{folderPath}</span>
                </span>
              </button>

              <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-6 lg:shrink-0 lg:pl-0">
                {seasonLabel(seasons) && <span className="inline-flex min-h-8 items-center rounded-lg border border-accent/35 bg-accent/15 px-3 py-1 text-sm font-semibold text-accent shadow-[0_0_16px_rgb(var(--ui-accent)/0.12)]" title="该物理目录包含的季度">{seasonLabel(seasons)}</span>}
                {typeLabels.map(label => <span key={label} className="inline-flex min-h-8 items-center rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">{label}</span>)}
                {part && <span className="rounded-md bg-white/[0.06] px-2 py-1 text-[10px] text-text-secondary">{part}</span>}
                <span className={`rounded-md border px-2 py-1 text-[10px] ${STATUS_CLASS[status]}`} title={status === 'automatic' ? '自动识别' : status === 'manual' ? '手动设置' : status === 'directory' ? '普通目录' : '待识别'}>{statusLabel(status)}</span>
                <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => onDirectoryAdjust(row)}>调整</Button>
                {row.group && <Button size="sm" variant="ghost" disabled={catalogBusy !== null} onClick={() => { void runCatalogExclude(folderId) }}>移出清单</Button>}
              </div>
            </div>
          </article>
        )
      })}

      <section className="border-t border-white/[0.07] pt-4">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">待处理目录</div>
            <p className="mt-0.5 text-xs text-text-secondary">附加内容、证据不足和已移出清单的目录集中在这里，可逐项添加。</p>
          </div>
          <Button size="sm" variant={catalogCandidatesOpen ? 'secondary' : 'ghost'} disabled={catalogBusy !== null} onClick={() => setCatalogCandidatesOpen(!catalogCandidatesOpen)}>
            {catalogCandidatesOpen ? '收起添加目录' : `添加目录${media_catalog_candidates.length > 0 ? ` · ${media_catalog_candidates.length}` : ''}`}
          </Button>
        </div>

        {catalogCandidatesOpen && (
          <div className="mt-3 space-y-2">
            {media_catalog_candidates.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-black/10 px-4 py-5 text-center text-sm text-text-secondary">暂无可添加的目录</div>
            ) : media_catalog_candidates.map(candidate => {
              const folderId = candidate.folder_id
              const editing = catalogEditingFolderId === folderId
              const expanded = openRows.has(folderId) || editing
              const candidateSeason = seasonLabel(candidate.suggested_season_numbers)
              return (
                <article key={folderId} className="min-w-0 rounded-xl border border-amber-300/15 bg-amber-400/[0.035] p-3">
                  <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      aria-expanded={expanded}
                      aria-controls={`media-catalog-candidate-${folderId}`}
                      onClick={() => toggleRow(folderId)}>
                      <ChevronDownIcon width={15} height={15} className={`mt-0.5 shrink-0 text-text-secondary transition-transform ${expanded ? '' : '-rotate-90'}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text-primary" title={candidate.folder_name}>{candidate.folder_name}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-text-secondary/60" title={candidate.folder_path}>{candidate.folder_path}</span>
                      </span>
                    </button>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-6 lg:shrink-0 lg:pl-0">
                      {candidateSeason && <span className="inline-flex min-h-8 items-center rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">{candidateSeason}</span>}
                      {candidate.suggested_part_number !== null && <span className="rounded-md bg-white/[0.06] px-2 py-1 text-[10px] text-text-secondary">Part {candidate.suggested_part_number}</span>}
                      <span className="rounded-md bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">{candidate.reason === 'excluded' ? '已移出' : candidate.reason === 'extras' ? '附加内容' : '证据不足'}</span>
                      <Button size="sm" variant={editing ? 'secondary' : 'primary'} disabled={catalogBusy !== null} onClick={() => { if (editing) { setCatalogEditingFolderId(null); closeRow(folderId) } else { openForEdit(folderId); beginCatalogCandidateEdit(candidate) } }}>
                        {editing ? '取消添加' : '添加并设置'}
                      </Button>
                    </div>
                  </div>
                  <div id={`media-catalog-candidate-${folderId}`} hidden={!expanded} className="mt-3 border-t border-amber-300/10 pt-3">
                    <p className="text-xs text-text-secondary">自动识别建议：{mediaCatalogDisplayLabel(candidate.suggested_kind, candidate.suggested_custom_label)}，{candidate.confidence >= 0.8 ? '置信度较高' : '需要手动确认'}。</p>
                    {editing && (
                      <CatalogEditor
                        folderName={candidate.folder_name}
                        catalogBusy={catalogBusy}
                        catalogEditingFolderId={catalogEditingFolderId}
                        catalogDraftKind={catalogDraftKind}
                        catalogDraftCustomLabel={catalogDraftCustomLabel}
                        catalogDraftSeasons={catalogDraftSeasons}
                        catalogDraftPart={catalogDraftPart}
                        catalogDraftError={catalogDraftError}
                        hasManual={false}
                        setCatalogDraftKind={setCatalogDraftKind}
                        setCatalogDraftCustomLabel={setCatalogDraftCustomLabel}
                        setCatalogDraftSeasons={setCatalogDraftSeasons}
                        setCatalogDraftPart={setCatalogDraftPart}
                        setCatalogEditingFolderId={setCatalogEditingFolderId}
                        runCatalogSave={runCatalogSave}
                        folderId={folderId} />
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
