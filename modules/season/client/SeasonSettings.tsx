import { useState } from 'react'
import { readNumberPref, UI_PREF_KEYS, writePref } from '@/lib/uiPreferences'
import { setTitlePosition, useTitlePosition, usePresentationError } from '@/lib/presentationPreferences'
import { EnhancedFavCard } from './FavoritesView'
import type { SeasonFavorite } from '@/types'

const sample: SeasonFavorite = {
  item_id: 'display-preview', title: 'Sample Series', title_zh: '示例番剧：旅途与未寄出的信',
  air_day: 'MON', air_time: '20:30', begin: null, bangumi_id: null, links: [], image: null,
  synopsis: '旅途中偶然相遇的伙伴，循着一封未寄出的信，再次踏上通往故乡的列车。',
  synopsis_original: null, aired_episodes: 3, total_episodes: 12, air_status: 'airing', media_type: 'anime',
  lib_match_override: null, lib_hit: null, lib_status: 'absent', added_at: '',
}

export default function SeasonSettings() {
  const [cardWidth, setCardWidth] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteCardWidth, 260, 160, 420))
  const [fontScale, setFontScale] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteFontScale, 1, 0.7, 1.4))
  const [synopsisAlpha, setSynopsisAlpha] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteSynopsisAlpha, 0.6, 0, 0.95))
  const [animationDuration, setAnimationDuration] = useState(() => readNumberPref(UI_PREF_KEYS.favoriteAnimationDuration, 500, 100, 1500))
  const titlePosition = useTitlePosition('favorite')
  const presentationError = usePresentationError()
  const [saveError, setSaveError] = useState('')

  const update = (key: string, value: number, setter: (next: number) => void) => {
    setter(value)
    try { writePref(key, value); setSaveError('') }
    catch { setSaveError('预览已更新，但无法保存到本机。') }
  }

  return (
    <section id="settings-season-display" className="ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
      <h2 className="font-semibold">心愿单海报显示</h2>
      <button type="button" className="toolbar-trigger px-3 text-xs" aria-label={`标题位置：${titlePosition === 'overlay' ? '图内，点击切换为图外' : '图外，点击切换为图内'}`} onClick={() => setTitlePosition('favorite', titlePosition === 'overlay' ? 'below' : 'overlay')}>标题{titlePosition === 'overlay' ? '在图内' : '在图外'}</button>
      {(presentationError || saveError) && <p role="status" className="text-xs text-warning">{presentationError || saveError}</p>}
      <label className="flex items-center gap-3 text-sm"><span className="w-20 shrink-0 text-text-secondary">卡片大小</span><input type="range" min={160} max={420} step={10} value={cardWidth} onChange={event => update(UI_PREF_KEYS.favoriteCardWidth, Number(event.target.value), setCardWidth)} className="min-w-0 flex-1 accent-accent" /><span className="w-12 text-right tabular-nums">{cardWidth}px</span></label>
      <label className="flex items-center gap-3 text-sm"><span className="w-20 shrink-0 text-text-secondary">字号</span><input type="range" min={70} max={140} step={5} value={Math.round(fontScale * 100)} onChange={event => update(UI_PREF_KEYS.favoriteFontScale, Number(event.target.value) / 100, setFontScale)} className="min-w-0 flex-1 accent-accent" /><span className="w-12 text-right tabular-nums">{Math.round(fontScale * 100)}%</span></label>
      <label className="flex items-center gap-3 text-sm"><span className="w-20 shrink-0 text-text-secondary">简介遮罩</span><input type="range" min={0} max={95} step={5} value={Math.round(synopsisAlpha * 100)} onChange={event => update(UI_PREF_KEYS.favoriteSynopsisAlpha, Number(event.target.value) / 100, setSynopsisAlpha)} className="min-w-0 flex-1 accent-accent" /><span className="w-12 text-right tabular-nums">{Math.round(synopsisAlpha * 100)}%</span></label>
      <label className="flex items-center gap-3 text-sm"><span className="w-24 shrink-0 text-text-secondary">简介展开时长</span><input type="range" aria-label="简介展开时长" min={100} max={1500} step={50} value={animationDuration} onChange={event => update(UI_PREF_KEYS.favoriteAnimationDuration, Number(event.target.value), setAnimationDuration)} className="min-w-0 flex-1 accent-accent" /><span className="w-12 text-right tabular-nums">{animationDuration}ms</span></label>
      <div data-title-position={titlePosition} aria-label="心愿单海报预览" className="max-w-full pt-1" style={{ width: cardWidth }}>
        <EnhancedFavCard f={sample} cardW={cardWidth} fontScale={fontScale} synopsisAlpha={synopsisAlpha} animDur={animationDuration} onEdit={() => {}} downloadEnabled={false} />
      </div>
    </section>
  )
}
