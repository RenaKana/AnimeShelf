import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SeasonAnime, SeasonCalendarData } from '@/types'
import { api } from './api'
import AnimeCard from './AnimeCard'
import TimelineView from './TimelineView'
import { DAY_LABELS, DAY_ORDER, JS_DAY_TO_KEY } from './constants'
import { parseMediaDomainEvidence } from '../../../shared/media-domain'
import { SearchIcon } from '@/components/ui/Icons'

const SEASON_CN: Record<string, string> = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' }

// 某星期几对应的日期（本周范围），用于 Tab 标题「周一 · 8月3日」
function dateOfDay(dayKey: string): string {
  const today = new Date()
  const todayKey = JS_DAY_TO_KEY[today.getDay()]
  const offset = (DAY_ORDER.indexOf(dayKey) - DAY_ORDER.indexOf(todayKey) + 7) % 7
  const d = new Date(today)
  d.setDate(today.getDate() + offset)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function SeasonCalendar() {
  const todayKey = JS_DAY_TO_KEY[new Date().getDay()]
  const [data, setData] = useState<SeasonCalendarData | null>(null)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<string>(() =>
    window.matchMedia('(min-width: 1536px)').matches ? 'ALL' : todayKey)
  const [q, setQ] = useState('')
  // 乐观收藏状态：本地 Set 优先，失败回滚
  const [favIds, setFavIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setError('')
    try {
      const c = await api.season.calendar()
      setData(c)
      setFavIds(new Set(c.favorites))
    } catch (e: any) {
      setError(e.message ?? String(e))
    }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1536px)')
    const keepUsableOnNarrowScreens = (event: MediaQueryListEvent | MediaQueryList) => {
      if (!event.matches) setActiveTab(current => current === 'ALL' ? todayKey : current)
    }
    keepUsableOnNarrowScreens(wide)
    wide.addEventListener('change', keepUsableOnNarrowScreens)
    return () => wide.removeEventListener('change', keepUsableOnNarrowScreens)
  }, [todayKey])

  const isFav = (id: string) => favIds.has(id)

  const toggle = async (a: SeasonAnime) => {
    const willFav = !isFav(a.id)
    // 乐观更新
    setFavIds(prev => { const s = new Set(prev); if (willFav) s.add(a.id); else s.delete(a.id); return s })
    try {
      if (willFav) await api.season.favorite({ item_id: a.id, title: a.title, title_zh: a.titleZh, air_day: a.airDay, air_time: a.airTime, begin: a.begin, bangumi_id: a.links.find(l => l.name === '番组计划')?.url.split('/').pop() ?? null, links: a.links, media_domain_evidence: parseMediaDomainEvidence(a.media_domain_evidence) })
      else await api.season.unfavorite(a.id)
      await load()
    } catch (e: any) {
      setFavIds(prev => { const s = new Set(prev); if (willFav) s.delete(a.id); else s.add(a.id); return s }) // 回滚
      alert(`操作失败：${e.message}`)
    }
  }

  // 视图数据：ALL = 全部星期网格；单日 = 时间轴；FAV = 收藏视图（走 favs 快照）
  const visible = useMemo(() => {
    if (!data) return null
    const query = q.trim().toLowerCase()
    const result: Record<string, SeasonAnime[]> = {}
    for (const k of DAY_ORDER) {
      result[k] = (data.days[k] ?? []).filter(a =>
        (!query || a.title.toLowerCase().includes(query) || (a.titleZh ?? '').toLowerCase().includes(query)))
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, favIds])

  if (error) {
    return (
      <div className="clean-state p-6 text-text-secondary">
        <p>加载失败：{error}</p>
        <button className="mt-3 bg-accent text-white rounded-lg px-4 py-2 text-sm" onClick={load}>重试</button>
      </div>
    )
  }
  if (!data || !visible) {
    return (
      <div className="season-skeleton p-6 space-y-4" aria-busy="true" aria-label="加载追番时间表">
        <div className="h-8 w-48 bg-surface-hover animate-pulse rounded-lg" />
        <div className="h-9 bg-surface-hover animate-pulse rounded-lg w-full max-w-xl" />
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-28 bg-surface-hover animate-pulse rounded-lg" />)}
        </div>
      </div>
    )
  }
  if (!data || !visible) return null

  const total = DAY_ORDER.reduce((n, k) => n + (data.days[k]?.length ?? 0), 0)
  const inDayTab = activeTab !== 'ALL'
  const dayItems = inDayTab ? (visible[activeTab] ?? []).map(a => ({ ...a, favorited: isFav(a.id) })) : []

  return (
    <div className="season-page clean-page page-shell">
      <div className="space-y-3 shrink-0">
        <div className="clean-page-header page-header ui-panel flex items-start justify-between gap-4 flex-wrap rounded-2xl border border-white/10 bg-[#111722]/88 px-4 py-3 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
          <div>
            <h1 className="page-title">追番</h1>
            <p className="page-subtitle">
              {`${data.year} 年 ${SEASON_CN[data.season] ?? data.season} 季新番 · 共 ${total} 部${inDayTab ? ` · ${DAY_LABELS[activeTab]} ${dateOfDay(activeTab)}` : ''}`}
            </p>
          </div>
          <label className="desktop-search-shell w-56 max-w-full">
            <SearchIcon width={14} height={14} className="desktop-search-icon" />
            <input
              aria-label="搜索追番标题"
              className="desktop-search-control w-full pl-8 text-sm placeholder:text-text-secondary/60"
              placeholder="搜索标题…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          </label>
        </div>
        {/* 窄窗口默认单日时间轴；仅在 2xl 宽屏开放七列总览。 */}
        <div className="clean-tabs season-days flex gap-1.5 overflow-x-auto no-scrollbar pb-1" role="tablist" aria-label="按星期筛选"
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(tab => tab.getClientRects().length > 0)
            const current = tabs.indexOf(event.target as HTMLButtonElement)
            if (current < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            tabs[next]?.focus(); tabs[next]?.click()
          }}>
          {(['ALL', ...DAY_ORDER] as string[]).map(day => {
            const isToday = day === todayKey
            const active = activeTab === day
            const count = day === 'ALL' ? total : (data.days[day]?.length ?? 0)
            const label = isToday ? '今天' : DAY_LABELS[day]
            return (
              <button key={day} role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
                className={`${day === 'ALL' ? 'hidden 2xl:inline-flex' : 'inline-flex'} shrink-0 px-3 py-1.5 rounded-lg text-sm border transition-colors ${active ? 'bg-accent text-white border-transparent' : 'bg-surface text-text-secondary border-border hover:text-text-primary'}`}
                onClick={() => setActiveTab(day)}>
                {label}<span className="opacity-60 ml-1">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {inDayTab ? (
        <div className="flex-1 min-h-0 overflow-y-auto rounded-xl pr-1 w-full max-w-[1700px] mx-auto">
          <TimelineView items={dayItems} onToggle={toggle} />
        </div>
      ) : (
        <div className="season-week-grid flex-1 min-h-0 w-full max-w-[1700px] mx-auto grid gap-3" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridTemplateRows: 'minmax(0, 1fr)' }}>
          {/* 固定 7 列：任何窗口宽度下周一~周日始终一行均分 */}
          {DAY_ORDER.map(day => {
            const list = visible[day]
            return (
              <section key={day} className="season-day-column ui-panel-subtle bg-bg/40 border border-border rounded-lg p-3 flex flex-col min-h-0 relative">
                <h2 className="font-semibold text-sm mb-2 flex items-center justify-between shrink-0">
                  <span>{DAY_LABELS[day]}{day === todayKey && <span className="text-accent text-xs ml-1">（今天）</span>}</span>
                  <span className="text-xs text-text-secondary tabular-nums">{list.length}</span>
                </h2>
                {/* 每列独立滚动：鼠标在该列上滚动只滚动该列；grid 使同列卡片等高 */}
                <div className="grid gap-2 overflow-y-auto pr-0.5 flex-1 min-h-0 content-start">
                  {list.map(a => <AnimeCard key={a.id} a={{ ...a, favorited: isFav(a.id) }} onToggle={toggle} />)}
                  {list.length === 0 && <p className="text-xs text-text-secondary/60">—</p>}
                </div>
                {/* 底部渐隐：仅当该列内容可滚动时显示（内容超出才出现淡出提示） */}
                {list.length > 0 && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-lg bg-gradient-to-t from-bg/80 to-transparent" />}
              </section>
            )
          })}
          {total > 0 && DAY_ORDER.every(k => visible[k].length === 0) && (
            <p className="text-sm text-text-secondary col-span-full">没有符合条件的条目，试试调整搜索词或筛选</p>
          )}
        </div>
      )}
    </div>
  )
}
