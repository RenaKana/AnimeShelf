import { useEffect, useState, type CSSProperties } from 'react'
import type { FolderView } from '../types'
import { formatOwnedSeasons } from '../lib/libraryFilters'
import { posterUrl, retainVisiblePosterErrors } from '../lib/poster'
import { useNumberPref, UI_PREF_KEYS } from '../lib/uiPreferences'
import { usePosterReveal } from '../lib/usePosterReveal'

type Props = {
  items: FolderView[]
  onOpen: (id: number) => void
  selected?: Set<number>
  onToggleSelect?: (id: number) => void
  showSeasons?: boolean
  posterSize?: number
  selectionDisabled?: boolean
}

type FolderViewWithOwnedSeasons = FolderView & { owned_season_numbers?: number[] | null }

function EmptyPoster({ name }: { name: string }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || 'A'
  return (
    <div className="poster-empty absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgb(var(--ui-accent)/0.24),transparent_40%),linear-gradient(145deg,#202838,#111722)] p-4">
      <span className="poster-empty-initial flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.06] text-2xl font-semibold text-white/65 ring-1 ring-white/10">{initial}</span>
      <span className="mt-3 line-clamp-3 text-center text-xs leading-relaxed text-text-secondary">{name}</span>
    </div>
  )
}

function PosterCard({ item, url, selected, compact, animDur, showSeasons, onOpen, onToggleSelect, onImageError, selectionDisabled }: {
  item: FolderView
  url: string | null
  selected: boolean
  compact: boolean
  animDur: number
  showSeasons: boolean
  onOpen: (id: number) => void
  onToggleSelect: (id: number) => void
  onImageError: (url: string) => void
  selectionDisabled?: boolean
}) {
  const statuses = item.tags.filter(tag => tag.name.startsWith('状态:'))
  const reveal = usePosterReveal()
  const pathMissing = Boolean(item.path_missing)
  const ownedSeasons = !pathMissing && showSeasons
    ? formatOwnedSeasons((item as FolderViewWithOwnedSeasons).owned_season_numbers)
    : null

  return (
    <article {...reveal} className={`poster-card group relative aspect-[2/3] min-w-0 overflow-hidden rounded-xl border bg-surface text-left shadow-[0_12px_28px_rgba(0,0,0,0.18)] transition-colors duration-150 ${selected ? 'border-accent ring-2 ring-accent/40' : 'border-white/10 hover:border-white/20'}`}>
      <button type="button" aria-label={`打开 ${item.name}`} className="poster-open absolute inset-0 h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" onClick={event => { if (!(event.target as HTMLElement).closest('.poster-synopsis-scroll')) onOpen(item.id) }}>
        <div className="poster-art media-overlay contents">
        {url ? (
          <img
            src={url}
            alt={item.name}
            loading="lazy"
            onError={() => onImageError(url)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : <EmptyPoster name={item.name} />}
        <span className="poster-shade" aria-hidden="true" />
        </div>

        {typeof item.rating === 'number' && item.rating > 0 && (
          <span className={`poster-rating absolute right-2 top-2 rounded-md border border-amber-300/15 bg-black/65 font-semibold text-amber-300 shadow backdrop-blur-md tabular-nums ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'}`}>★ {item.rating.toFixed(1)}</span>
        )}

        <div className="poster-caption poster-overlay-spacing absolute inset-x-0 bottom-0 flex max-h-full flex-col justify-end bg-gradient-to-t from-black via-black/82 to-transparent"
          style={{ '--poster-overlay-gutter': compact ? '0.5rem' : '0.75rem', '--poster-overlay-fade': compact ? '2.5rem' : '4rem' } as CSSProperties}>
          <div className="min-w-0">
            <div title={item.name} className={`poster-title min-w-0 line-clamp-2 font-semibold leading-[1.4] text-white drop-shadow ${compact ? 'text-[11px]' : 'text-sm'}`}>{item.name}</div>
            {statuses.length > 0 && (
              <div className="poster-status-list mt-1 flex max-w-full flex-wrap gap-1" aria-label="状态">
                {statuses.map(status => (
                  <span key={status.id} className="poster-status rounded-md border border-white/10 bg-black/65 px-1.5 py-0.5 text-[10px] font-medium leading-tight shadow backdrop-blur-md" style={{ color: status.color }}>
                    {status.name.replace('状态:', '')}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className={`poster-facts mt-1 flex min-h-4 min-w-0 items-center overflow-hidden text-white/65 ${compact ? 'gap-1.5 text-[9px]' : 'gap-2 text-[10px]'}`}>
            {item.year && <span className="shrink-0 tabular-nums">{item.year}</span>}
            {pathMissing ? <span className="shrink-0 rounded border border-amber-200/30 bg-amber-200/10 px-1 py-0.5 font-medium text-amber-100" title="文件夹路径已缺失">缺失</span> : ownedSeasons && <span className="poster-season-badge shrink-0 rounded border px-1 py-0.5 font-medium" title="已拥有季数">{ownedSeasons}</span>}
            {item.episodes ? <span className="shrink-0">{item.episodes} 集</span> : null}
          </div>
          <div className="poster-synopsis-reveal media-overlay overflow-hidden" style={{ transitionDuration: `${animDur}ms` }}>
            <div className="min-h-0 overflow-hidden">
              <p className={`poster-synopsis-scroll ${compact ? 'text-[9px] leading-[1.4]' : 'text-[10px] leading-relaxed'} text-white/82`}>{item.synopsis?.trim() || '暂无简介，可进入详情页补充元数据。'}</p>
            </div>
          </div>
        </div>
      </button>

      <button
        type="button"
        className={`poster-selection absolute left-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-md border text-xs shadow-lg backdrop-blur-md transition-colors ${selected ? 'border-accent bg-accent text-white opacity-100' : 'border-white/25 bg-black/55 text-white/70 opacity-0 hover:border-accent group-hover:opacity-100 group-focus-within:opacity-100'}`}
        aria-label={`${selected ? '取消选择' : '选择'} ${item.name}`}
        aria-pressed={selected}
        disabled={selectionDisabled}
        onClick={event => { event.stopPropagation(); onToggleSelect(item.id) }}>
        {selected ? '✓' : ''}
      </button>
    </article>
  )
}

export default function PosterWall({ items, onOpen, selected = new Set(), onToggleSelect = () => {}, showSeasons = true, posterSize = 150, selectionDisabled = false }: Props) {
  const [imgErr, setImgErr] = useState<Set<string>>(new Set())
  const animDur = useNumberPref(UI_PREF_KEYS.favoriteAnimationDuration, 500, 100, 1500)

  useEffect(() => {
    setImgErr(previous => retainVisiblePosterErrors(previous, items))
  }, [items])

  return (
    <div>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${posterSize}px), 1fr))` }}>
        {items.map(item => {
          const rawUrl = posterUrl(item)
          const url = rawUrl && !imgErr.has(rawUrl) ? rawUrl : null
          return (
            <PosterCard
              key={item.id}
              item={item}
              url={url}
              selected={selected.has(item.id)}
              compact={posterSize <= 130}
              animDur={animDur}
              showSeasons={showSeasons}
              onOpen={onOpen}
              onToggleSelect={onToggleSelect}
              selectionDisabled={selectionDisabled}
              onImageError={failedUrl => setImgErr(previous => new Set(previous).add(failedUrl))}
            />
          )
        })}
      </div>
    </div>
  )
}
