import { useEffect, useState } from 'react'
import type { MediaCatalogWorkGroup } from '../../../../src/types'
import type { CollectionWork } from '../collectionNavigation'
import { collectionItemKey } from '../collectionNavigation'
import { api } from '../api'
import CollectionDialog from './CollectionDialog'
import CollectionClassificationForm from './CollectionClassificationForm'
import Button from '../../../../src/components/ui/Button'
import SelectMenu from '../../../../src/components/ui/SelectMenu'

export type CollectionSave = (action: () => Promise<unknown>, notice: string) => Promise<boolean>
export default function CollectionEditor({ open = true, rootId, work, groups, busy, errorMessage, onClose, onSave }: { open?: boolean; rootId: number; work: CollectionWork; groups: MediaCatalogWorkGroup[]; busy: boolean; errorMessage?: string; onClose: () => void; onSave: CollectionSave }) {
  const [title, setTitle] = useState(work.title)
  const [group, setGroup] = useState(work.group ? String(work.group.id) : '')
  const [folderId, setFolderId] = useState(String(work.folders[0]?.id ?? ''))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setTitle(work.title)
    setGroup(work.group ? String(work.group.id) : '')
    setFolderId(String(work.folders[0]?.id ?? ''))
    setError('')
  }, [open])
  const folder = work.folders.find(row => String(row.id) === folderId)
  const mapping = folder?.mappings[0]
  const save = async (action: () => Promise<unknown>, message: string) => {
    setError('')
    if (await onSave(action, message)) onClose()
    else setError('保存未完成，请查看页面提示后重试。')
  }
  return <CollectionDialog open={open} title="调整作品" busy={busy} onClose={onClose}>
    {(errorMessage || error) && <p role="alert" className="text-sm text-red-200">{errorMessage || error}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(() => api.folders.updateCollectionPresentation(rootId, [{ key: collectionItemKey(work.item), title: title.trim() }]), '显示名称已保存') }} className="space-y-2">
      <label className="block text-xs text-text-secondary">显示名称<input className="input mt-1" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required disabled={busy} /></label>
      <p className="text-xs text-text-secondary">不会重命名磁盘文件夹。</p>
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !title.trim()}>保存名称</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void save(() => api.folders.updateCollectionPresentation(rootId, [{ key: collectionItemKey(work.item), title: null }]), '已恢复默认显示名称') }}>恢复默认</Button></div>
    </form>
    <section className="space-y-2 border-t border-white/10 pt-4"><h3 className="text-xs text-text-secondary">所属分组</h3><SelectMenu value={group} onChange={setGroup} options={[{ value: '', label: '独立展示（不分组）' }, ...groups.map(row => ({ value: String(row.id), label: row.title }))]} ariaLabel="所属分组" disabled={busy} className="w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" wrapOptions /><Button size="sm" disabled={busy || group === (work.group ? String(work.group.id) : '')} onClick={() => { void save(() => api.folders.moveCollectionMember(rootId, work.item.id, group ? Number(group) : null), '分组已保存') }}>保存分组</Button></section>
    <section className="space-y-3 border-t border-white/10 pt-4"><h3 className="text-xs text-text-secondary">关联目录</h3>
      <SelectMenu value={folderId} onChange={setFolderId} options={work.folders.map(row => ({ value: String(row.id), label: row.name }))} ariaLabel="关联目录" disabled={busy} className="w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" wrapOptions />
      {folder && <><p className="break-all text-xs text-text-secondary">{folder.path}</p><CollectionClassificationForm key={folderId} initial={{ kind: mapping?.kind ?? work.item.kind ?? 'unknown', customLabel: mapping?.custom_label, seasonNumbers: [...new Set(folder.mappings.flatMap(row => row.season_number ? [row.season_number] : []))], partNumber: mapping?.part_number ?? null }} busy={busy} onSave={async body => { const ok = await onSave(() => api.folders.updateMediaCatalog(folder.id, body), '目录类型已保存'); if (ok) onClose(); else setError('目录类型保存失败，请重试。'); return ok }} />
        <details className="text-xs text-text-secondary"><summary className="cursor-pointer py-2">移出 / 恢复自动</summary><p className="mb-2">仅影响所选目录的清单记录，不删除磁盘内容。</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="danger" disabled={busy} onClick={() => { void save(() => api.folders.updateMediaCatalog(folder.id, { excluded: true }), '目录已移出作品清单') }}>移出清单</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void save(() => api.folders.updateMediaCatalog(folder.id, { clearManual: true }), '目录已恢复自动判断') }}>恢复自动</Button></div></details>
      </>}
    </section>
  </CollectionDialog>
}
