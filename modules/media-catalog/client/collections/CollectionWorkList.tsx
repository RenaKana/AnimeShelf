import { useState, type ReactNode } from 'react'
import type { CollectionGroup, CollectionRow, CollectionWork } from '../collectionNavigation'
import Button from '../../../../src/components/ui/Button'
import { FolderIcon } from '../../../../src/components/ui/Icons'
import { collectionWorkPoster } from '../collectionArtwork'

export interface CollectionWorkListProps {
  rows: CollectionRow[]; manage?: boolean; busy?: boolean; artwork?: Record<number, string | null>
  onOpen?: (folderId: number) => void
  onEdit?: (work: CollectionWork) => void
  onEditGroup?: (group: CollectionGroup) => void
  onMove?: (rows: CollectionRow[], key: string, offset: number) => void
}

export interface CollectionWorkItemProps {
  work: CollectionWork | null
  title?: string
  targetKey?: string
  artwork?: Record<number, string | null>
  sequence?: number
  status?: ReactNode
  busy?: boolean
  onOpen?: (folderId: number) => void
  onEdit?: (work: CollectionWork) => void
  actions?: ReactNode
}

export function CollectionArtwork({ src, title }: { src?: string | null; title: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  return <span className="collection-artwork" aria-hidden="true">{src && failed !== src ? <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} /> : <span>{title.slice(0, 2)}</span>}</span>
}

export function CollectionWorkItem({ work, title, targetKey, artwork = {}, sequence, status, busy, onOpen, onEdit, actions }: CollectionWorkItemProps) {
  const displayTitle = work?.title ?? title ?? targetKey ?? '无法解析的作品'
  const heading = <>
    {sequence !== undefined && <span className="collection-sequence" aria-label={`观看顺序 ${sequence}`}>{String(sequence).padStart(2, '0')}</span>}
    <CollectionArtwork src={work ? collectionWorkPoster(work, artwork) : null} title={displayTitle} />
    <span className="collection-work-copy">
      <span className="collection-work-title">{displayTitle}</span>
      <span className="collection-work-meta">{work ? <>{work.label}{work.item.conflict_reason && <span title={work.item.conflict_reason}> · 需核对</span>}</> : <>引用失效 · {targetKey}</>}{status}</span>
    </span>
  </>
  const content = work?.folders.length === 1 && onOpen
    ? <button type="button" className="collection-work-heading w-full text-left" aria-label={`打开${displayTitle}`} onClick={() => onOpen(work.folders[0].id)}>{heading}<span aria-hidden="true" className="text-text-secondary">↗</span></button>
    : work && work.folders.length > 1
      ? <details className="collection-versions"><summary className="collection-work-heading">{heading}<span className="shrink-0 text-xs text-text-secondary">{work.folders.length} 个目录 <span className="collection-chevron">›</span></span></summary><div className="collection-version-list">{work.folders.map(folder => <button key={folder.id} type="button" disabled={!onOpen} onClick={() => onOpen?.(folder.id)} title={folder.path}><FolderIcon width={15} height={15} /><span>{folder.name}</span></button>)}</div></details>
      : <div className="collection-work-heading">{heading}</div>
  return <div className={`collection-work ${work ? '' : 'collection-work-missing'}`}>
    <div className="min-w-0 flex-1">{content}</div>
    {(actions || (work && onEdit)) && <div className="collection-work-actions">{actions}{work && onEdit && <Button size="sm" variant="ghost" disabled={busy} aria-label={`调整作品：${displayTitle}`} onClick={() => onEdit(work)}>调整</Button>}</div>}
  </div>
}

export default function CollectionWorkList({ rows, manage, busy, artwork = {}, onOpen, onEdit, onEditGroup, onMove }: CollectionWorkListProps) {
  const ordering = (row: CollectionRow, index: number) => manage && onMove && <span className="collection-order">
    <button type="button" disabled={busy || index === 0} aria-label={`上移${row.title}`} onClick={() => onMove(rows, row.key, -1)}>↑</button>
    <button type="button" disabled={busy || index === rows.length - 1} aria-label={`下移${row.title}`} onClick={() => onMove(rows, row.key, 1)}>↓</button>
  </span>
  if (!rows.length) return <p className="p-6 text-sm text-text-secondary">暂无作品。可在管理中添加目录，或使用管理功能整理。</p>
  return <div className="collection-list">{rows.map((row, index) => row.type === 'group' ?
    <div key={row.key} className="collection-group">
      <details>
        <summary className="collection-group-heading"><span className="collection-chevron">›</span><span className="min-w-0 flex-1 break-words font-medium text-text-primary">{row.title}</span><span className="shrink-0 text-xs text-text-secondary">{row.label}</span></summary>
        <div className="collection-group-members"><CollectionWorkList rows={row.works} manage={manage} busy={busy} artwork={artwork} onOpen={onOpen} onEdit={onEdit} onMove={onMove} /></div>
      </details>
      {manage && <div className="collection-group-actions">{ordering(row, index)}{onEditGroup && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEditGroup(row)}>调整分组</Button>}</div>}
    </div> :
    <CollectionWorkItem key={row.key} work={row} artwork={artwork} busy={busy} onOpen={onOpen} onEdit={manage ? onEdit : undefined} actions={ordering(row, index)} />
  )}</div>
}
