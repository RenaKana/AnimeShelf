import { useEffect, useRef } from 'react'
import type { FolderView } from '../types'
import { formatOwnedSeasons } from '../lib/libraryFilters'
import { MEDIA_DOMAIN_LABELS } from '../../shared/media-domain'

const fmt = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`)
type FolderViewWithOwnedSeasons = FolderView & { owned_season_numbers?: number[] | null }

export default function DataTable({
  items, selected, onToggleSelect, onSelectAll, onOpen, showLibrary, showSeasons = true, selectionDisabled = false,
}: {
  items: FolderView[]; selected: Set<number>
  onToggleSelect: (id: number) => void; onSelectAll: () => void
  onOpen: (id: number) => void
  showLibrary?: boolean
  showSeasons?: boolean
  selectionDisabled?: boolean
}) {
  const selectedCount = items.filter(item => selected.has(item.id)).length
  const selectionActive = selectedCount > 0
  const allSelected = items.length > 0 && selectedCount === items.length
  const selectionPartial = selectedCount > 0 && !allSelected
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectionPartial
  }, [selectionPartial])
  return (
    <table className="library-data-table w-full table-fixed text-sm" data-show-library={Boolean(showLibrary)}>
      <thead>
        <tr className="h-11 border-b border-white/10 text-left text-[11px] font-medium uppercase tracking-wider text-text-secondary">
          <th className="px-2">标题</th>
          <th className="w-24 px-3">媒体类型</th>
          {showLibrary && <th className="hidden w-40 px-3 xl:table-cell">媒体库</th>}
          <th className="hidden w-28 px-3 text-right sm:table-cell">大小</th>
          <th className="hidden w-20 px-3 text-center lg:table-cell">文件</th>
          <th className="hidden w-56 px-3 xl:table-cell">标签</th>
          <th className="w-12 px-4 text-center">
            <input
              ref={selectAllRef}
              className="accent-accent"
              aria-label="选择全部"
              aria-checked={selectionPartial ? 'mixed' : allSelected ? 'true' : 'false'}
              type="checkbox"
              checked={allSelected}
              disabled={selectionDisabled || items.length === 0}
              onChange={onSelectAll}
            />
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map(item => {
          const isSelected = selected.has(item.id)
          const pathMissing = Boolean(item.path_missing)
          const ownedSeasons = !pathMissing && showSeasons
            ? formatOwnedSeasons((item as FolderViewWithOwnedSeasons).owned_season_numbers)
            : null
          return (
          <tr key={item.id} className={`group h-[58px] cursor-pointer border-b border-white/[0.055] transition-colors last:border-b-0 ${isSelected ? 'bg-accent/10' : 'hover:bg-white/[0.045]'}`} onClick={() => onOpen(item.id)}>
            <td className="min-w-0 px-2">
              <div className="truncate font-medium text-text-primary transition-colors group-hover:text-white" title={item.name}>{item.name}</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-text-secondary/75">
                <span className="truncate" title={item.path}>{item.path}</span>
                {showLibrary && item.library_name && <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 xl:hidden">{item.library_name}</span>}
                {pathMissing ? <span className="shrink-0 rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-amber-200" title="文件夹路径已缺失">缺失</span> : ownedSeasons && <span className="shrink-0 rounded border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-accent/90" title="已拥有季数">{ownedSeasons}</span>}
                {item.year && <span className="shrink-0 tabular-nums">{item.year}</span>}
                {typeof item.rating === 'number' && item.rating > 0 && <span className="shrink-0 text-amber-300/90 tabular-nums">★ {item.rating.toFixed(1)}</span>}
              </div>
            </td>
            <td className="px-3 text-xs text-text-secondary">{MEDIA_DOMAIN_LABELS[item.media_domain ?? 'unknown']}</td>
            {showLibrary && <td className="hidden truncate px-3 text-xs text-text-secondary xl:table-cell">{item.library_name ?? '—'}</td>}
            <td className="hidden px-3 text-right text-xs text-text-secondary tabular-nums sm:table-cell">{fmt(item.size)}</td>
            <td className="hidden px-3 text-center text-xs text-text-secondary tabular-nums lg:table-cell">{item.file_count}</td>
            <td className="hidden px-3 xl:table-cell">
              <div className="flex flex-wrap gap-1">
                {item.tags.slice(0, 4).map(t => (
                  <span key={t.id} className="rounded-full border px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: `${t.color}16`, borderColor: `${t.color}30`, color: t.color }}>{t.name.replace('状态:', '')}</span>
                ))}
                {item.tags.length === 0 && <span className="text-[11px] text-text-secondary/45">无标签</span>}
                {item.tags.length > 4 && <span className="text-[10px] text-text-secondary">+{item.tags.length - 4}</span>}
              </div>
            </td>
            <td className="px-4 text-center" onClick={e => e.stopPropagation()}>
              <input className={`table-row-selection accent-accent ${selectionActive ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`} aria-label={`选择 ${item.name}`} type="checkbox" checked={isSelected} disabled={selectionDisabled} onChange={() => onToggleSelect(item.id)} />
            </td>
          </tr>
        )})}
      </tbody>
    </table>
  )
}
