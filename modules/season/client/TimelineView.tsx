import { useMemo } from 'react'
import type { SeasonAnime } from '@/types'
import AnimeCard from './AnimeCard'

// 单日时间轴：左侧小时刻度（只显示有条目的时段，保留 00:00 起止的连续感），右侧按时间横排条目
export default function TimelineView({ items, onToggle }: { items: SeasonAnime[]; onToggle: (a: SeasonAnime) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, SeasonAnime[]>()
    for (const a of items) {
      const h = a.airTime?.slice(0, 2) ?? '--'
      if (!map.has(h)) map.set(h, [])
      map.get(h)!.push(a)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [items])

  return (
    <div>
      {groups.map(([hour, list], idx) => (
        <div key={hour} className="season-time-group grid grid-cols-[56px_1fr] gap-3">
          <div className="season-time text-right text-xs text-text-secondary tabular-nums pt-3 select-none leading-none">{hour}:00</div>
          <div className={`flex flex-wrap gap-2.5 pb-3 ${idx < groups.length - 1 ? 'border-b border-border/40' : ''}`}>
            {list.map(a => <AnimeCard key={a.id} a={a} onToggle={onToggle} wide />)}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="text-sm text-text-secondary py-8 text-center">这一天暂时没有新番</p>}
    </div>
  )
}
