import type { MouseEvent } from 'react'

export function hasSurfaceSelection(surface: HTMLElement): boolean {
  const selection = surface.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed) return false
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(surface)) return true
  }
  return false
}

/** Let native controls (including portalled menus) handle their own clicks. */
export function isSurfaceAction(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false
  const target = event.target
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return false
  if (target.closest('a, button, input, select, textarea, label, summary, [role="button"], [role="combobox"], [role="option"], [contenteditable="true"]')) return false
  return !hasSurfaceSelection(event.currentTarget)
}
