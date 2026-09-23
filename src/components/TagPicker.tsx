import { useState } from 'react'
import type { Tag } from '../types'

export default function TagPicker({
  tags, onPick, onCreate, onUnpick, picked, title = '标签', allowCreate = true,
}: {
  tags: Tag[]; picked: Set<number>
  onPick: (tag: Tag) => void; onUnpick: (tag: Tag) => void
  onCreate: (name: string) => Promise<void>
  title?: string; allowCreate?: boolean
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  return (
    <div className="tag-picker space-y-2">
      {title && <div className="text-sm font-medium text-text-secondary">{title}</div>}
      <div className="flex flex-wrap gap-1.5">
        {tags.map(t => (
          <button key={t.id} onClick={() => (picked.has(t.id) ? onUnpick(t) : onPick(t))}
            className={`text-xs px-2 py-1 rounded-full border transition-opacity duration-150 ${picked.has(t.id) ? 'border-transparent' : 'border-border opacity-70 hover:opacity-100'}`}
            style={picked.has(t.id) ? { backgroundColor: `${t.color}44`, color: t.color } : undefined}>
            {t.name}
          </button>
        ))}
      </div>
      {allowCreate && (creating ? (
        <form className="flex gap-2 [@starting-style]:opacity-0 [@starting-style]:translate-y-0.5 opacity-100 translate-y-0 transition-[opacity,transform] duration-150 ease-[var(--ease-out)]" onSubmit={async e => { e.preventDefault(); await onCreate(name); setName(''); setCreating(false) }}>
          <input autoFocus className="bg-surface border border-border rounded-lg px-2 py-1 text-sm flex-1" value={name} onChange={e => setName(e.target.value)} placeholder="新标签名" />
          <button className="px-2 py-1 text-sm bg-accent rounded-lg">添加</button>
          <button type="button" className="px-2 py-1 text-sm text-text-secondary" onClick={() => setCreating(false)}>取消</button>
        </form>
      ) : (
        <button className="text-xs text-accent hover:underline" onClick={() => setCreating(true)}>+ 新建标签</button>
      ))}
    </div>
  )
}
