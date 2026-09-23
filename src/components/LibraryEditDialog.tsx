import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Library } from '../types'
import { api } from '../api'
import Button from './ui/Button'
import SegmentedControl, { type SegmentedOption } from './ui/SegmentedControl'
import { useDialogBehavior, type DialogElementRef } from './ui/dialogBehavior'
import OverlayPresence from './ui/OverlayPresence'
import { normalizeMediaDomain } from '../../shared/media-domain'

type EditableLibraryType = 'anime' | 'live_action'

const TYPE_OPTIONS: SegmentedOption<EditableLibraryType>[] = [
  { value: 'anime', label: '动漫' },
  { value: 'live_action', label: '真人影视' },
]

function editableType(value: string): EditableLibraryType {
  return normalizeMediaDomain(value) === 'live_action' ? 'live_action' : 'anime'
}

export interface LibraryEditDialogProps {
  library: Library
  onClose: () => void
  onSaved: (updated: Library) => void
  triggerRef?: DialogElementRef
  open?: boolean
}

export default function LibraryEditDialog({ library, onClose, onSaved, triggerRef, open = true }: LibraryEditDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(library.name)
  const [type, setType] = useState<EditableLibraryType>(() => editableType(library.type))
  const [typeTouched, setTypeTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setName(library.name)
    setType(editableType(library.type))
    setTypeTouched(false)
    setSaving(false)
    setMessage('')
    setError('')
  }, [library, open])

  useDialogBehavior({
    open,
    dialogRef,
    initialFocusRef: nameRef,
    triggerRef,
    onClose,
    closeDisabled: saving,
  })

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving) return
    const nextName = name.trim()
    if (!nextName) {
      setError('媒体库名称不能为空')
      return
    }

    const patch: { name?: string; type?: EditableLibraryType } = {}
    if (nextName !== library.name) patch.name = nextName
    // Do not rewrite a legacy alias (for example, `movie`) just because the
    // form displays its normalized domain.  An explicit type interaction is
    // the user's request to persist the stable value.
    if (typeTouched) patch.type = type
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }

    setSaving(true)
    setMessage('')
    setError('')
    try {
      const updated = await api.libraries.update(library.id, patch)
      onSaved(updated)
      setMessage('已保存')
    } catch (cause: any) {
      setError(cause?.message ?? '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <OverlayPresence open={open}>
      {open && <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
        role="presentation"
        onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="library-edit-title"
          tabIndex={-1}
          className="clean-dialog ui-panel-strong w-full max-w-md overflow-hidden rounded-2xl border border-white/10 shadow-[0_28px_90px_rgba(0,0,0,0.58)]"
          onMouseDown={event => event.stopPropagation()}>
        <form onSubmit={event => { void save(event) }}>
          <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
            <div className="min-w-0">
              <h2 id="library-edit-title" className="text-base font-semibold text-text-primary">编辑媒体库</h2>
              <p className="mt-1 truncate text-xs text-text-secondary" title={library.root_path}>{library.root_path}</p>
            </div>
            <button type="button" className="shrink-0 rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary" onClick={onClose} disabled={saving} aria-label="关闭">×</button>
          </div>

          <div className="space-y-4 px-5 py-5">
            <label className="block text-sm text-text-secondary">
              名称
              <input
                ref={nameRef}
                value={name}
                onChange={event => { setName(event.target.value); setError(''); setMessage('') }}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text-primary outline-none transition focus:border-accent"
                aria-label="媒体库名称"
                disabled={saving} />
            </label>

            <div className="space-y-1.5 text-sm text-text-secondary">
              <span className="block">默认类型／刮削倾向</span>
              <SegmentedControl
                value={type}
                options={TYPE_OPTIONS}
                ariaLabel="媒体库默认类型"
                onChange={value => { setType(value); setTypeTouched(true); setError(''); setMessage('') }} />
              <p className="text-xs text-text-secondary">仅作为缺少分类证据时的默认值与刮削提示，不覆盖条目元数据或人工分类。</p>
            </div>

            {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
            {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
          </div>

          <div className="flex justify-end gap-2 border-t border-border/70 px-5 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </div>
        </form>
        </div>
      </div>}
    </OverlayPresence>,
    document.body,
  )
}
