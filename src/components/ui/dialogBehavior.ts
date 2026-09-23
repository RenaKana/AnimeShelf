import { useEffect, useRef } from 'react'

export type DialogElementRef = { readonly current: HTMLElement | null }

export interface DialogBehaviorOptions {
  open: boolean
  dialogRef: DialogElementRef
  initialFocusRef?: DialogElementRef
  triggerRef?: DialogElementRef
  onClose: () => void
  closeDisabled?: boolean
  scrollContainer?: string | DialogElementRef | null
}

export interface DialogKeyboardEventLike {
  key: string
  shiftKey: boolean
  defaultPrevented: boolean
  preventDefault: () => void
  stopPropagation: () => void
}

export interface DialogLayerManager {
  register: (dialogRef: DialogElementRef) => symbol
  unregister: (token: symbol) => boolean
  isTop: (token: symbol) => boolean
  top: () => DialogElementRef | null
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function isAvailableFocusTarget(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element || element.isConnected === false || element.hidden || element.hasAttribute('disabled')) return false
  if (element.getAttribute('aria-hidden') === 'true') return false
  return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0
}

export function getDialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)].filter(isAvailableFocusTarget)
}

export function focusDialog(dialog: HTMLElement, preferred?: HTMLElement | null): HTMLElement {
  const target = isAvailableFocusTarget(preferred) ? preferred : getDialogFocusableElements(dialog)[0] ?? dialog
  target.focus()
  return target
}

export function getDialogTabDestination(dialog: HTMLElement, origin: HTMLElement, backward: boolean): HTMLElement | null {
  const focusable = getDialogFocusableElements(dialog)
  const originIndex = focusable.indexOf(origin)
  if (originIndex < 0 || focusable.length === 0) return null
  return backward
    ? focusable[originIndex - 1] ?? focusable[focusable.length - 1]
    : focusable[originIndex + 1] ?? focusable[0]
}

export function createDialogLayerManager(): DialogLayerManager {
  const layers: Array<{ token: symbol; dialogRef: DialogElementRef }> = []
  return {
    register: dialogRef => {
      const token = Symbol('dialog-layer')
      layers.push({ token, dialogRef })
      return token
    },
    unregister: token => {
      const index = layers.findIndex(layer => layer.token === token)
      if (index < 0) return false
      const wasTop = index === layers.length - 1
      layers.splice(index, 1)
      return wasTop
    },
    isTop: token => layers[layers.length - 1]?.token === token,
    top: () => layers[layers.length - 1]?.dialogRef ?? null,
  }
}

export function handleDialogKeyboardEvent(
  event: DialogKeyboardEventLike,
  options: {
    dialog: HTMLElement
    activeElement: Element | null
    closeDisabled: boolean
    onClose: () => void
  },
): boolean {
  if (event.defaultPrevented) return false

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!options.closeDisabled) options.onClose()
    return true
  }

  if (event.key !== 'Tab') return false
  const focusable = getDialogFocusableElements(options.dialog)
  if (focusable.length === 0) {
    event.preventDefault()
    event.stopPropagation()
    options.dialog.focus()
    return true
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const activeIndex = focusable.indexOf(options.activeElement as HTMLElement)
  const shouldWrapBackward = event.shiftKey && activeIndex <= 0
  const shouldWrapForward = !event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1)
  if (!shouldWrapBackward && !shouldWrapForward) return false

  event.preventDefault()
  event.stopPropagation()
  ;(event.shiftKey ? last : first).focus()
  return true
}

const scrollLocks = new Map<HTMLElement, { count: number; overflow: string }>()

export function lockDialogScroll(element: HTMLElement | null): () => void {
  if (!element) return () => undefined
  const existing = scrollLocks.get(element)
  if (existing) {
    existing.count += 1
  } else {
    scrollLocks.set(element, { count: 1, overflow: element.style.overflow })
    element.style.overflow = 'hidden'
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const lock = scrollLocks.get(element)
    if (!lock) return
    lock.count -= 1
    if (lock.count > 0) return
    element.style.overflow = lock.overflow
    scrollLocks.delete(element)
  }
}

const dialogLayers = createDialogLayerManager()

function resolveScrollContainer(scrollContainer: DialogBehaviorOptions['scrollContainer']): HTMLElement | null {
  if (scrollContainer === null) return null
  if (typeof scrollContainer === 'string') return document.querySelector<HTMLElement>(scrollContainer)
  if (scrollContainer) return scrollContainer.current
  return document.querySelector<HTMLElement>('main')
}

function restoreDialogFocus(target: HTMLElement | null): void {
  const remainingDialog = dialogLayers.top()?.current
  if (remainingDialog) {
    if (target?.isConnected && remainingDialog.contains(target)) target.focus()
    else focusDialog(remainingDialog)
    return
  }
  if (target?.isConnected) target.focus()
}

export function useDialogBehavior({
  open,
  dialogRef,
  initialFocusRef,
  triggerRef,
  onClose,
  closeDisabled = false,
  scrollContainer,
}: DialogBehaviorOptions): void {
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)
  const layerTokenRef = useRef<symbol | null>(null)
  const restoreTargetRef = useRef<HTMLElement | null>(null)
  onCloseRef.current = onClose
  closeDisabledRef.current = closeDisabled

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const activeElement = document.activeElement
    restoreTargetRef.current = triggerRef?.current ?? (activeElement instanceof HTMLElement ? activeElement : null)
    const token = dialogLayers.register(dialogRef)
    layerTokenRef.current = token
    const releaseScrollLock = lockDialogScroll(resolveScrollContainer(scrollContainer))
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialogLayers.isTop(token)) return
      const dialog = dialogRef.current
      if (dialog) focusDialog(dialog, initialFocusRef?.current)
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dialogLayers.isTop(token) || event.defaultPrevented) return
      const dialog = dialogRef.current
      if (!dialog) return
      handleDialogKeyboardEvent(event, {
        dialog,
        activeElement: document.activeElement,
        closeDisabled: closeDisabledRef.current,
        onClose: () => onCloseRef.current(),
      })
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      const wasTop = dialogLayers.unregister(token)
      if (layerTokenRef.current === token) layerTokenRef.current = null
      releaseScrollLock()
      if (!wasTop) return
      const target = triggerRef?.current ?? restoreTargetRef.current
      window.requestAnimationFrame(() => restoreDialogFocus(target))
    }
  }, [dialogRef, initialFocusRef, open, scrollContainer, triggerRef])

  useEffect(() => {
    if (!open || !closeDisabled || typeof document === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      const token = layerTokenRef.current
      const dialog = dialogRef.current
      if (!token || !dialog || !dialogLayers.isTop(token)) return
      const activeElement = document.activeElement as HTMLElement | null
      if (activeElement && getDialogFocusableElements(dialog).includes(activeElement)) return
      focusDialog(dialog)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [closeDisabled, dialogRef, open])
}
