import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Tag } from '../types'
import type { MediaDomain } from '../../shared/media-domain'
import { customFilterTags, recommendedSortOrder, type LibrarySort, type SortOrder } from '../lib/libraryFilters'
import SegmentedControl from './ui/SegmentedControl'
import SelectMenu from './ui/SelectMenu'
import PosterSizeControl from './ui/PosterSizeControl'
import { ChevronDownIcon, SearchIcon } from './ui/Icons'
import { useOverlayPresence } from './ui/useOverlayPresence'
import { focusDialog, handleDialogKeyboardEvent } from './ui/dialogBehavior'
import { setTitlePosition, toggleDisplayPin, useDisplayPins, useTitlePosition } from '../lib/presentationPreferences'

export interface FilterState {
  q: string
  tag: string[]
  status: string[]
  libraryIds: number[] // Legacy cache field; normalized to empty, no longer a filter.
  mediaDomain: 'all' | MediaDomain
  tagMatch: 'any' | 'all'
  showSeasons: boolean
  view: 'table' | 'poster'
  sort: LibrarySort
  order: SortOrder
}

export function clearAdditionalFilters(value: FilterState): FilterState {
  return { ...value, tag: [], status: [], tagMatch: 'any' }
}

export function filterDimensionCount(value: Pick<FilterState, 'tag' | 'status' | 'libraryIds'>): number {
  return (value.tag?.length ? 1 : 0) + (value.status?.length ? 1 : 0)
}

type FilterBarProps = {
  value: FilterState
  onChange: (value: FilterState) => void
  tags: Tag[]
  showMediaDomainFilter?: boolean
  posterSize?: number
  onPosterSizeChange?: (value: number) => void
  openFilterRequest?: number
}

function FilterChoices<T extends string | number>({ label, value, options, onChange, compact = false }: {
  label: string; value: T[]; options: Array<{ value: T; label: string }>; onChange: (value: T[]) => void; compact?: boolean
}) {
  return <fieldset className="min-w-0 space-y-1.5">
    <legend className="flex w-full items-center justify-between text-xs font-medium text-text-secondary">
      {label}{value.length > 0 && <button type="button" className="text-accent" aria-label={`清除${label}筛选`} onClick={() => onChange([])}>清除</button>}
    </legend>
    <div className={`max-h-44 overflow-y-auto overscroll-contain ${compact ? 'grid grid-cols-2 gap-1' : 'space-y-1'}`}>
      {options.length === 0 ? <p className="filter-choice-empty py-1 text-xs text-text-secondary">暂无选项</p> : options.map(option => <label key={option.value} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-surface-hover">
        <input type="checkbox" className="accent-accent" checked={value.includes(option.value)} onChange={event => onChange(event.target.checked ? [...value, option.value] : value.filter(item => item !== option.value))} />
        <span className="min-w-0 break-words">{option.label}</span>
      </label>)}
    </div>
  </fieldset>
}

export function ToolbarPopover({
  open,
  anchorRef,
  onClose,
  children,
  className = '',
  label = '浏览与显示',
}: {
  open: boolean
  anchorRef: RefObject<HTMLButtonElement>
  onClose: () => void
  children: ReactNode
  className?: string
  label?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const { present, presenceProps } = useOverlayPresence(open, 'menu')
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const positioned = position !== null

  useEffect(() => {
    if (!open || !positioned) return
    const frame = requestAnimationFrame(() => {
      if (panelRef.current) focusDialog(panelRef.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [open, positioned])

  useLayoutEffect(() => {
    if (!open) {
      if (!present) setPosition(null)
      return
    }
    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(440, Math.max(240, window.innerWidth - 16))
      const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8))
      const top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 16))
      setPosition({ left, top, width })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open, present])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const portalMenu = (target as HTMLElement).closest?.('[role="listbox"]')
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target) || portalMenu) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [anchorRef, onClose, open])

  if (!present || !position || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={panelRef}
      {...presenceProps}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== 'Tab' || !panelRef.current) return
        handleDialogKeyboardEvent(event, {
          dialog: panelRef.current,
          activeElement: document.activeElement,
          closeDisabled: false,
          onClose,
        })
      }}
      className={`toolbar-popover ui-panel-strong fixed z-[120] max-h-[min(34rem,calc(100vh-1rem))] overflow-y-auto rounded-xl border border-border/70 p-3 text-text-primary shadow-[0_22px_60px_rgba(0,0,0,0.38)] ${className}`}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: Math.max(80, window.innerHeight - position.top - 8) }}>
      {children}
    </div>,
    document.body,
  )
}

const triggerClass = 'toolbar-trigger inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-surface/70 px-2.5 text-xs font-medium text-text-secondary outline-none transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-surface-hover hover:text-text-primary focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/15'

function PinToggle({ pinned, label, onToggle }: { pinned: boolean; label: string; onToggle: () => void }) {
  return <button
    type="button"
    className="display-pin-toggle shrink-0 rounded-md px-2 py-1 text-[11px] text-text-secondary transition hover:bg-surface-hover hover:text-text-primary"
    aria-pressed={pinned}
    aria-label={`${label}${pinned ? '已固定到外部' : '固定到外部'}`}
    onClick={onToggle}
  >{pinned ? '已固定' : '固定'}</button>
}

export default function FilterBar({
  value,
  onChange,
  tags,
  showMediaDomainFilter = false,
  posterSize,
  onPosterSizeChange,
  openFilterRequest = 0,
}: FilterBarProps) {
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch })
  const selectedTags = Array.isArray(value.tag) ? value.tag : value.tag ? [value.tag] : []
  const selectedStatuses = Array.isArray(value.status) ? value.status : value.status ? [value.status] : []
  const mediaDomain = value.mediaDomain ?? 'all'
  const tagMatch = value.tagMatch ?? 'any'
  const showSeasons = value.showSeasons ?? true
  const tagOptions = customFilterTags(tags).map(tag => ({ value: tag.name, label: tag.name }))
  const statusOptions = [
    { value: '状态:未看', label: '未看' },
    { value: '状态:在看', label: '在看' },
    { value: '状态:看完', label: '看完' },
    { value: '追番中', label: '追番中' },
  ]
  const sortOptions: Array<{ value: LibrarySort; label: string }> = [
    { value: 'name', label: '名称' },
    { value: 'size', label: '大小' },
    { value: 'file_count', label: '文件数' },
    { value: 'rating', label: '评分' },
    { value: 'year', label: '年份' },
  ]
  const sortLabel = sortOptions.find(option => option.value === value.sort)?.label ?? '名称'
  const filterCount = filterDimensionCount({ tag: selectedTags, status: selectedStatuses, libraryIds: [] })
  const hasAdditionalFilters = selectedTags.length > 0 || selectedStatuses.length > 0 || tagMatch !== 'any'
  const [open, setOpen] = useState(false)
  const titlePosition = useTitlePosition('library')
  const displayPins = useDisplayPins('library')
  const filterRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (openFilterRequest <= 0) return
    setOpen(true)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => filterRef.current?.focus())
  }, [openFilterRequest])

  const closePopover = () => {
    setOpen(false)
    filterRef.current?.focus()
  }

  const togglePin = (pin: Parameters<typeof toggleDisplayPin>[1]) => { toggleDisplayPin('library', pin) }
  const pinned = (pin: Parameters<typeof toggleDisplayPin>[1]) => displayPins.includes(pin)

  return (
    <div className="library-toolbar relative z-20 flex min-w-0 flex-wrap items-center gap-2 overflow-visible rounded-xl border border-border/70 bg-surface/55 px-2 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.1)]">
      <label className="library-search desktop-search-shell group flex min-w-[12rem] flex-[1_1_18rem] items-center gap-2 rounded-lg border border-border/70 bg-bg/60 px-3 transition-colors focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/10">
        <SearchIcon width={15} height={15} className="text-text-secondary transition group-focus-within:text-accent" />
        <input
          className="search-field min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary/60"
          placeholder="搜索名称或路径"
          value={value.q}
          onChange={event => set({ q: event.target.value })}
          aria-label="搜索名称或路径"
        />
        {value.q && (
          <button type="button" className="text-xs text-text-secondary hover:text-text-primary" onClick={() => set({ q: '' })} aria-label="清除搜索">×</button>
        )}
      </label>

      {showMediaDomainFilter && <SegmentedControl
        value={mediaDomain}
        options={[
          { value: 'all', label: '全部' },
          { value: 'anime', label: '动漫' },
          { value: 'live_action', label: '真人影视' },
          { value: 'unknown', label: '待确认' },
        ]}
        onChange={mediaDomain => set({ mediaDomain })}
        ariaLabel="媒体域"
        className="max-w-full"
      />}

      <div className="library-tools ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {pinned('view') && <button type="button" className={triggerClass} onClick={() => set({ view: value.view === 'table' ? 'poster' : 'table' })}>
          视图：{value.view === 'table' ? '表格' : '海报'}
        </button>}
        {pinned('sort') && <div className="pinned-sort-control inline-flex min-w-0 items-center gap-1">
          <SelectMenu
            value={value.sort}
            options={sortOptions}
            ariaLabel="选择固定排序字段"
            className="pinned-sort-field"
            minWidthClass="min-w-20"
            menuPosition="fixed"
            onChange={sort => set({ sort, order: recommendedSortOrder(sort) })}
          />
          <button
            type="button"
            className={`${triggerClass} sort-direction`}
            aria-label={`按${sortLabel}${value.order === 'asc' ? '升序' : '降序'}，点击切换为${value.order === 'asc' ? '降序' : '升序'}`}
            title={`当前按${sortLabel}${value.order === 'asc' ? '升序' : '降序'}`}
            onClick={() => set({ order: value.order === 'asc' ? 'desc' : 'asc' })}>
            排序 {value.order === 'asc' ? '↑' : '↓'}
          </button>
        </div>}
        {pinned('title') && <button type="button" className={triggerClass} onClick={() => setTitlePosition('library', titlePosition === 'overlay' ? 'below' : 'overlay')}>
          标题：{titlePosition === 'overlay' ? '图内' : '图外'}
        </button>}
        {pinned('season') && <button type="button" className={triggerClass} onClick={() => set({ showSeasons: !showSeasons })}>
          季号：{showSeasons ? '显示' : '隐藏'}
        </button>}
        {pinned('posterSize') && posterSize !== undefined && onPosterSizeChange && (
          <PosterSizeControl value={posterSize} min={100} max={280} onChange={onPosterSizeChange} className="library-pinned-poster-size" />
        )}
        <button
          ref={filterRef}
          type="button"
          className={`${triggerClass} ${filterCount > 0 ? 'border-accent/55 bg-accent/10 text-accent' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}>
          浏览与显示{filterCount > 0 ? ` · ${filterCount}` : ''}
          <ChevronDownIcon width={14} height={14} className={open ? 'rotate-180' : ''} />
        </button>
      </div>

      <ToolbarPopover open={open} anchorRef={filterRef} onClose={closePopover} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">浏览与显示</h2>
          <button type="button" className={triggerClass} aria-label="关闭浏览与显示" onClick={closePopover}>关闭 ×</button>
        </div>
        <section className="display-popover-section">
          <h3 className="display-popover-heading">浏览方式与排序</h3>
          <div className="display-option-list">
            <div className="display-option-row">
              <span className="display-option-label">显示方式</span>
              <SegmentedControl value={value.view} options={[{ value: 'table', label: '表格' }, { value: 'poster', label: '海报' }]} onChange={view => set({ view })} ariaLabel="显示方式" className="display-option-control" />
              <PinToggle pinned={pinned('view')} label="显示方式" onToggle={() => togglePin('view')} />
            </div>
            <div className="display-option-row">
              <span className="display-option-label">排序</span>
              <div className="sort-control inline-flex items-center" role="group" aria-label="排序">
                <button type="button" className={`${triggerClass} sort-direction`}
                  aria-label={`按${sortLabel}${value.order === 'asc' ? '升序' : '降序'}，点击切换为${value.order === 'asc' ? '降序' : '升序'}`}
                  onClick={() => set({ order: value.order === 'asc' ? 'desc' : 'asc' })}>
                  {sortLabel} <span aria-hidden="true">{value.order === 'asc' ? '↑' : '↓'}</span>
                </button>
                <SelectMenu value={value.sort} options={sortOptions} iconOnly ariaLabel="选择排序字段" minWidthClass="min-w-0" className="sort-field"
                  menuPosition="fixed" onChange={sort => { if (sort !== value.sort) set({ sort, order: recommendedSortOrder(sort) }) }} />
              </div>
              <PinToggle pinned={pinned('sort')} label="排序" onToggle={() => togglePin('sort')} />
            </div>
          </div>
        </section>
        <section className="display-popover-section">
          <div className="flex items-center justify-between gap-3">
            <h3 className="display-popover-heading">筛选结果</h3>
            {hasAdditionalFilters && (
              <button type="button" className="text-xs text-accent hover:text-text-primary" onClick={() => onChange(clearAdditionalFilters(value))}>清除附加筛选</button>
            )}
          </div>
          <div className={`grid gap-2 ${tagOptions.length > 0 ? 'sm:grid-cols-2' : ''}`}>
            {tagOptions.length > 0
              ? <FilterChoices label="标签" value={selectedTags} options={tagOptions} onChange={tag => set({ tag })} />
              : <p className="flex items-center gap-3 text-xs text-text-secondary"><span>标签</span><span className="text-[11px]">暂无标签</span></p>}
            <FilterChoices label="观看状态" value={selectedStatuses} options={statusOptions} compact={!tagOptions.length} onChange={status => set({ status })} />
          </div>
          {selectedTags.length >= 2 && (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
              <span className="text-[11px] text-text-secondary">标签匹配方式</span>
              <button type="button" className={triggerClass} onClick={() => set({ tagMatch: tagMatch === 'any' ? 'all' : 'any' })}>
                {tagMatch === 'any' ? '匹配任一标签 · 改为全部' : '匹配全部标签 · 改为任一'}
              </button>
            </div>
          )}
        </section>
        <section className="display-popover-section">
          <h3 className="display-popover-heading">海报显示</h3>
          <div className="display-option-list">
            <div className="display-option-row">
              <span className="display-option-label">标题位置</span>
              <button type="button" className={triggerClass}
                aria-label={`标题位置：${titlePosition === 'overlay' ? '图内，点击切换为图外' : '图外，点击切换为图内'}`}
                onClick={() => setTitlePosition('library', titlePosition === 'overlay' ? 'below' : 'overlay')}>
                标题{titlePosition === 'overlay' ? '在图内' : '在图外'}
              </button>
              <PinToggle pinned={pinned('title')} label="标题位置" onToggle={() => togglePin('title')} />
            </div>
            <div className="display-option-row">
              <span className="display-option-label">季号</span>
              <button type="button" className={triggerClass}
                aria-label={`已有季号：${showSeasons ? '显示，点击隐藏' : '隐藏，点击显示'}`}
                onClick={() => set({ showSeasons: !showSeasons })}>
                {showSeasons ? '显示' : '隐藏'}
              </button>
              <PinToggle pinned={pinned('season')} label="季号" onToggle={() => togglePin('season')} />
            </div>
            {posterSize !== undefined && onPosterSizeChange && <div className="display-option-row display-option-row-wide">
              <PosterSizeControl value={posterSize} min={100} max={280} onChange={onPosterSizeChange} className="w-full" />
              <PinToggle pinned={pinned('posterSize')} label="海报大小" onToggle={() => togglePin('posterSize')} />
            </div>}
          </div>
        </section>
      </ToolbarPopover>
    </div>
  )
}
