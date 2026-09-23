import { useEffect, useState } from 'react'
import { api } from '../api'
import CollectionDialog from './CollectionDialog'
import type { CollectionSave } from './CollectionEditor'
import Button from '../../../../src/components/ui/Button'

export default function CollectionResetDialog({ open = true, rootId, rootName, snapshotVersion, busy, errorMessage, onClose, onSave }: {
  open?: boolean; rootId: number; rootName: string; snapshotVersion: string; busy: boolean; errorMessage?: string
  onClose: () => void; onSave: CollectionSave
}) {
  const [confirmation, setConfirmation] = useState('')
  useEffect(() => {
    if (open) setConfirmation('')
  }, [open])
  return <CollectionDialog open={open} title="完全重置作品分类" busy={busy} onClose={onClose}>
    <p className="break-words text-sm text-text-primary">当前合集：{rootName}</p>
    <p className="text-sm leading-6 text-text-secondary">清除本合集的自动和手动分类、作品分组、排除记录、显示名称与顺序，随后按目录结构重新整理。旧的撤回记录也会清除，此操作不能恢复。</p>
    <p className="text-sm leading-6 text-text-secondary">不会删除或移动磁盘文件夹、视频；海报和元数据保持不变。其他合集不受影响。</p>
    {errorMessage && <p className="text-sm text-red-200" role="alert">{errorMessage}</p>}
    <form className="space-y-4" onSubmit={event => {
      event.preventDefault()
      if (busy || confirmation.trim() !== '重置' || !snapshotVersion) return
      void onSave(() => api.folders.resetCollection(rootId, snapshotVersion), '作品分类已完全重置并重新整理').then(ok => { if (ok) onClose() })
    }}>
      <label className="block text-xs text-text-secondary">输入“重置”以确认<input className="input mt-2" aria-label="重置确认" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" /></label>
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" variant="danger" disabled={busy || confirmation.trim() !== '重置' || !snapshotVersion}>完全重置并重新整理</Button></div>
    </form>
  </CollectionDialog>
}
