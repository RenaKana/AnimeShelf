import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MetadataCandidate, SeasonFavorite } from '@/types'
import type { MediaDomain, MediaDomainFields } from '../../../shared/media-domain'
import MediaDomainControl from '@/components/MediaDomainControl'
import { useModuleEnabled } from '@/modules/registry'
import { wishlistDownloadPath } from '../../../shared/download-navigation'
import { api } from './api'
import { DAY_LABELS } from './constants'
import { readNumberPref, readStringPref, useNumberPref, UI_PREF_KEYS, writePref } from '@/lib/uiPreferences'
import { usePosterReveal } from '@/lib/usePosterReveal'
import { hasSurfaceSelection, isSurfaceAction } from '@/lib/surfaceAction'
import PosterSizeControl from '@/components/ui/PosterSizeControl'
import SelectMenu from '@/components/ui/SelectMenu'
import { SearchIcon } from '@/components/ui/Icons'
import { useDialogBehavior } from '@/components/ui/dialogBehavior'
import OverlayPresence from '@/components/ui/OverlayPresence'
import { ToolbarPopover } from '@/components/FilterBar'
import { setTitlePosition, toggleDisplayPin, useDisplayPins, useTitlePosition, usePresentationError } from '@/lib/presentationPreferences'
import { WishlistLibraryStatusSelect, WishlistSourceSelect } from './WishlistControls'
import './favorite-editor.css'
import {
  FAVORITE_CARD_WIDTH_DEFAULT,
  FAVORITE_CARD_WIDTH_MAX,
  FAVORITE_CARD_WIDTH_MIN,
  FAVORITE_CARD_WIDTH_STEP,
  favoriteItemIdForCandidate,
  favoritePayloadFromCandidate,
  filterFavoriteEntries,
  formatFavoriteBeginDate,
  getFavoriteCardLayout,
  getFavoriteLibraryStatusPresentation,
  favoriteMediaDomain,
  favoriteMediaDomainLabel,
  isFavoriteCandidateAdded,
  isFavoriteEditorDirty,
  isFavoriteEditorSessionCurrent,
  metadataCandidateSource,
  normalizeFavoriteCardWidth,
  resolvedFavoriteAnimeStatus,
  selectFavoriteDraftAfterRefresh,
  selectRefreshedFavorite,
  sortFavoriteEntries,
  type FavoriteSortKey,
  type FavoriteSortState,
  type FavoriteLibraryStatusTone,
} from './favoriteLayout'

// 清洗简介中的 HTML 标签（<br>/<i> 等），保证毛玻璃遮罩上文字干净可读
function cleanSynopsis(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const FAVORITE_LIBRARY_BADGE_CLASSES: Record<FavoriteLibraryStatusTone, string> = {
  success: 'border-emerald-300/15 bg-emerald-950/75 text-emerald-300',
  info: 'border-sky-300/15 bg-sky-950/75 text-sky-300',
  neutral: 'border-white/10 bg-black/70 text-white/70',
  warning: 'border-amber-300/15 bg-amber-950/75 text-amber-200',
}

type FavoriteGroup = 'AIRING' | 'UPCOMING' | 'FINISHED' | 'LIVE' | 'UNKNOWN'

const FAVORITE_GROUPS: FavoriteGroup[] = ['AIRING', 'UPCOMING', 'FINISHED', 'LIVE', 'UNKNOWN']
const FAVORITE_GROUP_META: Record<FavoriteGroup, { icon: string; label: string }> = {
  AIRING: { icon: '🟢', label: '正在放送' },
  UPCOMING: { icon: '🌙', label: '未开播' },
  FINISHED: { icon: '🏁', label: '已完结' },
  LIVE: { icon: '🎬', label: '真人影视' },
  UNKNOWN: { icon: '❔', label: '待确认' },
}

function favoriteStatusLabel(f: SeasonFavorite): string {
  if (favoriteMediaDomain(f) === 'live_action') return '真人影视'
  if (favoriteMediaDomain(f) === 'unknown') return '待确认'
  return FAVORITE_GROUP_META[resolvedFavoriteAnimeStatus(f)].label
}

function favoriteProgressLabel(f: SeasonFavorite): string {
  if (favoriteMediaDomain(f) !== 'anime') return '—'
  const status = resolvedFavoriteAnimeStatus(f)
  const total = typeof f.total_episodes === 'number' && f.total_episodes > 0 ? f.total_episodes : null
  const aired = typeof f.aired_episodes === 'number' ? Math.max(0, f.aired_episodes) : null
  if (status === 'UPCOMING') return total ? `预计 ${total} 集` : '待定'
  if (status === 'FINISHED') return total ? `共 ${total} 集` : '已完结'
  if (total != null && aired != null) return `${aired} / ${total}`
  if (aired != null) return `已播 ${aired} 集`
  return total ? `共 ${total} 集` : '待定'
}

function favoriteScheduleLabel(f: SeasonFavorite): string {
  const date = formatFavoriteBeginDate(f.begin)
  const day = f.air_day ? (DAY_LABELS[f.air_day] ?? f.air_day) : ''
  const time = f.air_time ?? ''
  return [date, day && time ? `${day} ${time}` : day || time].filter(Boolean).join(' · ') || '待定'
}

function favoriteAddedAtLabel(value: string): string {
  if (!value) return '—'
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value.slice(0, 16) : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function FavoriteOverview({
  favorites,
  downloadEnabled,
  onEdit,
  onReload,
  onSaved,
  sortState,
  onToggleSort,
}: {
  favorites: SeasonFavorite[]
  downloadEnabled: boolean
  onEdit: (favorite: SeasonFavorite) => void
  onReload: () => Promise<SeasonFavorite[] | null>
  onSaved: (itemId: string, status: LibraryStatusChoice) => void
  sortState: FavoriteSortState
  onToggleSort: (key: FavoriteSortKey) => void
}) {
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const sortedFavorites = useMemo(() => sortFavoriteEntries(favorites, sortState), [favorites, sortState])

  const updateLibraryStatus = async (favorite: SeasonFavorite, status: LibraryStatusChoice) => {
    if (busyRows[favorite.item_id] || (favorite.lib_match_override ?? 'auto') === status) return
    setBusyRows(previous => ({ ...previous, [favorite.item_id]: true }))
    setRowErrors(previous => {
      const next = { ...previous }
      delete next[favorite.item_id]
      return next
    })
    try {
      await api.season.updateLibraryStatus(favorite.item_id, status)
      onSaved(favorite.item_id, status)
      await onReload()
    } catch (error) {
      setRowErrors(previous => ({ ...previous, [favorite.item_id]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusyRows(previous => ({ ...previous, [favorite.item_id]: false }))
    }
  }

  const sortLabel = (key: FavoriteSortKey) => sortState.key === key
    ? sortState.direction === 'asc' ? '升序' : '降序'
    : '未排序'

  const sortArrow = (key: FavoriteSortKey) => sortState.key === key
    ? sortState.direction === 'asc' ? '↑' : '↓'
    : '↕'

  return (
    <div className="favorites-overview ui-panel relative z-20 shrink-0 overflow-visible rounded-2xl border border-white/10 bg-[#111722]/80 shadow-[0_14px_36px_rgba(0,0,0,0.16)] backdrop-blur-lg">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="border-b border-white/[0.08] bg-black/10 text-text-secondary">
            <tr>
              {([
                ['title', '标题'],
                ['media_type', '类型'],
                ['status', '状态'],
                ['schedule', '播出时间 / 日期'],
                ['progress', '进度'],
                ['library', '媒体库'],
                ['added_at', '加入时间'],
              ] as const).map(([key, label]) => (
                <th key={key} scope="col" aria-sort={sortState.key === key ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4 py-2 font-medium">
                  <button
                    type="button"
                    className="flex w-full min-w-max items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition hover:bg-white/[0.06] hover:text-text-primary"
                    onClick={() => onToggleSort(key)}
                    aria-label={`按${label}排序，当前${sortLabel(key)}，点击切换`}
                  >
                    <span>{label}</span>
                    <span aria-hidden="true" className={`text-[11px] ${sortState.key === key ? 'text-accent' : 'text-text-secondary/50'}`}>{sortArrow(key)}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {sortedFavorites.map(favorite => {
              const title = favorite.title_zh || favorite.title
              const rowBusy = Boolean(busyRows[favorite.item_id])
              const rowError = rowErrors[favorite.item_id]
              return (
                <tr key={favorite.item_id} className="cursor-pointer transition-colors hover:bg-white/[0.035] focus-within:bg-white/[0.035]"
                  onClick={event => {
                    if (!isSurfaceAction(event)) return
                    event.currentTarget.querySelector<HTMLButtonElement>('[data-favorite-edit]')?.focus()
                    onEdit(favorite)
                  }}>
                  <td className="max-w-[260px] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button type="button" data-favorite-edit={favorite.item_id} className="min-w-0 truncate text-left font-medium text-text-primary underline-offset-2 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={event => { if (!hasSurfaceSelection(event.currentTarget)) onEdit(favorite) }} title="打开编辑面板">
                        {title}
                      </button>
                      {downloadEnabled && <Link to={wishlistDownloadPath(favorite)} aria-label={`查找 ${title} 的资源`} className="shrink-0 rounded px-1 py-1 text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">找资源</Link>}
                    </div>
                    {favorite.title_zh && favorite.title !== favorite.title_zh && <div className="mt-0.5 truncate text-[11px] text-text-secondary" title={favorite.title}>{favorite.title}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{favoriteMediaDomainLabel(favorite)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{favoriteStatusLabel(favorite)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary tabular-nums">{favoriteScheduleLabel(favorite)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary tabular-nums">{favoriteProgressLabel(favorite)}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    <WishlistLibraryStatusSelect
                      value={favorite.lib_match_override ?? 'auto'}
                      presentation={getFavoriteLibraryStatusPresentation(favorite)}
                      disabled={rowBusy}
                      onChange={status => void updateLibraryStatus(favorite, status)}
                    />
                    {rowBusy && <span className="ml-2 text-[10px] text-text-secondary">保存中…</span>}
                    {rowError && <span role="alert" className="mt-1 block max-w-[11rem] text-[10px] leading-relaxed text-red-300">{rowError}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary tabular-nums">{favoriteAddedAtLabel(favorite.added_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function EnhancedFavCard({ f, cardW, fontScale, synopsisAlpha, animDur, onEdit, downloadEnabled }: {
  f: SeasonFavorite
  cardW: number
  fontScale: number
  synopsisAlpha: number
  animDur: number
  onEdit: (f: SeasonFavorite) => void
  downloadEnabled: boolean
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const reveal = usePosterReveal()
  useEffect(() => { setImageFailed(false) }, [f.image])

  const layout = getFavoriteCardLayout(cardW)
  const status = favoriteMediaDomain(f) === 'anime' ? resolvedFavoriteAnimeStatus(f) : null
  const storedAired = typeof f.aired_episodes === 'number' ? Math.max(0, f.aired_episodes) : null
  const total = typeof f.total_episodes === 'number' && f.total_episodes > 0 ? f.total_episodes : null
  const aired = status === 'FINISHED' && total != null ? total : status === 'UPCOMING' && storedAired == null ? 0 : storedAired
  const progress = total && aired != null ? Math.min(100, Math.round(100 * aired / total)) : null
  const progressTitle = status === 'UPCOMING' ? '未开播' : status === 'FINISHED' ? '已完结' : '播出进度'
  const progressLabel = status === 'UPCOMING'
    ? (total ? `预计 ${total} 集` : '集数待定')
    : status === 'FINISHED'
      ? (total ? `共 ${total} 集` : '集数待补全')
      : progress != null
        ? `${aired} / ${total}`
        : aired != null && aired > 0 ? `已播 ${aired} 集` : total ? `共 ${total} 集` : '总集数待定'
  const title = f.title_zh || f.title
  const originalTitle = f.title_zh && f.title !== f.title_zh ? f.title : null
  const libraryPresentation = getFavoriteLibraryStatusPresentation(f)
  const synopsis = cleanSynopsis(f.synopsis) || '暂无简介，可通过“更新元数据”补充。'
  const badge = f.air_day
    ? `${DAY_LABELS[f.air_day] ?? f.air_day}${f.air_time ? ` ${f.air_time}` : ''}`
    : favoriteMediaDomain(f) === 'live_action' ? '真人影视' : favoriteMediaDomain(f) === 'unknown' ? '待确认' : null
  const overlayGutter = layout.density === 'comfortable' ? '0.75rem' : layout.density === 'compact' ? '0.625rem' : '0.5rem'
  const overlayFade = layout.density === 'comfortable' ? '4rem' : layout.density === 'compact' ? '3rem' : '2.5rem'
  const synopsisText = layout.density === 'comfortable'
    ? 'text-[0.73em] leading-relaxed'
    : layout.density === 'compact'
      ? 'text-[0.69em] leading-[1.45]'
      : 'text-[0.66em] leading-[1.4]'

  return (
    <article {...reveal}
      onClick={event => {
        if (!isSurfaceAction(event)) return
        event.currentTarget.querySelector<HTMLButtonElement>('[data-favorite-edit]')?.focus()
        onEdit(f)
      }}
      className="favorite-poster-card poster-card group relative aspect-[2/3] min-w-0 overflow-hidden rounded-xl border border-white/10 bg-surface shadow-[0_14px_34px_rgba(0,0,0,0.2)] transition-colors duration-150 hover:border-white/20 focus-within:border-accent/60"
      style={{ fontSize: `${13 * fontScale}px` }}>
      <button type="button" data-favorite-edit={f.item_id} className="favorite-poster-art media-overlay absolute inset-0 z-0 h-full w-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent" onClick={event => { if (!hasSurfaceSelection(event.currentTarget.parentElement!)) onEdit(f) }} aria-label={`编辑 ${title}`} title="打开编辑面板">
        {f.image && !imageFailed ? (
          <img src={f.image} alt={title} loading="lazy" onError={() => setImageFailed(true)}
            className="h-full w-full object-cover object-top" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_35%_20%,rgb(var(--ui-accent)/0.25),transparent_42%),linear-gradient(145deg,#202838,#111722)] p-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.06] text-[1.8em] font-semibold text-white/60 ring-1 ring-white/10">{title.trim().slice(0, 1) || '★'}</span>
            <span className="mt-3 line-clamp-3 text-center text-[0.82em] leading-relaxed text-text-secondary">{title}</span>
          </div>
        )}
      <span className="poster-shade" aria-hidden="true" />
      </button>

      <span
        className={`favorite-poster-badge media-overlay pointer-events-none absolute left-2 top-2 z-20 max-w-[58%] truncate rounded-md border px-2 py-1 text-[0.7em] font-medium shadow backdrop-blur-md ${FAVORITE_LIBRARY_BADGE_CLASSES[libraryPresentation.tone]}`}
        title={libraryPresentation.folder ? `${libraryPresentation.ariaLabel}：${libraryPresentation.folder}` : libraryPresentation.ariaLabel}>
        <span aria-hidden="true">●</span> {libraryPresentation.label}
      </span>
      {badge && (
        <span className="favorite-poster-badge media-overlay pointer-events-none absolute right-2 top-2 z-20 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-[0.72em] font-medium text-accent shadow backdrop-blur-md tabular-nums">{badge}</span>
      )}

      {/* Reserve the top badges; let the synopsis shrink and scroll before clipping the title. */}
      <div className="favorite-poster-caption poster-overlay-spacing pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-[calc(100%-3.5rem)] flex-col justify-end overflow-hidden bg-gradient-to-t from-black via-black/85 to-transparent"
        style={{ '--poster-overlay-gutter': overlayGutter, '--poster-overlay-fade': overlayFade } as React.CSSProperties}>
        <div className="pointer-events-none flex min-h-0 shrink-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 font-semibold leading-snug text-white drop-shadow" title={title}>{title}</h3>
            {layout.showOriginalTitle && originalTitle && <div className="favorite-original mt-0.5 truncate text-[0.72em] text-white/55" title={originalTitle}>{originalTitle}</div>}
          </div>
          {downloadEnabled && <Link to={wishlistDownloadPath(f)} aria-label={`查找 ${title} 的资源`} className="favorite-resource-link pointer-events-auto shrink-0 rounded-md border border-white/15 bg-black/50 px-2 py-1 text-[0.75em] text-white/85 transition hover:bg-accent/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">找资源</Link>}
        </div>

        {layout.showProgress && favoriteMediaDomain(f) === 'anime' && <div className="pointer-events-none mt-2 shrink-0">
          <div className="mb-1 flex items-center justify-between gap-2 text-[0.68em] font-medium text-white/65">
            <span className="truncate">{progressTitle}</span>
            <span className={`shrink-0 tabular-nums ${progress == null ? 'text-white/50' : 'text-accent'}`}>{progressLabel}</span>
          </div>
          <div className="favorite-progress-track h-1 overflow-hidden rounded-full bg-white/15">
            {progress != null && (
              <div className="favorite-progress-fill h-full w-full origin-left rounded-full bg-gradient-to-r from-accent-fill to-accent-fill transition-transform duration-200 ease-[var(--ease-out)]" style={{ transform: `scaleX(${progress / 100})` }} />
            )}
          </div>
        </div>}

        <div
          className="poster-synopsis-reveal media-overlay pointer-events-none min-h-0 overflow-hidden"
          style={{ transitionDuration: `${animDur}ms` }}>
          <div className="flex min-h-0 flex-col overflow-hidden">
            <div
              className="favorite-synopsis-panel pointer-events-auto max-h-[min(26vh,12rem)] cursor-pointer overflow-y-auto overscroll-contain rounded-lg border border-white/[0.07] p-2 scrollbar-thin"
              style={{ background: `rgba(0,0,0,${synopsisAlpha})` }}
              title="点击简介打开编辑面板">
              <p className={`${synopsisText} text-white/88`}>{synopsis}</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}

const SOURCES = [
  { value: 'auto', label: '自动（按条目类型）' },
  { value: 'bangumi', label: '仅 Bangumi（中文简介）' },
  { value: 'anilist', label: '仅 AniList' },
  { value: 'tmdb', label: '仅 TMDB' },
] as const

const LIBRARY_STATUS_OPTIONS = [
  { value: 'auto', label: '使用自动判断' },
  { value: 'present', label: '标记为已收录' },
  { value: 'absent', label: '标记为未收录' },
] as const
type LibraryStatusChoice = typeof LIBRARY_STATUS_OPTIONS[number]['value']

const FAVORITE_SORT_LABELS: Record<FavoriteSortKey, string> = {
  title: '标题',
  media_type: '类型',
  status: '状态',
  schedule: '播出时间',
  progress: '进度',
  library: '媒体库',
  added_at: '加入时间',
}

const FAVORITE_SORT_OPTIONS: ReadonlyArray<{ value: FavoriteSortKey; label: string }> = [
  { value: 'title', label: FAVORITE_SORT_LABELS.title },
  { value: 'media_type', label: FAVORITE_SORT_LABELS.media_type },
  { value: 'status', label: FAVORITE_SORT_LABELS.status },
  { value: 'schedule', label: FAVORITE_SORT_LABELS.schedule },
  { value: 'progress', label: FAVORITE_SORT_LABELS.progress },
  { value: 'library', label: FAVORITE_SORT_LABELS.library },
  { value: 'added_at', label: FAVORITE_SORT_LABELS.added_at },
]

function DisplayPinToggle({ pinned, label, onToggle }: { pinned: boolean; label: string; onToggle: () => void }) {
  return <button
    type="button"
    className="display-pin-toggle shrink-0 rounded-md px-2 py-1 text-[11px] text-text-secondary transition hover:bg-surface-hover hover:text-text-primary"
    aria-pressed={pinned}
    aria-label={`${label}${pinned ? '已固定到外部' : '固定到外部'}`}
    onClick={onToggle}
  >{pinned ? '已固定' : '固定'}</button>
}

// 心愿单视图：卡片 = 海报墙风格（统一 2:3，宽度/字号可调）；
// hover 时底部信息区渐显，简介在有限高度内滚动，点击可打开编辑面板。
export default function FavoritesView() {
  const navigate = useNavigate()
  const downloadEnabled = useModuleEnabled('download')
  const titlePosition = useTitlePosition('favorite')
  const presentationError = usePresentationError()
  const [localPreferenceError, setLocalPreferenceError] = useState('')
  const [displayOpen, setDisplayOpen] = useState(false)
  const displayRef = useRef<HTMLButtonElement>(null)
  const closeDisplay = () => { setDisplayOpen(false); displayRef.current?.focus() }
  const [manageOpen, setManageOpen] = useState(false)
  const manageRef = useRef<HTMLButtonElement>(null)
  const closeManage = () => { setManageOpen(false); manageRef.current?.focus() }
  const [favs, setFavs] = useState<SeasonFavorite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const loadGenerationRef = useRef(0)
  const load = useCallback(async (options: { refreshLibraryMatches?: boolean } = {}): Promise<SeasonFavorite[] | null> => {
    const generation = ++loadGenerationRef.current
    setLoading(true)
    try {
      const nextFavorites = await api.season.favorites(options)
      if (generation !== loadGenerationRef.current) return null
      setFavs(nextFavorites)
      setLoadError('')
      return nextFavorites
    } catch (error) {
      if (generation === loadGenerationRef.current) setLoadError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const [refreshingLibraryMatches, setRefreshingLibraryMatches] = useState(false)
  const [editing, setEditing] = useState<SeasonFavorite | null>(null)
  const [customUrl, setCustomUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const deletePendingRef = useRef(false)
  const [msg, setMsg] = useState('')
  const [sourceSel, setSourceSel] = useState<'auto' | 'anilist' | 'bangumi' | 'tmdb'>('auto')
  const [synopsisDraft, setSynopsisDraft] = useState('')
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatusChoice>('auto')
  const [mediaDomainDraft, setMediaDomainDraft] = useState<MediaDomain | null>(null)
  const [cardW, setCardW] = useState(() => normalizeFavoriteCardWidth(readNumberPref(UI_PREF_KEYS.favoriteCardWidth, FAVORITE_CARD_WIDTH_DEFAULT, FAVORITE_CARD_WIDTH_MIN, FAVORITE_CARD_WIDTH_MAX)))
  const [fontScale] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteFontScale, 1, 0.7, 1.4))
  const [synopsisAlpha] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteSynopsisAlpha, 0.6, 0, 0.95))
  const animDur = useNumberPref(UI_PREF_KEYS.favoriteAnimationDuration, 500, 100, 1500)
  const refreshLibraryMatches = async () => {
    if (refreshingLibraryMatches) return
    setRefreshingLibraryMatches(true)
    try {
      await load({ refreshLibraryMatches: true })
    } finally {
      setRefreshingLibraryMatches(false)
    }
  }
  const setCardWidth = (width: number) => {
    const normalized = normalizeFavoriteCardWidth(width)
    setCardW(normalized)
    setLocalPreferenceError(writePref(UI_PREF_KEYS.favoriteCardWidth, normalized) ? '' : '海报大小已生效，但无法保存到本机。')
  }

  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const editorSessionRef = useRef(0)
  const editingIdRef = useRef<string | null>(null)
  const editorReturnIdRef = useRef<string | null>(null)
  // Saving a different domain can remount the card in another group. Resolve
  // its current button instead of restoring focus to the detached old card.
  const editorTriggerRef = useMemo(() => ({ get current() {
    if (typeof document === 'undefined') return null
    return [...document.querySelectorAll<HTMLElement>('[data-favorite-edit]')]
      .find(button => button.dataset.favoriteEdit === editorReturnIdRef.current) ?? null
  } }), [])
  const editorDirty = editing ? isFavoriteEditorDirty(editing, synopsisDraft, libraryStatus, mediaDomainDraft) : false

  const discardEditor = useCallback(() => {
    editorSessionRef.current += 1
    editingIdRef.current = null
    setEditing(null)
  }, [])

  const closeEditor = () => {
    if (busy) return
    if (editorDirty && !window.confirm('有未保存的更改，确定放弃并关闭吗？')) return
    discardEditor()
  }

  const findEditingResources = () => {
    if (!editing || busy || !downloadEnabled) return
    if (editorDirty && !window.confirm('有未保存的更改，确定放弃并前往下载页吗？')) return
    const path = wishlistDownloadPath(editing)
    discardEditor()
    navigate(path)
  }

  useDialogBehavior({
    open: editing !== null,
    dialogRef: drawerRef,
    initialFocusRef: closeButtonRef,
    triggerRef: editorTriggerRef,
    onClose: closeEditor,
    closeDisabled: busy,
  })

  const openEditor = (favorite: SeasonFavorite) => {
    editorSessionRef.current += 1
    editingIdRef.current = favorite.item_id
    editorReturnIdRef.current = favorite.item_id
    setEditing(favorite)
    setCustomUrl('')
    setMsg('')
    setSourceSel('auto')
    setSynopsisDraft(favorite.synopsis ?? '')
    setLibraryStatus(favorite.lib_match_override ?? 'auto')
    setMediaDomainDraft(favorite.media_domain_override ?? null)
  }
  const applyPoster = async (url?: string) => {
    if (!editing || busy) return
    const requestSession = editorSessionRef.current
    const requestItemId = editing.item_id
    const synopsisWasDirty = synopsisDraft.trim() !== (editing.synopsis ?? '').trim()
    setBusy(true); setMsg('')
    try {
      const r = await api.season.updatePoster(editing.item_id, url, url ? undefined : sourceSel)
      const fallback = r.image ? { ...editing, image: r.image } : editing
      const refreshed = await load()
      if (!isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) return
      const nextEditing = selectRefreshedFavorite(fallback, refreshed)
      setEditing(previous => previous?.item_id === requestItemId ? nextEditing : previous)
      if (!url) setSynopsisDraft(selectFavoriteDraftAfterRefresh(synopsisDraft, editing.synopsis, nextEditing.synopsis))
      setMsg(url
        ? r.image ? '自定义海报已应用' : '未能应用自定义海报'
        : r.image
          ? synopsisWasDirty ? '海报与资料已更新，未保存的简介编辑已保留' : '海报与资料已更新'
          : synopsisWasDirty ? '未获取到新海报，其他资料已同步；未保存的简介编辑已保留' : '未获取到新海报，其他资料已同步')
    } catch (error) {
      if (isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) {
        setMsg(`失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) setBusy(false)
    }
  }

  const saveChanges = async () => {
    if (!editing || busy) return
    const requestSession = editorSessionRef.current
    const requestItemId = editing.item_id
    const synopsis = synopsisDraft.trim()
    const savedSynopsis = (editing.synopsis ?? '').trim()
    const savedLibraryStatus = editing.lib_match_override ?? 'auto'
    const savedMediaDomain = editing.media_domain_override ?? null
    type SaveTask = { label: string; kind: 'synopsis' | 'libraryStatus' | 'mediaDomain'; run: () => Promise<unknown> }
    const tasks: SaveTask[] = []
    if (synopsis !== savedSynopsis) {
      tasks.push({ label: '简介', kind: 'synopsis', run: () => api.season.updateSynopsis(editing.item_id, synopsis) })
    }
    if (libraryStatus !== savedLibraryStatus) {
      tasks.push({ label: '媒体库状态', kind: 'libraryStatus', run: () => api.season.updateLibraryStatus(editing.item_id, libraryStatus) })
    }
    if (mediaDomainDraft !== savedMediaDomain) {
      tasks.push({ label: '媒体类型', kind: 'mediaDomain', run: () => api.season.updateMediaDomain(editing.item_id, mediaDomainDraft) })
    }
    if (tasks.length === 0) {
      setMsg('没有需要保存的更改')
      return
    }

    setBusy(true); setMsg('')
    const results = await Promise.allSettled(tasks.map(task => task.run()))
    if (!isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) return
    let nextSynopsis = editing.synopsis ?? ''
    let nextLibraryStatus: LibraryStatusChoice = savedLibraryStatus
    let nextMediaDomain: MediaDomain | null = savedMediaDomain
    let synopsisFailed = false
    let libraryStatusFailed = false
    let mediaDomainFailed = false
    const failures: string[] = []
    results.forEach((result, index) => {
      const task = tasks[index]
      if (result.status === 'fulfilled') {
        if (task.kind === 'synopsis') nextSynopsis = synopsis
        if (task.kind === 'libraryStatus') nextLibraryStatus = libraryStatus
        if (task.kind === 'mediaDomain') nextMediaDomain = mediaDomainDraft
      } else {
        if (task.kind === 'synopsis') synopsisFailed = true
        if (task.kind === 'libraryStatus') libraryStatusFailed = true
        if (task.kind === 'mediaDomain') mediaDomainFailed = true
        const detail = result.reason instanceof Error ? result.reason.message : String(result.reason)
        failures.push(`${task.label}${detail ? `：${detail}` : ''}`)
      }
    })
    const savedSomething = results.some(result => result.status === 'fulfilled')
    if (savedSomething) {
      const fallback = {
        ...editing,
        synopsis: nextSynopsis,
        lib_match_override: nextLibraryStatus === 'auto' ? null : nextLibraryStatus,
        media_domain_override: nextMediaDomain,
      }
      const refreshed = await load()
      if (!isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) return
      const nextEditing = selectRefreshedFavorite(fallback, refreshed)
      setEditing(previous => previous?.item_id === requestItemId ? nextEditing : previous)
      setSynopsisDraft(synopsisFailed ? synopsisDraft : (nextEditing.synopsis ?? ''))
      setLibraryStatus(libraryStatusFailed ? libraryStatus : (nextEditing.lib_match_override ?? 'auto'))
      setMediaDomainDraft(mediaDomainFailed ? mediaDomainDraft : (nextEditing.media_domain_override ?? null))
    }
    setMsg(failures.length > 0 ? `部分保存失败：${failures.join('、')}` : '更改已保存')
    setBusy(false)
  }

  const removeFavorite = async () => {
    if (!editing || busy || deletePendingRef.current) return
    const favorite = editing
    const requestSession = editorSessionRef.current
    const requestItemId = favorite.item_id
    deletePendingRef.current = true
    setDeleting(true)
    setBusy(true)
    setMsg('')
    try {
      await api.season.unfavorite(requestItemId)
      // Do not let a list read started before deletion bring the item back.
      loadGenerationRef.current += 1
      setLoading(false)
      setFavs(previous => previous.filter(item => item.item_id !== requestItemId))
      if (!isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) return
      setBusy(false)
      discardEditor()
    } catch (error) {
      if (isFavoriteEditorSessionCurrent(requestSession, requestItemId, editorSessionRef.current, editingIdRef.current)) {
        setMsg(`删除失败：${error instanceof Error ? error.message : String(error)}`)
        setBusy(false)
      }
    } finally {
      deletePendingRef.current = false
      setDeleting(false)
    }
  }

  // —— 多源搜索加入心愿单 ——
  const [query, setQuery] = useState('')
  const [src, setSrc] = useState<'anilist' | 'bangumi' | 'tmdb'>('bangumi')
  const [results, setResults] = useState<MetadataCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [addingId, setAddingId] = useState('')
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [favoriteView, setFavoriteView] = useState<'posters' | 'overview'>(() => readStringPref(UI_PREF_KEYS.favoriteView, 'posters', ['posters', 'overview'] as const))
  const [favoriteSort, setFavoriteSort] = useState<FavoriteSortState>({ key: 'added_at', direction: 'desc' })
  const displayPins = useDisplayPins('favorite')
  const searchRequestRef = useRef(0)
  const doSearch = async (s: typeof src = src) => {
    const q = query.trim()
    const requestId = ++searchRequestRef.current
    if (!q) {
      setSearching(false)
      setSearchErr('')
      setResults([])
      return
    }
    setSearching(true); setSearchErr(''); setResults([])
    try {
      const nextResults = await api.metadata.search(q, s)
      if (requestId === searchRequestRef.current) setResults(nextResults)
    } catch (e: any) {
      if (requestId === searchRequestRef.current) setSearchErr(e.message)
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }
  const changeSearchSource = (nextSource: typeof src) => {
    if (nextSource === src) return
    searchRequestRef.current += 1
    setSrc(nextSource)
    setSourceMenuOpen(false)
    setResults([])
    setSearchErr('')
    setSearching(false)
    if (query.trim()) void doSearch(nextSource)
  }
  const addFromSearch = async (c: MetadataCandidate) => {
    const sourceKey = metadataCandidateSource(c)
    const payload = favoritePayloadFromCandidate(c, sourceKey)
    const itemId = favoriteItemIdForCandidate(c, sourceKey)
    const searchGeneration = searchRequestRef.current
    if (isFavoriteCandidateAdded(favs, c, sourceKey)) { alert('已在心愿单中'); return }
    setAddingId(itemId)
    try {
      await api.season.favorite(payload)
      await load()
      setSourceMenuOpen(false)
      // 加入成功后收起结果，但保留搜索文本方便切换数据源重新搜索。
      if (searchGeneration === searchRequestRef.current) {
        setResults([])
        setSearchErr('')
      }
    } catch (e: any) {
      alert(`加入心愿单失败：${e.message}`)
    } finally {
      setAddingId('')
    }
  }

  const visibleFavs = useMemo(() => filterFavoriteEntries(favs, query), [favs, query])

  const updateOverviewLibraryStatus = useCallback((itemId: string, status: LibraryStatusChoice) => {
    setFavs(previous => previous.map(favorite => favorite.item_id === itemId
      ? {
        ...favorite,
        lib_match_override: status === 'auto' ? null : status,
        lib_status: status === 'present' ? 'present' : status === 'absent' ? 'absent' : favorite.lib_status,
        lib_hit: status === 'present'
          ? { matched: true, method: 'manual', folderName: null, folderId: null }
          : status === 'absent' ? null : favorite.lib_hit,
      }
      : favorite))
  }, [])

  const clearSearch = () => {
    searchRequestRef.current += 1
    setQuery('')
    setResults([])
    setSearchErr('')
    setSearching(false)
  }

  const updateFavoriteView = (view: 'posters' | 'overview') => {
    setFavoriteView(view)
    setLocalPreferenceError(writePref(UI_PREF_KEYS.favoriteView, view) ? '' : '视图已切换，但无法保存到本机。')
  }

  const toggleFavoriteSort = (key: FavoriteSortKey) => {
    setFavoriteSort(previous => previous.key === key
      ? { key, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' })
  }
  const selectFavoriteSort = (key: FavoriteSortKey) => {
    setFavoriteSort(previous => previous.key === key ? previous : { key, direction: 'asc' })
  }
  const togglePin = (pin: Parameters<typeof toggleDisplayPin>[1]) => { toggleDisplayPin('favorite', pin) }
  const pinned = (pin: Parameters<typeof toggleDisplayPin>[1]) => displayPins.includes(pin)

  // 分组只使用统一媒体域；旧 media_type 仅保留给外部兼容协议。
  const groups = useMemo(() => {
    const byGroup: Record<FavoriteGroup, SeasonFavorite[]> = { AIRING: [], UPCOMING: [], FINISHED: [], LIVE: [], UNKNOWN: [] }
    for (const f of visibleFavs) {
      if (favoriteMediaDomain(f) === 'live_action') { byGroup.LIVE.push(f); continue }
      if (favoriteMediaDomain(f) === 'unknown') { byGroup.UNKNOWN.push(f); continue }
      byGroup[resolvedFavoriteAnimeStatus(f)].push(f)
    }
    for (const group of FAVORITE_GROUPS) byGroup[group] = sortFavoriteEntries(byGroup[group], favoriteSort)
    return byGroup
  }, [favoriteSort, visibleFavs])

  const editorMediaDomainValue: MediaDomainFields = editing ? {
    ...editing,
    media_domain_override: mediaDomainDraft,
    media_domain: mediaDomainDraft ?? editing.media_domain,
    media_domain_source: mediaDomainDraft != null ? 'manual' : editing.media_domain_source,
    media_domain_reason: mediaDomainDraft === 'unknown' ? 'manual_pending' : mediaDomainDraft != null ? null : editing.media_domain_reason,
  } : {}

  return (
    <>
      <div data-title-position={titlePosition} className="favorites-page clean-page page-shell">
        <div className="clean-page-header page-header ui-panel flex shrink-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="page-title">心愿单</h1>
            <p className="page-subtitle">{query.trim() ? `${visibleFavs.length} / ${favs.length}` : favs.length} 个条目 · 按播出状态自动分组</p>
            {(localPreferenceError || presentationError) && <p role="status" className="text-xs text-warning">{localPreferenceError || presentationError}</p>}
          </div>
          <div className="favorites-view-switch flex shrink-0 flex-wrap items-center justify-end gap-1" role="group" aria-label="心愿单浏览与显示">
            {pinned('view') && <button type="button" className="toolbar-trigger px-3 text-xs" onClick={() => updateFavoriteView(favoriteView === 'posters' ? 'overview' : 'posters')}>视图：{favoriteView === 'posters' ? '海报' : '总览'}</button>}
            {pinned('sort') && <div className="pinned-sort-control inline-flex min-w-0 items-center gap-1">
              <SelectMenu
                value={favoriteSort.key}
                options={FAVORITE_SORT_OPTIONS}
                ariaLabel="选择固定排序字段"
                className="pinned-sort-field"
                minWidthClass="min-w-20"
                menuPosition="fixed"
                onChange={selectFavoriteSort}
              />
              <button
                type="button"
                className="toolbar-trigger sort-direction px-3 text-xs"
                aria-label={`按${FAVORITE_SORT_LABELS[favoriteSort.key]}${favoriteSort.direction === 'asc' ? '升序' : '降序'}，点击切换为${favoriteSort.direction === 'asc' ? '降序' : '升序'}`}
                title={`当前按${FAVORITE_SORT_LABELS[favoriteSort.key]}${favoriteSort.direction === 'asc' ? '升序' : '降序'}`}
                onClick={() => toggleFavoriteSort(favoriteSort.key)}>
                排序 {favoriteSort.direction === 'asc' ? '↑' : '↓'}
              </button>
            </div>}
            {pinned('title') && <button type="button" className="toolbar-trigger px-3 text-xs" onClick={() => setTitlePosition('favorite', titlePosition === 'overlay' ? 'below' : 'overlay')}>标题：{titlePosition === 'overlay' ? '图内' : '图外'}</button>}
            {pinned('posterSize') && <PosterSizeControl value={cardW} min={FAVORITE_CARD_WIDTH_MIN} max={FAVORITE_CARD_WIDTH_MAX} step={FAVORITE_CARD_WIDTH_STEP} onChange={setCardWidth} className="favorite-pinned-poster-size" />}
            <button ref={displayRef} type="button" className="toolbar-trigger px-3 text-xs" aria-haspopup="dialog" aria-expanded={displayOpen} onClick={() => setDisplayOpen(value => !value)}>浏览与显示</button>
            <ToolbarPopover open={displayOpen} anchorRef={displayRef} onClose={closeDisplay} label="心愿单浏览与显示" className="space-y-4">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">心愿单 · 浏览与显示</h2><button type="button" className="toolbar-trigger px-2 text-xs" onClick={closeDisplay}>关闭 ×</button></div>
              <section className="display-popover-section">
                <h3 className="display-popover-heading">浏览方式与排序</h3>
                <div className="display-option-list">
                  <div className="display-option-row">
                    <span className="display-option-label">显示方式</span>
                    <button type="button" className="toolbar-trigger px-2 text-xs" onClick={() => updateFavoriteView(favoriteView === 'posters' ? 'overview' : 'posters')}>当前：{favoriteView === 'posters' ? '海报' : '总览'}</button>
                    <DisplayPinToggle pinned={pinned('view')} label="显示方式" onToggle={() => togglePin('view')} />
                  </div>
                  <div className="display-option-row">
                    <span className="display-option-label">排序</span>
                    <div className="sort-control inline-flex items-center" role="group" aria-label="排序">
                      <SelectMenu value={favoriteSort.key} options={FAVORITE_SORT_OPTIONS} ariaLabel="选择排序字段" iconOnly minWidthClass="min-w-0" className="sort-field" menuPosition="fixed" onChange={selectFavoriteSort} />
                      <button type="button" className="toolbar-trigger sort-direction px-2 text-xs" aria-label={`按${FAVORITE_SORT_LABELS[favoriteSort.key]}${favoriteSort.direction === 'asc' ? '升序' : '降序'}，点击切换为${favoriteSort.direction === 'asc' ? '降序' : '升序'}`} onClick={() => toggleFavoriteSort(favoriteSort.key)}>{FAVORITE_SORT_LABELS[favoriteSort.key]} {favoriteSort.direction === 'asc' ? '↑' : '↓'}</button>
                    </div>
                    <DisplayPinToggle pinned={pinned('sort')} label="排序" onToggle={() => togglePin('sort')} />
                  </div>
                </div>
              </section>
              <section className="display-popover-section">
                <h3 className="display-popover-heading">海报显示</h3>
                <div className="display-option-list">
                  <div className="display-option-row">
                    <span className="display-option-label">标题位置</span>
                    <button type="button" className="toolbar-trigger px-2 text-xs" aria-label={`标题位置：${titlePosition === 'overlay' ? '图内，点击切换为图外' : '图外，点击切换为图内'}`} onClick={() => setTitlePosition('favorite', titlePosition === 'overlay' ? 'below' : 'overlay')}>标题{titlePosition === 'overlay' ? '在图内' : '在图外'}</button>
                    <DisplayPinToggle pinned={pinned('title')} label="标题位置" onToggle={() => togglePin('title')} />
                  </div>
                  <div className="display-option-row display-option-row-wide">
                    <PosterSizeControl value={cardW} min={FAVORITE_CARD_WIDTH_MIN} max={FAVORITE_CARD_WIDTH_MAX} step={FAVORITE_CARD_WIDTH_STEP} onChange={setCardWidth} className="w-full" />
                    <DisplayPinToggle pinned={pinned('posterSize')} label="海报大小" onToggle={() => togglePin('posterSize')} />
                  </div>
                </div>
              </section>
            </ToolbarPopover>
            <button ref={manageRef} type="button" className="toolbar-trigger px-3 text-xs" aria-haspopup="dialog" aria-expanded={manageOpen} onClick={() => setManageOpen(value => !value)}>管理</button>
            <ToolbarPopover open={manageOpen} anchorRef={manageRef} onClose={closeManage} label="心愿单管理">
              <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">管理</h2><button type="button" className="toolbar-trigger px-2 text-xs" onClick={closeManage}>关闭 ×</button></div>
              <button type="button" className="toolbar-trigger px-2 text-xs" disabled={refreshingLibraryMatches || loading || favs.length === 0} onClick={() => void refreshLibraryMatches()}>{refreshingLibraryMatches ? '正在判断媒体库…' : '重新判断媒体库'}</button>
            </ToolbarPopover>
          </div>
        </div>

        {/* 单一搜索区：输入实时过滤本地标题，提交后远程搜索；远程结果浮在内容上方。 */}
        <div className="favorites-search ui-panel relative z-30 shrink-0 overflow-visible rounded-2xl border border-white/10 bg-[#111722]/88 p-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="desktop-search-shell min-w-0 flex-1">
              <span className="sr-only">搜索心愿单</span>
              <SearchIcon width={14} height={14} className="desktop-search-icon" />
              <input
                className="search-field desktop-search-control w-full pl-9 text-sm placeholder:text-text-secondary/60"
                placeholder="搜索心愿单"
                value={query}
                onChange={event => {
                  searchRequestRef.current += 1
                  setQuery(event.target.value)
                  setResults([])
                  setSearchErr('')
                  setSearching(false)
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); void doSearch() }
                  if (event.key === 'Escape') { event.preventDefault(); clearSearch() }
                }}
              />
            </label>
            <div className="favorites-search-actions flex min-w-0 flex-wrap gap-2 sm:shrink-0 sm:flex-nowrap">
              <WishlistSourceSelect value={src} open={sourceMenuOpen} onOpenChange={setSourceMenuOpen} onChange={changeSearchSource} />
              <button type="button" className="desktop-search-button shrink-0 bg-accent text-sm text-white transition hover:bg-accent/85 disabled:opacity-50" onClick={() => void doSearch()} disabled={searching || !query.trim()}>
                {searching ? '搜索中…' : '搜索资料'}
              </button>
              {(results.length > 0 || searchErr) && (
                <button type="button" className="desktop-search-button shrink-0 text-sm text-text-secondary transition hover:text-text-primary" title="收起搜索结果" onClick={() => { setResults([]); setSearchErr('') }}>
                  收起
                </button>
              )}
            </div>
          </div>
          <div className="favorites-search-feedback mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-text-secondary/75">
            <span>{query.trim() ? `本地标题匹配 ${visibleFavs.length} / ${favs.length}` : `心愿单共 ${favs.length} 条`}</span>
          </div>

          <OverlayPresence open={searching || Boolean(searchErr) || results.length > 0} kind="menu">
            {(searching || searchErr || results.length > 0) && <div className="favorites-search-results absolute left-0 right-0 top-full z-50 mt-2 max-h-[min(24rem,55vh)] overflow-y-auto rounded-xl border border-border p-2 shadow-[0_12px_30px_rgba(0,0,0,0.2)]">
              {searching && <p role="status" aria-live="polite" className="px-2 py-2 text-xs text-text-secondary">正在搜索资料…</p>}
              {searchErr && <p role="alert" className="px-2 py-2 text-xs text-red-300">搜索失败：{searchErr}</p>}
              {results.length > 0 && (
                <div className="space-y-1.5">
                  {results.map(c => {
                    const resultSource = metadataCandidateSource(c)
                    const itemId = favoriteItemIdForCandidate(c, resultSource)
                    const added = isFavoriteCandidateAdded(favs, c, resultSource)
                    const isBgm = resultSource === 'bangumi'
                    const primaryTitle = isBgm && 'bgmId' in c && c.titleZh ? c.titleZh : c.title
                    const secondaryTitle = isBgm
                      ? ('bgmId' in c && c.titleZh && c.title !== c.titleZh ? c.title : '')
                      : ('originalTitle' in c && c.originalTitle && c.originalTitle !== c.title ? c.originalTitle : '')
                    const img = c.posterUrl && /^https?:\/\//.test(c.posterUrl) ? `/api/metadata/image?u=${encodeURIComponent(c.posterUrl)}` : c.posterUrl
                    return (
                      <button key={itemId} type="button" onClick={() => void addFromSearch(c)}
                        disabled={added || Boolean(addingId)}
                        aria-label={added ? `${primaryTitle}，已在心愿单中` : `加入心愿单：${primaryTitle}`}
                        aria-busy={addingId === itemId}
                        className={`flex w-full items-center gap-2 rounded-lg border border-border bg-bg p-1.5 text-left disabled:cursor-default disabled:opacity-65 focus-visible:border-accent ${added ? '' : 'cursor-pointer transition-colors hover:border-accent/50 hover:bg-surface-hover'}`}
                        title={added ? '已在心愿单中' : '点击整行加入'}>
                        {img ? <img src={img} alt="" loading="lazy" className="h-11 w-8 shrink-0 rounded object-cover" onError={event => { (event.target as HTMLImageElement).style.display = 'none' }} /> : <div className="h-11 w-8 shrink-0 rounded bg-surface-hover" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">{primaryTitle}</div>
                          <div className="truncate text-[10px] text-text-secondary">
                            {secondaryTitle ? `${secondaryTitle} · ` : ''}{c.year ?? ''}{c.rating != null ? ` · ★ ${c.rating}` : ''}
                          </div>
                        </div>
                        <span className={`shrink-0 rounded-lg px-2 py-1 text-xs ${added ? 'text-text-secondary opacity-50' : 'text-accent'}`}>
                          {added ? '已加入' : addingId === itemId ? '加入中…' : '＋ 加入'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>}
          </OverlayPresence>
        </div>

        {/* 收藏区：按状态分组纵向滚动，组内使用响应式海报网格 */}
        <div className="favorites-content flex-1 min-h-0 overflow-y-auto rounded-xl pr-1 flex flex-col gap-6">
          {loading && favs.length === 0 ? (
            <div role="status" aria-busy="true" className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center text-text-secondary">
              <div className="grid w-full max-w-3xl grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => <div key={index} className="aspect-[2/3] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.04]" />)}
              </div>
              <span className="text-sm">正在加载心愿单…</span>
            </div>
          ) : loadError && favs.length === 0 ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center py-12 text-center text-text-secondary">
              <div className="mb-3 text-4xl">⚠️</div>
              <p className="font-medium text-text-primary">心愿单加载失败</p>
              <p className="mt-1 max-w-md text-sm">{loadError}</p>
              <button type="button" className="mt-4 rounded-lg border border-accent/40 px-3 py-1.5 text-sm text-accent transition hover:bg-accent/10" onClick={() => void load()}>重试</button>
            </div>
          ) : favs.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center py-12 text-text-secondary">
              <div className="text-4xl mb-3">⭐</div>
              <p className="font-medium text-text-primary">心愿单还是空的</p>
              <p className="text-sm mt-1">可以在上方搜索，或在追番时间表中收藏条目</p>
            </div>
          ) : visibleFavs.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-text-secondary">
              <div className="mb-3 text-4xl">🔎</div>
              <p className="font-medium text-text-primary">没有匹配的心愿单条目</p>
              <p className="mt-1 text-sm">可以清空搜索词，或尝试其他标题关键词</p>
            </div>
          ) : (
            <>
              {loading && <div role="status" aria-live="polite" className="text-xs text-text-secondary">正在同步心愿单…</div>}
              {loadError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-300/20 bg-red-950/20 px-3 py-2 text-xs text-red-200"><span>同步失败：{loadError}</span><button type="button" className="shrink-0 underline underline-offset-2" onClick={() => void load()}>重试</button></div>}
              {favoriteView === 'overview' ? <FavoriteOverview favorites={visibleFavs} downloadEnabled={downloadEnabled} onEdit={openEditor} onReload={load} onSaved={updateOverviewLibraryStatus} sortState={favoriteSort} onToggleSort={toggleFavoriteSort} /> : FAVORITE_GROUPS.map(g => {
                const list = groups[g]
                if (list.length === 0) return null
                const meta = FAVORITE_GROUP_META[g]
                return (
                  <section key={g} className="favorites-group ui-panel shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-[#111722]/80 shadow-[0_14px_36px_rgba(0,0,0,0.16)] backdrop-blur-lg">
                    <div className="favorites-group-heading flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
                      <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                        <span>{meta.icon}</span>
                        {meta.label}
                      </h2>
                      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-text-secondary tabular-nums">{list.length}</span>
                    </div>
                    <div className="favorites-poster-grid grid gap-4 p-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${cardW}px, 100%), 1fr))` }}>
                      {list.map(f => <EnhancedFavCard key={f.item_id} f={f} cardW={cardW} fontScale={fontScale} synopsisAlpha={synopsisAlpha} animDur={animDur} onEdit={openEditor} downloadEnabled={downloadEnabled} />)}
                    </div>
                  </section>
                )
              })}
            </>
          )}
        </div>
      </div>

      {/* 心愿单编辑抽屉：桌面端从右侧进入，窄屏占满视口 */}
      <OverlayPresence open={editing !== null}>
        {editing && <div
          className="fixed inset-0 z-50 bg-black/60 opacity-100 transition-opacity duration-200 ease-[var(--ease-out)] [@starting-style]:opacity-0"
          onMouseDown={event => { if (event.target === event.currentTarget) closeEditor() }}
        >
          <aside
            ref={drawerRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="favorite-editor-title"
            className="clean-drawer favorite-editor ui-panel-strong ml-auto flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-white/10 bg-surface-modal shadow-[-20px_0_70px_rgba(0,0,0,0.32)] [@starting-style]:translate-x-6 [@starting-style]:opacity-0 opacity-100 translate-x-0 transition-[opacity,transform] duration-200 ease-[var(--ease-drawer)]"
            onMouseDown={event => event.stopPropagation()}
          >
            <header className="favorite-editor-header">
              {editing.image ? <img src={editing.image} alt="当前海报" className="favorite-editor-poster" />
                : <div className="favorite-editor-poster favorite-editor-placeholder" aria-hidden="true">{(editing.title_zh || editing.title).slice(0, 1)}</div>}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-accent">编辑心愿单</p>
                <h2 id="favorite-editor-title" className="mt-1 text-base font-semibold text-text-primary">{editing.title_zh || editing.title}</h2>
                {editing.title_zh && editing.title_zh !== editing.title && <p className="favorite-editor-original">{editing.title}</p>}
              </div>
              <button ref={closeButtonRef} type="button" aria-label="关闭编辑面板" disabled={busy} className="btn-ghost favorite-editor-close" onClick={closeEditor}>关闭</button>
            </header>

            <div className="favorite-editor-body">
              {msg && <p role={msg.includes('失败') ? 'alert' : 'status'} aria-live="polite" className={`favorite-editor-message ${msg.includes('失败') ? 'is-error' : ''}`}>{msg}</p>}
              <section className="favorite-editor-section">
                <h3>媒体库状态</h3>
                <div className="favorite-editor-status" role="group" aria-label="媒体库状态">
                  {LIBRARY_STATUS_OPTIONS.map(option => (
                    <button key={option.value} type="button" disabled={busy} aria-pressed={libraryStatus === option.value} onClick={() => setLibraryStatus(option.value)}>{option.label}</button>
                  ))}
                </div>
              </section>

              <section className="favorite-editor-section">
                <h3>媒体类型</h3>
                <MediaDomainControl
                  value={editorMediaDomainValue}
                  disabled={busy}
                  labelId="favorite-media-domain"
                  onChange={value => setMediaDomainDraft(value)}
                />
              </section>

              <section className="favorite-editor-section">
                <label htmlFor="favorite-synopsis">简介</label>
                <textarea id="favorite-synopsis" className="input favorite-editor-synopsis" value={synopsisDraft} disabled={busy} onChange={event => setSynopsisDraft(event.target.value)} placeholder="输入简介" />
              </section>

              <section className="favorite-editor-section favorite-editor-tools">
                <h3>资料与海报</h3>
                <div className="favorite-editor-tool-row">
                  <label className="sr-only" htmlFor="favorite-meta-source">数据源</label>
                  <select id="favorite-meta-source" className="input" value={sourceSel} disabled={busy} onChange={event => setSourceSel(event.target.value as typeof sourceSel)}>
                    {SOURCES.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}
                  </select>
                  <button type="button" className="btn-ghost" disabled={busy} onClick={() => applyPoster()}>更新资料与海报</button>
                </div>
                <div className="favorite-editor-tool-row">
                  <label htmlFor="favorite-custom-poster-url" className="sr-only">自定义海报图片 URL</label>
                  <input id="favorite-custom-poster-url" className="input" placeholder="自定义海报 URL" value={customUrl} disabled={busy} onChange={event => setCustomUrl(event.target.value)} />
                  <button type="button" className="btn-ghost" disabled={busy || !customUrl.trim()} onClick={() => applyPoster(customUrl.trim())}>应用海报</button>
                </div>
                {(editing.links?.length ?? 0) > 0 && <div className="favorite-editor-links" aria-label="相关链接">
                  {editing.links?.map(link => <a key={`${link.name}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">{link.name} ↗</a>)}
                </div>}
              </section>
            </div>

            <footer className="favorite-editor-footer">
              <div className="favorite-editor-actions">
                {downloadEnabled && <button type="button" className="btn-ghost favorite-editor-find" disabled={busy} onClick={findEditingResources}>找资源</button>}
                <button type="button" className="btn-ghost favorite-editor-delete" disabled={busy} onClick={() => void removeFavorite()}>{deleting ? '删除中…' : '删除心愿单'}</button>
              </div>
              <div className="favorite-editor-actions">
                <button type="button" className="btn-ghost" disabled={busy} onClick={closeEditor}>取消</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={saveChanges}>{busy && !deleting ? '处理中…' : '保存更改'}</button>
              </div>
            </footer>
          </aside>
        </div>}
      </OverlayPresence>
    </>
  )
}
