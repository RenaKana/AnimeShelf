import { useId, useRef, type ReactNode } from 'react'
import { useDialogBehavior } from '../../../../src/components/ui/dialogBehavior'
import OverlayPresence from '../../../../src/components/ui/OverlayPresence'
import Button from '../../../../src/components/ui/Button'

export default function CollectionDialog({ open = true, title, busy, onClose, children }: { open?: boolean; title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useDialogBehavior({ open, dialogRef: ref, onClose, closeDisabled: busy })
  return <OverlayPresence open={open}>
    {open && <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-3 sm:p-5" onClick={() => { if (!busy) onClose() }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className="clean-dialog ui-panel-strong flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/10 shadow-xl" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3"><h2 id={id} className="min-w-0 break-words font-semibold">{title}</h2><Button size="sm" variant="ghost" aria-label="关闭调整" disabled={busy} onClick={onClose}>×</Button></header>
        <div className="min-h-0 space-y-5 overflow-y-auto p-4">{children}</div>
        <footer className="flex shrink-0 justify-end border-t border-white/10 p-3"><Button size="sm" disabled={busy} onClick={onClose}>完成</Button></footer>
      </div>
    </div>}
  </OverlayPresence>
}
