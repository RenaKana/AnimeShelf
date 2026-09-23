import type { SeasonAnime } from '@/types'

// 单部新番卡片：时间徽章 + 中文标题 + 日文原名 + 开播日期 + 收藏 + Bangumi/官网链接
export default function AnimeCard({ a, onToggle, wide = false }: { a: SeasonAnime; onToggle: (a: SeasonAnime) => void; wide?: boolean }) {
  const displayTitle = a.titleZh ?? a.title
  // 本地时区日期（begin 是 UTC ISO，slice 会跨日差一天）
  const beginDate = new Date(a.begin)
  const localDate = isNaN(beginDate.getTime()) ? '' : beginDate.toLocaleDateString('sv-SE') // YYYY-MM-DD
  return (
    <div className={`season-airing-item ui-panel-subtle bg-surface border border-border rounded-lg p-3 hover:bg-surface-hover transition-colors flex flex-col min-w-0 ${wide ? 'flex-1 min-w-[220px]' : ''}`}>
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          {/* 时间 + 开播日期同行 */}
          <div className="text-sm font-bold text-accent tabular-nums flex items-center gap-2">
            <span>{a.airTime ?? '--:--'}</span>
            <span className="text-[10px] font-normal text-text-secondary/70">{localDate}</span>
          </div>
          {/* 标题完整显示 */}
          <div className="text-sm font-medium leading-snug mt-1 break-words" title={displayTitle}>{displayTitle}</div>
          {a.titleZh && a.title && a.title !== a.titleZh && (
            <div className="text-xs text-text-secondary truncate mt-0.5" title={a.title}>{a.title}</div>
          )}
        </div>
        <button
          className={`shrink-0 text-base leading-none transition-colors duration-150 ${a.favorited ? 'text-yellow-400' : 'text-text-secondary hover:text-yellow-400'}`}
          title={a.favorited ? '取消收藏' : '收藏'}
          aria-label={a.favorited ? '取消收藏' : '收藏'}
          onClick={() => onToggle(a)}>
          {a.favorited ? '★' : '☆'}
        </button>
      </div>
      {/* 全部来源链接 */}
      <div className="pt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-text-secondary min-w-0">
        {a.links.map(l => (
          <a key={l.name} href={l.url} target="_blank" rel="noreferrer" className="hover:text-accent transition-colors shrink-0">{l.name}</a>
        ))}
      </div>
    </div>
  )
}
