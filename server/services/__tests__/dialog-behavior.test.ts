import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createDialogLayerManager,
  focusDialog,
  getDialogTabDestination,
  handleDialogKeyboardEvent,
  lockDialogScroll,
  type DialogElementRef,
  type DialogKeyboardEventLike,
} from '../../../src/components/ui/dialogBehavior'
import { createLatestRequestGuard } from '../../../src/lib/latestRequest'
import { shouldStartFolderDetailLoad } from '../../../src/pages/FolderDetail'

const dialogBehaviorPath = resolve(process.cwd(), 'src/components/ui/dialogBehavior.ts')
const latestRequestPath = resolve(process.cwd(), 'src/lib/latestRequest.ts')

type ActiveElement = { current: HTMLElement | null }

function fakeElement(active: ActiveElement, options: { hidden?: boolean; visible?: boolean; disabled?: boolean; ariaHidden?: boolean } = {}): HTMLElement {
  const element = {
    hidden: options.hidden ?? false,
    isConnected: true,
    hasAttribute: (name: string) => name === 'disabled' ? Boolean(options.disabled) : false,
    getAttribute: (name: string) => name === 'aria-hidden' && options.ariaHidden ? 'true' : null,
    getClientRects: () => options.visible === false ? [] : [{}],
    focus: () => { active.current = element as unknown as HTMLElement },
  }
  return element as unknown as HTMLElement
}

function fakeDialog(active: ActiveElement, focusables: HTMLElement[]): HTMLElement {
  const dialog = fakeElement(active) as unknown as {
    querySelectorAll: () => HTMLElement[]
    contains: (node: Node | null) => boolean
  }
  dialog.querySelectorAll = () => focusables
  dialog.contains = node => node === dialog as unknown || focusables.includes(node as HTMLElement)
  return dialog as unknown as HTMLElement
}

function fakeKeyEvent(key: string, options: { shiftKey?: boolean; defaultPrevented?: boolean } = {}) {
  const state = { prevented: options.defaultPrevented ?? false, stopped: false }
  const event = {
    key,
    shiftKey: options.shiftKey ?? false,
    get defaultPrevented() { return state.prevented },
    preventDefault: () => { state.prevented = true },
    stopPropagation: () => { state.stopped = true },
  } satisfies DialogKeyboardEventLike
  return { event, state }
}

const handleKeyboard = handleDialogKeyboardEvent as unknown as (
  event: DialogKeyboardEventLike,
  options: { dialog: HTMLElement; activeElement: Element | null; closeDisabled: boolean; onClose: () => void },
) => boolean

const acquireScrollLock = lockDialogScroll as unknown as (element: HTMLElement | null) => () => void

describe('shared dialog behavior', () => {
  it('provides the reusable dialog behavior surface', () => {
    expect(existsSync(dialogBehaviorPath)).toBe(true)
    if (!existsSync(dialogBehaviorPath)) return

    const source = readFileSync(dialogBehaviorPath, 'utf8')
    expect(source).toContain('export function useDialogBehavior')
    expect(source).toContain('export function handleDialogKeyboardEvent')
    expect(source).toContain('export function lockDialogScroll')
    expect(source).toContain('export function createDialogLayerManager')
    expect(source).toContain('export function focusDialog')
    expect(source).toContain('export function getDialogTabDestination')
  })

  it('lets a child menu consume Escape without closing its parent dialog', () => {
    const active: ActiveElement = { current: null }
    const onClose = vi.fn()
    const { event, state } = fakeKeyEvent('Escape', { defaultPrevented: true })

    expect(handleKeyboard(event, { dialog: fakeDialog(active, []), activeElement: null, closeDisabled: false, onClose })).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(state.stopped).toBe(false)
  })

  it('consumes Escape while busy without closing the current dialog', () => {
    const active: ActiveElement = { current: null }
    const onClose = vi.fn()
    const { event, state } = fakeKeyEvent('Escape')

    expect(handleKeyboard(event, { dialog: fakeDialog(active, []), activeElement: null, closeDisabled: true, onClose })).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(state.prevented).toBe(true)
    expect(state.stopped).toBe(true)
  })

  it('cycles Tab at both dialog boundaries', () => {
    const active: ActiveElement = { current: null }
    const first = fakeElement(active)
    const middle = fakeElement(active)
    const last = fakeElement(active)
    const dialog = fakeDialog(active, [first, middle, last])

    active.current = last
    const forward = fakeKeyEvent('Tab')
    expect(handleKeyboard(forward.event, { dialog, activeElement: active.current, closeDisabled: false, onClose: vi.fn() })).toBe(true)
    expect(active.current).toBe(first)
    expect(forward.state.prevented).toBe(true)

    active.current = first
    const backward = fakeKeyEvent('Tab', { shiftKey: true })
    expect(handleKeyboard(backward.event, { dialog, activeElement: active.current, closeDisabled: false, onClose: vi.fn() })).toBe(true)
    expect(active.current).toBe(last)
    expect(backward.state.prevented).toBe(true)
  })

  it('focuses the requested initial control and falls back when it is disabled', () => {
    const active: ActiveElement = { current: null }
    const fallback = fakeElement(active)
    const preferred = fakeElement(active)
    const disabledPreferred = fakeElement(active, { disabled: true })
    const dialog = fakeDialog(active, [fallback])

    expect(focusDialog(dialog, preferred)).toBe(preferred)
    expect(active.current).toBe(preferred)
    expect(focusDialog(dialog, disabledPreferred)).toBe(fallback)
    expect(active.current).toBe(fallback)
  })

  it('moves a portaled menu Tab to the trigger sibling inside its parent dialog', () => {
    const active: ActiveElement = { current: null }
    const before = fakeElement(active)
    const trigger = fakeElement(active)
    const after = fakeElement(active)
    const dialog = fakeDialog(active, [before, trigger, after])

    expect(getDialogTabDestination(dialog, trigger, false)).toBe(after)
    expect(getDialogTabDestination(dialog, trigger, true)).toBe(before)
  })

  it('keeps focus on the dialog when every action is disabled', () => {
    const active: ActiveElement = { current: null }
    const dialog = fakeDialog(active, [])
    const tab = fakeKeyEvent('Tab')

    expect(handleKeyboard(tab.event, { dialog, activeElement: null, closeDisabled: true, onClose: vi.fn() })).toBe(true)
    expect(active.current).toBe(dialog)
    expect(tab.state.prevented).toBe(true)
  })

  it('tracks only the current dialog as the active keyboard layer', () => {
    const active: ActiveElement = { current: null }
    const manager = createDialogLayerManager()
    const firstRef = { current: fakeDialog(active, []) } satisfies DialogElementRef
    const secondRef = { current: fakeDialog(active, []) } satisfies DialogElementRef
    const first = manager.register(firstRef)
    const second = manager.register(secondRef)

    expect(manager.isTop(first)).toBe(false)
    expect(manager.isTop(second)).toBe(true)
    expect(manager.top()).toBe(secondRef)
    expect(manager.unregister(second)).toBe(true)
    expect(manager.isTop(first)).toBe(true)
    expect(manager.unregister(first)).toBe(true)
    expect(manager.top()).toBeNull()
  })

  it('reference-counts the real scroll container and restores its prior overflow', () => {
    const container = { style: { overflow: 'auto' } } as unknown as HTMLElement
    const releaseFirst = acquireScrollLock(container)
    const releaseSecond = acquireScrollLock(container)

    expect(container.style.overflow).toBe('hidden')
    releaseFirst()
    expect(container.style.overflow).toBe('hidden')
    releaseSecond()
    expect(container.style.overflow).toBe('auto')
  })

  it('wires FolderDetail and D1 dialogs to the shared behavior', () => {
    const folderDetail = readFileSync(resolve(process.cwd(), 'src/pages/FolderDetail.tsx'), 'utf8')
    const modulePanels = ['modules/metadata/client/MetadataFolderPanel.tsx', 'modules/media-catalog/client/MediaCatalogPanel.tsx'].map(file => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n')
    const selectMenu = readFileSync(resolve(process.cwd(), 'src/components/ui/SelectMenu.tsx'), 'utf8')

    expect((folderDetail + modulePanels).match(/useDialogBehavior\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(folderDetail + modulePanels).not.toContain("document.querySelector('main')")
    expect(selectMenu).toContain('event.stopPropagation()')
    expect(selectMenu).toContain('getDialogTabDestination(dialog, trigger, backward)')
    expect(readFileSync(dialogBehaviorPath, 'utf8')).toContain('if (!dialogLayers.isTop(token)')
  })
})

describe('latest request guard', () => {
  it('provides a reusable request guard surface', () => {
    expect(existsSync(latestRequestPath)).toBe(true)
    if (!existsSync(latestRequestPath)) return

    expect(readFileSync(latestRequestPath, 'utf8')).toContain('export function createLatestRequestGuard')
  })

  it('rejects a slower response after navigation starts a newer request', async () => {
    const guard = createLatestRequestGuard<number>()
    const applied: string[] = []
    let currentFolderId = 1
    let resolveFirst!: (value: string) => void
    let resolveSecond!: (value: string) => void
    const first = new Promise<string>(resolve => { resolveFirst = resolve })
    const second = new Promise<string>(resolve => { resolveSecond = resolve })
    const load = async (folderId: number, response: Promise<string>) => {
      const ticket = guard.begin(folderId)
      const value = await response
      if (guard.isCurrent(ticket, currentFolderId)) applied.push(value)
    }

    const firstLoad = load(1, first)
    currentFolderId = 2
    const secondLoad = load(2, second)
    resolveSecond('folder B')
    await secondLoad
    resolveFirst('folder A')
    await firstLoad

    expect(applied).toEqual(['folder B'])
  })

  it('does not let a stale or unmounted callback start another folder load', () => {
    expect(shouldStartFolderDetailLoad(1, 2, true)).toBe(false)
    expect(shouldStartFolderDetailLoad(1, 1, false)).toBe(false)
    expect(shouldStartFolderDetailLoad(1, 1, true)).toBe(true)
  })

  it('wires FolderDetail loading through the current request guard', () => {
    const folderDetail = readFileSync(resolve(process.cwd(), 'src/pages/FolderDetail.tsx'), 'utf8')
    const entryGuardIndex = folderDetail.indexOf('if (!shouldStartFolderDetailLoad(')
    const beginIndex = folderDetail.indexOf('loadRequestGuardRef.current.begin(folderId)')
    const clearErrorIndex = folderDetail.indexOf("setError('')", beginIndex)

    expect(folderDetail).toContain('export function shouldStartFolderDetailLoad')
    expect(folderDetail).toContain('createLatestRequestGuard<number>()')
    expect(folderDetail).toContain('currentFolderIdRef.current = folderId')
    expect(folderDetail).toContain('loadRequestGuardRef.current.isCurrent(request, currentFolderIdRef.current)')
    expect(folderDetail).toContain('folderDetailMountedRef.current = false')
    expect(entryGuardIndex).toBeGreaterThan(-1)
    expect(entryGuardIndex).toBeLessThan(beginIndex)
    expect(entryGuardIndex).toBeLessThan(clearErrorIndex)
  })
})
