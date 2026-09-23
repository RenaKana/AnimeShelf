import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ModuleFolderProps } from '../../../src/modules/contracts'
import Button from '../../../src/components/ui/Button'
import SelectMenu from '../../../src/components/ui/SelectMenu'
import { RefreshIcon, SearchIcon, TrashIcon } from '../../../src/components/ui/Icons'
import { useDialogBehavior } from '../../../src/components/ui/dialogBehavior'
import MetadataPicker from './MetadataPicker'
import { automaticDisplayMetadataNotice, displayMetadataOptions, selectedDisplayMetadataValue } from './displayMetadata'
import { metadataApi } from './api'
import { candidateDomainEvidence, evidenceMediaDomain } from '../../../shared/media-domain'

export default function MetadataFolderPanel({ folder, onRefresh, onNotice }: ModuleFolderProps) {
  const [searchParams] = useSearchParams()
  const [open, setOpen] = useState(() => searchParams.get('metadata') === 'match')
  const [refreshing, setRefreshing] = useState(false)
  const [displayBusy, setDisplayBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useDialogBehavior({ open, dialogRef, initialFocusRef: closeRef, onClose: () => setOpen(false) })

  const targetId = folder.effective_metadata_folder_id ?? folder.id
  const candidates = folder.display_metadata_candidates ?? []
  const hasMetadata = Boolean(folder.source || folder.anilist_id || folder.synopsis || folder.has_poster)
  const choices = displayMetadataOptions(candidates, folder.effective_metadata_folder_name, hasMetadata)
  const selected = selectedDisplayMetadataValue(folder.display_metadata_folder_id)
  const listHeight = Math.max(180, Math.min(460, window.innerHeight - 250))

  return <>
    <section className="clean-section metadata-panel ui-panel rounded-xl border border-white/[0.08] bg-[#111722]/86 p-3 shadow-[0_12px_30px_rgba(0,0,0,0.14)] backdrop-blur-lg">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><div className="text-xs font-medium text-text-primary">海报与元数据</div><div className="mt-0.5 text-[10px] text-text-secondary/65">更换匹配或刷新当前资料</div></div>
        <span className={`h-2 w-2 rounded-full ${hasMetadata ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]' : 'bg-white/20'}`} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button className="col-span-2 w-full" size="sm" variant="secondary" icon={<SearchIcon width={14} height={14} />} onClick={() => setOpen(true)}>{hasMetadata ? '重新匹配' : '匹配元数据'}</Button>
        {hasMetadata && <Button className="w-full" size="sm" variant="ghost" icon={<RefreshIcon width={14} height={14} />} disabled={refreshing} onClick={async () => {
          setRefreshing(true)
          try { await metadataApi.refreshFolder(targetId); onNotice('元数据已刷新'); await onRefresh() }
          catch (error) { alert(`刷新失败：${error instanceof Error ? error.message : String(error)}`) }
          finally { setRefreshing(false) }
        }}>{refreshing ? '刷新中…' : '刷新'}</Button>}
        {hasMetadata && <Button className="w-full" size="sm" variant="danger" icon={<TrashIcon width={14} height={14} />} onClick={async () => {
          if (!confirm('确定清除整部番剧的元数据（全部季的评分/简介/海报/绑定）？目录结构与标签不受影响。')) return
          try { await metadataApi.clearFolder(folder.id); onNotice('元数据已清除'); await onRefresh() }
          catch (error) { alert(error instanceof Error ? error.message : String(error)) }
        }}>清除</Button>}
      </div>
      {candidates.length > 1 && <div className="mt-3 border-t border-white/[0.07] pt-3">
        <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-medium text-text-secondary">外层展示资料</span>{displayBusy && <span className="text-[10px] text-accent">切换中…</span>}</div>
        <SelectMenu value={selected} options={choices} ariaLabel="选择外层展示资料来源" minWidthClass="min-w-0" className="w-full" menuPosition="fixed" menuWidth="trigger" wrapOptions onChange={async value => {
          if (displayBusy) return
          setDisplayBusy(true)
          try {
            const updated = await metadataApi.setDisplayFolder(folder.id, value === 'auto' ? null : Number(value))
            onNotice(value === 'auto' ? automaticDisplayMetadataNotice(Boolean(updated.anilist_id || updated.source)) : '外层海报与简介来源已更新')
            await onRefresh()
          } catch (error) { alert(`切换失败：${error instanceof Error ? error.message : String(error)}`) }
          finally { setDisplayBusy(false) }
        }} />
        <p className="mt-2 text-[10px] leading-4 text-text-secondary/55">SP、特典等附加目录不会被自动选中，但仍可手动指定。</p>
      </div>}
    </section>

    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 transition-opacity duration-200 [@starting-style]:opacity-0" onClick={() => setOpen(false)}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="匹配元数据" tabIndex={-1} className="clean-dialog ui-panel-strong flex w-full max-w-2xl flex-col overflow-hidden overscroll-contain rounded-2xl border border-white/10 bg-[#0d121b]/98 p-4 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl transition-[opacity,transform] duration-200 ease-[var(--ease-out)] [@starting-style]:scale-[0.97] [@starting-style]:opacity-0" onClick={event => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-4"><div><div className="section-kicker">METADATA MATCH</div><h2 className="mt-1 font-semibold text-white">为“{folder.name}”匹配元数据</h2></div><button ref={closeRef} type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl text-text-secondary transition hover:bg-white/[0.06] hover:text-white" aria-label="关闭元数据匹配" onClick={() => setOpen(false)}>×</button></div>
        <MetadataPicker folderId={targetId} initialQuery={folder.name} initialSource={folder.media_domain === 'live_action' ? 'tmdb' : 'bangumi'} listHeight={listHeight} onPick={async (source, candidate) => {
          await metadataApi.bind(targetId, source, candidate)
          setOpen(false)
          const evidence = candidateDomainEvidence(source, candidate)[0]
          const differs = folder.media_domain_override != null && evidence && evidenceMediaDomain(evidence) !== folder.media_domain_override
          onNotice(differs ? '元数据已应用；类型与人工指定不同，已保留人工分类' : '元数据已应用，海报与详情已更新')
          await onRefresh()
        }} />
      </div>
    </div>}
  </>
}
