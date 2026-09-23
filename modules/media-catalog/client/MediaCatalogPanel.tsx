import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModuleFolderProps } from '../../../src/modules/contracts'
import type { FolderDetail, MediaCatalogCandidate, MediaCatalogEntry, MediaCatalogKind, MediaCatalogV2 } from '../../../src/types'
import Button from '../../../src/components/ui/Button'
import SelectMenu from '../../../src/components/ui/SelectMenu'
import { PinIcon, RefreshIcon } from '../../../src/components/ui/Icons'
import { useDialogBehavior } from '../../../src/components/ui/dialogBehavior'
import OverlayPresence from '../../../src/components/ui/OverlayPresence'
import { api } from './api'
import { scopeFolderCatalog } from './folderCatalogScope'
import {
  buildMediaCatalogDirectoryRows,
  formatSeasonNumbers,
  groupMediaCatalogEntries,
  parseSeasonNumbersInput,
  shouldApplyMediaCatalogSnapshot,
  shouldUseMediaCatalogWorkGroups,
  type MediaCatalogDirectoryRow,
} from './mediaCatalog'
import MediaCatalogDirectoryList from './media-catalog/MediaCatalogDirectoryList'
import MediaCatalogWorkGroups from './media-catalog/MediaCatalogWorkGroups'

const KIND_OPTIONS: { value: MediaCatalogKind; label: string }[] = [
  { value: 'season', label: '季度' },
  { value: 'movie', label: '剧场版' },
  { value: 'ova', label: 'OVA' },
  { value: 'special', label: 'SP' },
  { value: 'custom', label: '自定义' },
  { value: 'extras', label: '附加内容' },
  { value: 'unknown', label: '待确认' },
]

type CatalogBusy = 'rebuild' | 'save' | 'restore' | 'exclude' | 'rename' | 'merge' | 'detach' | 'attach' | 'split' | null
type CatalogSnapshot = {
  media_catalog: MediaCatalogEntry[]
  media_catalog_summary: FolderDetail['media_catalog_summary']
  media_catalog_v2?: MediaCatalogV2 | null
  media_catalog_candidates: MediaCatalogCandidate[]
}

export default function MediaCatalogPanel({ folder, onRefresh, onUpdate }: ModuleFolderProps) {
  const [item, setItem] = useState(folder)
  const [busy, setBusy] = useState<CatalogBusy>(null)
  const [pinning, setPinning] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null)
  const [draftKind, setDraftKind] = useState<MediaCatalogKind>('unknown')
  const [draftCustomLabel, setDraftCustomLabel] = useState('')
  const [draftSeasons, setDraftSeasons] = useState('')
  const [draftPart, setDraftPart] = useState('')
  const [draftError, setDraftError] = useState('')
  const [candidatesOpen, setCandidatesOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [directoryFolderId, setDirectoryFolderId] = useState<number | null>(null)
  const [directoryName, setDirectoryName] = useState('')
  const [directoryOriginalName, setDirectoryOriginalName] = useState('')
  const [directoryExpectedPath, setDirectoryExpectedPath] = useState('')
  const [directoryKind, setDirectoryKind] = useState<MediaCatalogKind>('unknown')
  const [directoryOriginalKind, setDirectoryOriginalKind] = useState<MediaCatalogKind>('unknown')
  const [directoryCustomLabel, setDirectoryCustomLabel] = useState('')
  const [directoryOriginalCustomLabel, setDirectoryOriginalCustomLabel] = useState('')
  const [directorySeasons, setDirectorySeasons] = useState('')
  const [directoryOriginalSeasons, setDirectoryOriginalSeasons] = useState('')
  const [directoryPart, setDirectoryPart] = useState('')
  const [directoryOriginalPart, setDirectoryOriginalPart] = useState('')
  const [directoryHasManual, setDirectoryHasManual] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  useEffect(() => { setItem(folder) }, [folder])
  useEffect(() => {
    setEditingFolderId(null); setCandidatesOpen(false); setDraftError(''); setError(''); setNotice(''); setDirectoryError('')
    setDialogOpen(false); setDirectoryFolderId(null)
  }, [folder.id])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3600); return () => window.clearTimeout(timer) }, [notice])

  const closeDialog = (force = false) => {
    if (busy && !force) return
    setDialogOpen(false); setDirectoryError(''); setDirectoryFolderId(null)
  }
  useDialogBehavior({ open: dialogOpen && directoryFolderId !== null, dialogRef, initialFocusRef: nameRef, triggerRef, onClose: () => closeDialog(), closeDisabled: busy !== null })

  const seasons = useMemo(() => item.children.filter(child => child.file_count > 0), [item.children])
  const visible = useMemo(() => scopeFolderCatalog(item.id, item), [item])
  const entries = visible.media_catalog
  const catalog = visible.media_catalog_v2 ?? null
  const candidates = visible.media_catalog_candidates
  const groups = useMemo(() => groupMediaCatalogEntries(entries), [entries])
  const directoryRows = useMemo(() => buildMediaCatalogDirectoryRows(seasons, groups, candidates), [seasons, groups, candidates])
  const legacyGroupByFolderId = useMemo(() => new Map(groups.map(group => [group.folderId, group])), [groups])
  const canonical = shouldUseMediaCatalogWorkGroups(item.pinned, catalog)
  const summary = canonical ? catalog?.summary : visible.media_catalog_summary
  const seasonLabel = summary?.season_numbers?.length ? formatSeasonNumbers(summary.season_numbers) : '未指定季号'
  const entryCount = canonical ? (catalog?.summary?.item_count ?? 0) : directoryRows.length

  const applySnapshot = (snapshot: CatalogSnapshot, expectedFolderId: number) => {
    setItem(current => {
      if (!shouldApplyMediaCatalogSnapshot(current.id, expectedFolderId)) return current
      const next = {
        ...current,
        media_catalog: snapshot.media_catalog,
        media_catalog_summary: snapshot.media_catalog_summary,
        media_catalog_candidates: snapshot.media_catalog_candidates,
        ...(Object.prototype.hasOwnProperty.call(snapshot, 'media_catalog_v2') ? { media_catalog_v2: snapshot.media_catalog_v2 } : {}),
      }
      onUpdate(next)
      return next
    })
  }

  const rebuild = async () => {
    if (busy) return
    const expected = item.id
    setBusy('rebuild'); setError('')
    try {
      const result = await api.folders.rebuildMediaCatalog(item.id)
      applySnapshot(result, expected)
      setNotice(`已重新识别 ${result.rebuild.foldersProcessed} 个物理目录`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '重新识别失败') }
    finally { setBusy(null) }
  }

  const togglePinned = async () => {
    if (pinning || busy) return
    setPinning(true)
    try {
      const result = await api.folders.pin(item.id, item.pinned !== 1)
      const next = { ...item, pinned: result.pinned ? 1 : 0 }
      setItem(next)
      onUpdate(next)
      window.dispatchEvent(new CustomEvent('animeshelf:collection-changed'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新合集状态失败')
    } finally {
      setPinning(false)
    }
  }

  const beginEdit = (group: ReturnType<typeof groupMediaCatalogEntries>[number]) => {
    const selected = group.entries.find(entry => entry.manual_locked === 1) ?? group.entries[0]
    if (!selected) return
    setEditingFolderId(group.folderId); setDraftKind(selected.kind); setDraftCustomLabel(selected.custom_label ?? '')
    setDraftSeasons(group.seasonNumbers.join(',')); setDraftPart(selected.part_number == null ? '' : String(selected.part_number))
    setDraftError(''); setError('')
  }

  const beginDirectoryEdit = (row: MediaCatalogDirectoryRow) => {
    const id = row.folder?.id ?? row.group?.folderId
    if (id === undefined) return
    const selected = row.group?.entries.find(entry => entry.manual_locked === 1) ?? row.group?.entries[0]
    const kind = selected?.kind ?? 'unknown'
    const seasonNumbers = kind === 'season' ? (row.group?.seasonNumbers ?? []) : []
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditingFolderId(null); setDirectoryFolderId(id)
    setDirectoryName(row.folder?.name ?? row.group?.folderName ?? '未命名目录')
    setDirectoryOriginalName(row.folder?.name ?? row.group?.folderName ?? '未命名目录')
    setDirectoryExpectedPath(row.folder?.path ?? row.group?.folderPath ?? '')
    setDirectoryKind(kind); setDirectoryOriginalKind(kind)
    setDirectoryCustomLabel(selected?.custom_label ?? ''); setDirectoryOriginalCustomLabel(selected?.custom_label ?? '')
    setDirectorySeasons(seasonNumbers.join(',')); setDirectoryOriginalSeasons(seasonNumbers.join(','))
    setDirectoryPart(selected?.part_number == null ? '' : String(selected.part_number)); setDirectoryOriginalPart(selected?.part_number == null ? '' : String(selected.part_number))
    setDirectoryHasManual(Boolean(row.group?.entries.some(entry => entry.manual_locked === 1)))
    setDirectoryError(''); setDialogOpen(true)
  }

  const classification = (kind: MediaCatalogKind, seasonsInput: string, customInput: string, partInput: string) => {
    let seasonNumbers: number[] = []
    if (kind === 'season') {
      const parsed = parseSeasonNumbersInput(seasonsInput)
      if (parsed.error) throw new Error(parsed.error)
      if (!parsed.values.length) throw new Error('季度类型至少需要一个季号')
      seasonNumbers = parsed.values
    }
    const customLabel = kind === 'custom' ? customInput.trim() : null
    if (kind === 'custom' && !customLabel) throw new Error('自定义类型需要填写显示名称')
    if (customLabel && customLabel.length > 32) throw new Error('自定义名称不能超过 32 个字符')
    const part = partInput.trim()
    if (part && (!/^\d+$/.test(part) || Number(part) <= 0 || !Number.isSafeInteger(Number(part)))) throw new Error('Part 必须是正整数，或留空')
    return { kind, customLabel, seasonNumbers, partNumber: part ? Number(part) : null }
  }

  const saveDirectory = async () => {
    if (directoryFolderId === null || busy) return
    const nextName = directoryName.trim()
    if (!nextName) return setDirectoryError('请输入目录名称')
    let body
    try { body = classification(directoryKind, directorySeasons, directoryCustomLabel, directoryPart) }
    catch (caught) { return setDirectoryError(caught instanceof Error ? caught.message : String(caught)) }
    const nameChanged = nextName !== directoryOriginalName
    const catalogChanged = directoryKind !== directoryOriginalKind ||
      (directoryKind === 'season' && body.seasonNumbers.join(',') !== directoryOriginalSeasons) ||
      (directoryKind === 'custom' && body.customLabel !== directoryOriginalCustomLabel) || directoryPart.trim() !== directoryOriginalPart
    if (!nameChanged && !catalogChanged) return closeDialog()
    const expected = item.id
    setBusy('save'); setDirectoryError(''); setError('')
    let renamed = false
    try {
      if (nameChanged) {
        const result = await api.folders.rename(directoryFolderId, nextName, directoryExpectedPath)
        renamed = true; setDirectoryExpectedPath(result.path); setDirectoryOriginalName(nextName)
      }
      if (catalogChanged) applySnapshot(await api.folders.updateMediaCatalog(directoryFolderId, body), expected)
      closeDialog(true)
      setNotice(renamed && catalogChanged ? '目录名称与识别设置已保存' : renamed ? '目录名称已保存，磁盘文件夹路径已同步' : '识别设置已保存；重新识别时会保留此记录')
      await onRefresh()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '保存目录调整失败'
      setDirectoryError(renamed && catalogChanged ? `磁盘文件夹已重命名，但识别设置保存失败：${message}。请检查后重试保存。` : message)
      if (renamed && catalogChanged) await onRefresh()
    } finally { setBusy(null) }
  }

  const save = async () => {
    if (editingFolderId === null || busy) return
    let body
    try { body = classification(draftKind, draftSeasons, draftCustomLabel, draftPart) }
    catch (caught) { return setDraftError(caught instanceof Error ? caught.message : String(caught)) }
    const expected = item.id
    setBusy('save'); setDraftError(''); setError('')
    try {
      applySnapshot(await api.folders.updateMediaCatalog(editingFolderId, body), expected)
      setEditingFolderId(null); setNotice('已保存手动识别；重新识别时会保留此记录')
    } catch (caught) { setDraftError(caught instanceof Error ? caught.message : '保存识别结果失败') }
    finally { setBusy(null) }
  }

  const restore = async (folderId: number, close = false) => {
    if (busy) return
    const expected = item.id
    setBusy('restore'); setDraftError(''); setError('')
    try {
      applySnapshot(await api.folders.updateMediaCatalog(folderId, { clearManual: true }), expected)
      setEditingFolderId(null); setNotice('已恢复自动识别')
      if (close) closeDialog(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '恢复自动识别失败'
      setDraftError(message); if (close) setDirectoryError(message)
    } finally { setBusy(null) }
  }

  const exclude = async (folderId: number) => {
    if (busy) return
    const expected = item.id
    setBusy('exclude'); setDraftError(''); setError('')
    try {
      applySnapshot(await api.folders.updateMediaCatalog(folderId, { excluded: true }), expected)
      setEditingFolderId(null); setCandidatesOpen(true); setNotice('已移出目录清单，可在“添加目录”中恢复')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '移出清单失败') }
    finally { setBusy(null) }
  }

  const beginCandidateEdit = (candidate: MediaCatalogCandidate) => {
    setCandidatesOpen(true); setEditingFolderId(candidate.folder_id); setDraftKind(candidate.suggested_kind)
    setDraftCustomLabel(candidate.suggested_custom_label ?? ''); setDraftSeasons(candidate.suggested_season_numbers.join(','))
    setDraftPart(candidate.suggested_part_number == null ? '' : String(candidate.suggested_part_number)); setDraftError(''); setError('')
  }

  return <>
    <OverlayPresence open={dialogOpen && directoryFolderId !== null}>
      {dialogOpen && directoryFolderId !== null && <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4 transition-opacity duration-200 [@starting-style]:opacity-0" onClick={() => closeDialog()}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="catalog-directory-dialog-title" tabIndex={-1} className="clean-dialog ui-panel-strong w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#0d121b]/98 shadow-[0_28px_90px_rgba(0,0,0,0.58)] backdrop-blur-2xl transition-[opacity,transform] duration-200 ease-[var(--ease-out)] [@starting-style]:scale-[0.97] [@starting-style]:opacity-0" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4"><div className="min-w-0"><div className="section-kicker">DIRECTORY CATALOG</div><h2 id="catalog-directory-dialog-title" className="mt-1 font-semibold text-white">调整目录</h2><p className="mt-1 truncate text-xs text-text-secondary/70" title={directoryExpectedPath}>{directoryExpectedPath}</p></div><button type="button" disabled={busy !== null} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl text-text-secondary transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40" aria-label="关闭目录调整" onClick={() => closeDialog()}>×</button></div>
        <div className="max-h-[min(72vh,640px)] space-y-4 overflow-y-auto p-5">
          <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.07] px-3 py-2.5 text-xs leading-5 text-amber-100/85">保存名称会重命名磁盘文件夹，并同步更新子目录与文件路径；识别设置会作为手动记录保存。</div>
          {directoryError && <div role="alert" className="rounded-xl border border-red-300/15 bg-red-400/[0.08] px-3 py-2.5 text-sm text-red-200">{directoryError}</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 sm:col-span-2"><span className="text-xs text-text-secondary">目录名称</span><input ref={nameRef} value={directoryName} onChange={event => setDirectoryName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !busy) void saveDirectory() }} disabled={busy !== null} className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-primary outline-none transition focus:border-accent disabled:opacity-50" /></label>
            <label className="min-w-0"><span className="text-xs text-text-secondary">类型</span><SelectMenu ariaLabel="目录清单类型" value={directoryKind} options={KIND_OPTIONS} onChange={setDirectoryKind} disabled={busy !== null} className="mt-1 w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" size="md" /></label>
            {directoryKind === 'custom' ? <label className="min-w-0"><span className="text-xs text-text-secondary">自定义名称</span><input aria-label="目录自定义类型名称" value={directoryCustomLabel} onChange={event => setDirectoryCustomLabel(event.target.value)} disabled={busy !== null} maxLength={32} placeholder="输入自定义名称" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:opacity-50" /></label> : <label className="min-w-0"><span className="text-xs text-text-secondary">季号（逗号分隔）</span><input aria-label="目录季号" value={directorySeasons} onChange={event => setDirectorySeasons(event.target.value)} disabled={busy !== null || directoryKind !== 'season'} placeholder="例如 1,2" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:cursor-not-allowed disabled:opacity-45" /></label>}
            <label className="min-w-0"><span className="text-xs text-text-secondary">Part（可空）</span><input aria-label="目录 Part" value={directoryPart} onChange={event => setDirectoryPart(event.target.value)} disabled={busy !== null} inputMode="numeric" placeholder="—" className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-primary outline-none transition placeholder:text-text-secondary/35 focus:border-accent disabled:opacity-50" /></label>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.07] px-5 py-4">{directoryHasManual && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void restore(directoryFolderId, true) }}>{busy === 'restore' ? '恢复中…' : '恢复自动'}</Button>}<Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => closeDialog()}>取消</Button><Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void saveDirectory() }}>{busy === 'save' ? '保存中…' : '保存'}</Button></div>
        </div>
      </div>}
    </OverlayPresence>

    <section aria-labelledby="media-catalog-title" className="clean-section media-catalog-section ui-panel rounded-2xl border border-accent/20 bg-[#111722]/86 p-4 backdrop-blur-lg">
      <div className="media-catalog-header flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 flex-1"><div className="section-kicker">PERSISTED MEDIA CATALOG</div><h2 id="media-catalog-title" className="mt-1 font-semibold text-white">季度与目录</h2><p className="mt-0.5 text-xs text-text-secondary">每个物理目录只显示一次；点击目录进入内容，使用“调整”修改名称与识别设置</p><div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs"><span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-accent/15 bg-accent/[0.07] px-2.5 py-1.5 text-accent" title={`已识别季号：${seasonLabel}`}><span className="text-accent/60">季号</span><span className="min-w-0 truncate font-medium">{seasonLabel}</span></span><span className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.045] px-2.5 py-1.5 text-text-secondary"><span className="text-text-secondary/60">{canonical ? '条目' : '目录'}</span><span className="font-semibold text-text-primary tabular-nums">{entryCount}</span></span><span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/15 bg-amber-400/[0.05] px-2.5 py-1.5 text-amber-200"><span className="text-amber-200/60">待确认</span><span className="font-semibold tabular-nums">{summary?.unknown_count ?? 0}</span></span><span className="inline-flex items-center gap-1.5 rounded-lg border border-red-300/15 bg-red-400/[0.05] px-2.5 py-1.5 text-red-200"><span className="text-red-200/60">冲突</span><span className="font-semibold tabular-nums">{summary?.conflict_count ?? 0}</span></span></div></div>
        <div className="flex shrink-0 flex-wrap items-center gap-2"><Button size="sm" variant={item.pinned === 1 ? 'secondary' : 'ghost'} icon={<PinIcon width={14} height={14} />} disabled={busy !== null || pinning} onClick={() => { void togglePinned() }}>{pinning ? '保存中…' : item.pinned === 1 ? '取消合集' : '设为合集'}</Button><Button size="sm" variant="primary" icon={<RefreshIcon width={14} height={14} />} disabled={busy !== null || pinning} onClick={() => { void rebuild() }}>{busy === 'rebuild' ? '识别中…' : '重新识别'}</Button></div>
      </div>
      {error && <div role="alert" className="mt-3 rounded-xl border border-red-300/15 bg-red-400/[0.08] px-3 py-2.5 text-sm text-red-200">{error}</div>}
      {notice && <div role="status" className="mt-3 rounded-xl border border-emerald-300/15 bg-emerald-400/[0.07] px-3 py-2.5 text-sm text-emerald-200">{notice}</div>}
      {canonical && catalog && <MediaCatalogWorkGroups folderId={item.id} folderName={item.name} catalog={catalog} legacyGroupByFolderId={legacyGroupByFolderId} catalogBusy={busy} setCatalogBusy={setBusy} catalogEditingFolderId={editingFolderId} catalogDraftKind={draftKind} catalogDraftCustomLabel={draftCustomLabel} catalogDraftSeasons={draftSeasons} catalogDraftPart={draftPart} catalogDraftError={draftError} applyCatalogSnapshot={applySnapshot} beginCatalogEdit={beginEdit} setCatalogEditingFolderId={setEditingFolderId} setCatalogDraftKind={setDraftKind} setCatalogDraftCustomLabel={setDraftCustomLabel} setCatalogDraftSeasons={setDraftSeasons} setCatalogDraftPart={setDraftPart} runCatalogSave={save} runCatalogRestore={restore} runCatalogExclude={folderId => { void exclude(folderId) }} />}
      <MediaCatalogDirectoryList children={seasons} catalogGroups={groups} showDirectoryRows={!canonical} media_catalog_candidates={candidates} catalogBusy={busy} catalogCandidatesOpen={candidatesOpen} setCatalogCandidatesOpen={setCandidatesOpen} catalogEditingFolderId={editingFolderId} catalogDraftKind={draftKind} catalogDraftCustomLabel={draftCustomLabel} catalogDraftSeasons={draftSeasons} catalogDraftPart={draftPart} catalogDraftError={draftError} onDirectoryAdjust={beginDirectoryEdit} beginCatalogCandidateEdit={beginCandidateEdit} setCatalogEditingFolderId={setEditingFolderId} setCatalogDraftKind={setDraftKind} setCatalogDraftCustomLabel={setDraftCustomLabel} setCatalogDraftSeasons={setDraftSeasons} setCatalogDraftPart={setDraftPart} runCatalogSave={save} runCatalogRestore={restore} runCatalogExclude={folderId => { void exclude(folderId) }} />
    </section>
  </>
}
