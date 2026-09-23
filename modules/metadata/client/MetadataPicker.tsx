import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MetadataCandidate } from '../../../src/types'
import { metadataApi } from './api'

const SOURCES = [
  { key: 'bangumi', label: 'Bangumi（中文）' },
  { key: 'anilist', label: 'AniList' },
  { key: 'tmdb', label: 'TMDB' },
] as const
type SourceKey = typeof SOURCES[number]['key']

// 候选展示名：Bangumi 优先中文译名；TMDB 中文优先
function displayTitle(c: MetadataCandidate): string {
  if ('titleZh' in c && c.titleZh) return c.titleZh
  return c.title
}
function subTitle(c: MetadataCandidate): string {
  const parts: string[] = []
  if ('year' in c && c.year) parts.push(String(c.year))
  if ('rating' in c && typeof c.rating === 'number' && c.rating > 0) parts.push(`★ ${c.rating.toFixed(1)}`)
  if ('episodes' in c && c.episodes) parts.push(`${c.episodes} 集`)
  if ('seasons' in c && c.seasons) parts.push(`${c.seasons} 季`)
  if ('originalTitle' in c && c.originalTitle) parts.push(c.originalTitle)
  return parts.join(' · ')
}

function proxiedPoster(raw: string | null | undefined): string | null {
  if (!raw) return null
  return /^https?:\/\//.test(raw) ? `/api/metadata/image?u=${encodeURIComponent(raw)}` : raw
}

function CandidatePoster({ raw, large = false }: { raw: string | null | undefined; large?: boolean }) {
  const src = proxiedPoster(raw)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const box = large ? 'h-40 w-full' : 'h-14 w-10 shrink-0 rounded'
  return (
    <div className={`relative overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgb(var(--ui-accent)/0.22),transparent_45%),linear-gradient(145deg,#202838,#111722)] ${box}`}>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/35">
        {failed ? '暂无海报' : <span className="h-4 w-4 animate-pulse rounded-full border border-white/20 bg-white/10" />}
      </div>
      {src && !failed && (
        <img src={src} alt="" loading={large ? 'eager' : 'lazy'} className="absolute inset-0 h-full w-full object-cover object-top" onError={() => setFailed(true)} />
      )}
    </div>
  )
}

export default function MetadataPicker({ onPick, initialQuery = '', listHeight, folderId, initialSource = 'bangumi' }: {
  onPick: (source: string, c: MetadataCandidate) => Promise<void>
  initialQuery?: string
  listHeight?: number // 浮层模式：JS 精确计算的结果列表高度（不依赖 flex 分配）
  folderId?: number
  initialSource?: SourceKey
}) {
  const [q, setQ] = useState(initialQuery)
  const [source, setSource] = useState<SourceKey>(initialSource)
  const [cands, setCands] = useState<MetadataCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [hover, setHover] = useState<MetadataCandidate | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)
  const autoStarted = useRef(false)
  const [overlayPos, setOverlayPos] = useState({ left: 0, top: 0, maxH: 384 })
  const showHover = (c: MetadataCandidate) => {
    setHover(c)
    // 浮层靠着详情右缘；高度自适应视口（不被任务栏截断）
    const r = rootRef.current?.getBoundingClientRect()
    if (r) {
      const top = Math.max(8, r.top)
      const maxH = Math.max(160, Math.min(384, window.innerHeight - top - 16))
      setOverlayPos({ left: Math.max(8, r.right + 8), top, maxH })
    }
  }

  const search = async (src: SourceKey = source, query = q) => {
    const value = query.trim()
    if (!value) return
    const seq = ++requestSeq.current
    setLoading(true); setSearched(false); setErr('')
    try {
      const result = await metadataApi.search(value, src, folderId)
      if (seq === requestSeq.current) setCands(result)
    } catch (e: any) {
      if (seq === requestSeq.current) {
        setCands([])
        setErr(e.message)
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
        setSearched(true)
      }
    }
  }

  // 打开弹窗即开始搜索，省去用户看到空面板后再点一次按钮的等待。
  useEffect(() => {
    if (autoStarted.current || !initialQuery.trim()) return
    autoStarted.current = true
    void search(initialSource, initialQuery)
  }, [])

  // hover 详情浮层：createPortal 到 body——脱离搜索浮层的 backdrop-filter 包含块与 overflow 裁剪；进入轻 scale+fade（150ms，tooltip 配方）
  const overlay = hover ? createPortal(
    <div className="clean-menu ui-panel-strong fixed z-50 w-64 bg-surface-modal border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden [@starting-style]:opacity-0 [@starting-style]:scale-[0.97] opacity-100 scale-100 transition-[opacity,transform] duration-150 ease-[var(--ease-out)]"
      style={{ left: overlayPos.left, top: overlayPos.top, height: overlayPos.maxH, transformOrigin: 'top center' }}
      onMouseLeave={() => setHover(null)}>
      {(() => {
        const c = hover
        const rawImg = 'posterUrl' in c ? c.posterUrl : null
        const bgmType = 'bgmId' in c && c.type != null ? ({ 2: '动画', 6: '真人', 1: '书籍', 3: '音乐', 4: '游戏' } as Record<number, string>)[c.type] : null
        return (
          <>
            <CandidatePoster raw={rawImg} large />
            <div className="p-3 flex flex-col min-h-0 flex-1">
              <div className="font-medium text-sm leading-snug">{displayTitle(c)}
                {bgmType && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-surface-hover border border-border text-text-secondary align-middle">{bgmType}</span>}
              </div>
              <div className="text-xs text-text-secondary mt-0.5">{subTitle(c)}</div>
              <div className="text-[10px] text-text-secondary/70 mt-0.5 truncate">
                {'originalTitle' in c && c.originalTitle ? `原名：${c.originalTitle}` : '来源：' + ({ anilist: 'AniList', bangumi: 'Bangumi', tmdb: 'TMDB' } as Record<string, string>)[source]}
              </div>
              <div className="mt-2 text-xs text-text-secondary leading-relaxed overflow-y-auto no-scrollbar pr-1 min-h-0 flex-1">
                {'synopsis' in c && c.synopsis ? c.synopsis : '暂无简介'}
              </div>
            </div>
          </>
        )
      })()}
    </div>,
    document.body,
  ) : null

  // 结果列表滚动：JS 手动接管 + 惯性（preventDefault 原生滚动，速度累积 + rAF 衰减）——
  // 不受原生滚动链/嵌套滚动影响，内容超高必然可滚，搜索框永远不会被带动
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    let vel = 0
    let raf = 0
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight + 4) return // 内容不超高：放行
      e.preventDefault()
      vel = Math.max(-80, Math.min(80, vel + e.deltaY)) // 累积速度（限幅）
      if (!raf) {
        const step = () => {
          el.scrollTop += vel * 0.15 // 每帧按 15% 速度位移：单格滚轮 ≈ 原生速度（~100px）
          vel *= 0.85 // 摩擦衰减
          if (Math.abs(vel) < 0.5) { vel = 0; raf = 0 }
          else raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); if (raf) cancelAnimationFrame(raf) }
  }, [cands.length, listHeight])

  const pick = async (c: MetadataCandidate, key: string) => {
    setApplyingKey(key)
    setErr('')
    try { await onPick(source, c) } catch (e: any) { setErr(`绑定失败：${e.message}`) } finally { setApplyingKey(null) }
  }

  const busy = applyingKey !== null

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 relative" ref={rootRef} onWheel={e => e.stopPropagation()}>
      <div className="flex gap-2">
        <input className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm flex-1" placeholder="搜索标题…" value={q} onChange={e => { setQ(e.target.value); setSearched(false) }} onKeyDown={e => e.key === 'Enter' && search()} disabled={busy} />
        <button className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm" onClick={() => search()} disabled={loading || busy}>{loading ? '搜索中…' : '搜索'}</button>
      </div>
      <div className="flex gap-1.5">
        {SOURCES.map(s => (
          <button key={s.key} disabled={busy}
            className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${source === s.key ? 'bg-accent text-white border-transparent' : 'bg-surface text-text-secondary border-border hover:text-text-primary'}`}
            onClick={() => { setSource(s.key); if (cands.length > 0 || q) search(s.key) }}>
            {s.label}
          </button>
        ))}
      </div>
      {applyingKey && <p role="status" className="rounded-lg border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-accent">正在下载海报并应用元数据，请稍候…</p>}
      {err && <p role="alert" className="rounded-lg border border-red-400/15 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</p>}
      <div ref={listRef} className="overflow-y-auto overscroll-contain relative space-y-2"
        style={listHeight ? { height: listHeight } : {}}>
        {loading && cands.length === 0 && (
          <div className="space-y-2" aria-label="正在搜索元数据">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[72px] animate-pulse rounded-lg border border-white/[0.05] bg-white/[0.035]" />)}
          </div>
        )}
        {cands.length === 0 && !loading && searched && q && <p className="text-sm text-text-secondary">没有找到匹配结果</p>}
        {cands.map(c => {
          const id = 'anilistId' in c ? c.anilistId : 'bgmId' in c ? c.bgmId : c.tmdbId
          const rawImg = 'posterUrl' in c ? c.posterUrl : null
          const key = `${source}-${id}`
          const applying = applyingKey === key
          // Bangumi 类型角标：2=动画 6=真人 1=书籍 3=音乐 4=游戏
          const bgmType = 'bgmId' in c && c.type != null ? ({ 2: '动画', 6: '真人', 1: '书籍', 3: '音乐', 4: '游戏' } as Record<number, string>)[c.type] : null
          return (
            <button key={key} className={`w-full flex items-center gap-3 border rounded-lg p-2 text-left transition-[background-color,border-color,opacity] ${applying ? 'border-accent/60 bg-accent/10' : 'bg-surface border-border hover:bg-surface-hover'}`} onClick={() => pick(c, key)} disabled={busy} aria-busy={applying}
              onMouseEnter={() => showHover(c)}>
              <CandidatePoster raw={rawImg} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">
                  {displayTitle(c)}
                  {bgmType && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-surface-hover border border-border text-text-secondary align-middle">{bgmType}</span>}
                </div>
                <div className="text-xs text-text-secondary truncate">{subTitle(c)}</div>
                {'synopsis' in c && c.synopsis && <div className="text-xs text-text-secondary/80 truncate mt-0.5">{c.synopsis}</div>}
              </div>
              <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${applying ? 'bg-accent text-white' : 'bg-white/[0.055] text-text-secondary'}`}>{applying ? '应用中…' : '应用'}</span>
            </button>
          )
        })}
      </div>

      {/* hover 详情浮层（portal 到 body）：靠着详情右缘，鼠标可移入框内滚动查看完整简介 */}
      {overlay}
    </div>
  )
}
