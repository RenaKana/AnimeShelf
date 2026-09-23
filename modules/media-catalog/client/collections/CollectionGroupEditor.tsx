import { useEffect, useState } from 'react'
import type { MediaCatalogWorkGroup } from '../../../../src/types'
import type { CollectionGroup } from '../collectionNavigation'
import { api } from '../api'
import CollectionDialog from './CollectionDialog'
import type { CollectionSave } from './CollectionEditor'
import Button from '../../../../src/components/ui/Button'
import SelectMenu from '../../../../src/components/ui/SelectMenu'

export default function CollectionGroupEditor({ open = true, rootId, row, groups, busy, errorMessage, onClose, onSave }: { open?: boolean; rootId: number; row: CollectionGroup; groups: MediaCatalogWorkGroup[]; busy: boolean; errorMessage?: string; onClose: () => void; onSave: CollectionSave }) {
  const [title, setTitle] = useState(row.title)
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [splitTitle, setSplitTitle] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setTitle(row.title)
    setTarget('')
    setSelected([])
    setSplitTitle('')
    setError('')
  }, [open])
  const save = async (action: () => Promise<unknown>, message: string) => {
    setError('')
    if (await onSave(action, message)) onClose()
    else setError('保存未完成，请检查页面提示后重试。')
  }
  return <CollectionDialog open={open} title="调整分组" busy={busy} onClose={onClose}>
    {(errorMessage || error) && <p role="alert" className="text-sm text-red-200">{errorMessage || error}</p>}
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); void save(() => api.folders.renameMediaWorkGroup(rootId, row.group.id, title.trim()), '分组名称已保存') }}><label className="block text-xs text-text-secondary">分组名称<input className="input mt-1" value={title} onChange={event => setTitle(event.target.value)} required disabled={busy} /></label><Button type="submit" size="sm" disabled={busy || !title.trim()}>保存名称</Button></form>
    <section className="space-y-2 border-t border-white/10 pt-4"><h3 className="text-xs text-text-secondary">合并到另一分组</h3><SelectMenu value={target} onChange={setTarget} options={[{ value: '', label: '选择目标分组' }, ...groups.filter(group => group.id !== row.group.id).map(group => ({ value: String(group.id), label: group.title }))]} ariaLabel="合并目标分组" disabled={busy} className="w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" wrapOptions /><Button size="sm" disabled={busy || !target} onClick={() => { void save(() => api.folders.mergeMediaWorkGroups(rootId, Number(target), row.group.id), '分组已合并') }}>合并 {row.works.length} 部作品</Button></section>
    <details className="border-t border-white/10 pt-4"><summary className="cursor-pointer text-xs text-text-secondary">将部分作品拆为新分组</summary><div className="mt-3 space-y-3">{row.works.map(work => <label key={work.key} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(work.item.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, work.item.id] : ids.filter(id => id !== work.item.id))} />{work.title}</label>)}<label className="block text-xs text-text-secondary">新分组名称<input className="input mt-1" value={splitTitle} onChange={event => setSplitTitle(event.target.value)} disabled={busy} /></label><Button size="sm" disabled={busy || selected.length === 0 || selected.length === row.works.length || !splitTitle.trim()} onClick={() => { void save(() => api.folders.splitMediaWorkGroup(rootId, row.group.id, selected, splitTitle.trim()), '已拆分作品组') }}>拆为新分组</Button></div></details>
  </CollectionDialog>
}
