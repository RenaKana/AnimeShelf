import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api as coreApi, type QueryParams } from '../../../src/api'
import { metadataApi } from '../../../modules/metadata/client/api'
import MetadataLibraryActions from '../../../modules/metadata/client/MetadataLibraryToolbar'
import DataTable from '../../../src/components/DataTable'
import FilterBar, { type FilterState } from '../../../src/components/FilterBar'
import TagPicker from '../../../src/components/TagPicker'
import LibraryView from '../../../src/pages/LibraryView'
import { useLibraryScanRefresh } from '../../../src/lib/libraryScan'
import type { FolderView } from '../../../src/types'
import type { LibraryScanSnapshot } from '../../../shared/library-scan'

const routerMocks = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }))

vi.mock('react-router-dom', () => ({
  useNavigate: () => routerMocks.navigate,
}))

vi.mock('../../../src/modules/registry', () => ({
  useModules: () => ({ modules: [] }),
  ModuleErrorBoundary: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

function sameDependencies(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

type EffectCleanup = void | (() => void)

type HookSlot =
  | { kind: 'state'; value: unknown; setValue: (value: unknown) => void }
  | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'memo'; value: unknown; dependencies: readonly unknown[] | undefined }
  | { kind: 'external-store'; value: unknown; unsubscribe?: () => void }
  | {
      kind: 'effect'
      create: () => EffectCleanup
      dependencies: readonly unknown[] | undefined
      cleanup?: () => void
      pending: boolean
    }

class HookHarness<Props, Output extends ReactElement = ReactElement> {
  private readonly slots: HookSlot[] = []
  private hookIndex = 0
  private active = true
  private currentProps: Props | undefined
  output: Output | null = null
  writesAfterUnmount = 0

  constructor(private readonly component: (props: Props) => Output) {}

  private readonly dispatcher = {
    useLayoutEffect: (create: () => EffectCleanup, dependencies: readonly unknown[] | undefined): void => this.dispatcher.useEffect(create, dependencies),
    useState: <T,>(initialValue: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] => {
      const index = this.hookIndex++
      let slot = this.slots[index]
      if (!slot) {
        const stateSlot: Extract<HookSlot, { kind: 'state' }> = {
          kind: 'state',
          value: typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue,
          setValue: (nextValue: unknown) => {
            if (!this.active) {
              this.writesAfterUnmount++
              return
            }
            const current = this.slots[index]
            if (!current || current.kind !== 'state') throw new Error('State hook order changed')
            current.value = typeof nextValue === 'function'
              ? (nextValue as (previous: T) => T)(current.value as T)
              : nextValue
          },
        }
        this.slots[index] = stateSlot
        slot = stateSlot
      }
      if (slot.kind !== 'state') throw new Error('State hook order changed')
      return [slot.value as T, slot.setValue as React.Dispatch<React.SetStateAction<T>>]
    },
    useRef: <T,>(initialValue: T): React.MutableRefObject<T> => {
      const index = this.hookIndex++
      let slot = this.slots[index]
      if (!slot) {
        slot = { kind: 'ref', value: { current: initialValue } }
        this.slots[index] = slot
      }
      if (slot.kind !== 'ref') throw new Error('Ref hook order changed')
      return slot.value as React.MutableRefObject<T>
    },
    useMemo: <T,>(factory: () => T, dependencies: readonly unknown[] | undefined): T => {
      const index = this.hookIndex++
      let slot = this.slots[index]
      if (!slot || slot.kind !== 'memo' || !sameDependencies(slot.dependencies, dependencies)) {
        slot = { kind: 'memo', value: factory(), dependencies }
        this.slots[index] = slot
      }
      return slot.value as T
    },
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, dependencies: readonly unknown[] | undefined): T =>
      this.dispatcher.useMemo(() => callback, dependencies),
    useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T => {
      const index = this.hookIndex++
      let slot = this.slots[index]
      if (!slot) {
        const externalStoreSlot: Extract<HookSlot, { kind: 'external-store' }> = {
          kind: 'external-store',
          value: getSnapshot(),
        }
        externalStoreSlot.unsubscribe = subscribe(() => {
          if (!this.active) {
            this.writesAfterUnmount++
            return
          }
          externalStoreSlot.value = getSnapshot()
        })
        this.slots[index] = externalStoreSlot
        slot = externalStoreSlot
      }
      if (slot.kind !== 'external-store') throw new Error('External store hook order changed')
      slot.value = getSnapshot()
      return slot.value as T
    },
    useEffect: (create: () => EffectCleanup, dependencies: readonly unknown[] | undefined): void => {
      const index = this.hookIndex++
      const slot = this.slots[index]
      if (!slot) {
        this.slots[index] = { kind: 'effect', create, dependencies, pending: true }
        return
      }
      if (slot.kind !== 'effect') throw new Error('Effect hook order changed')
      slot.create = create
      if (!sameDependencies(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies
        slot.pending = true
      }
    },
  }

  render(props?: Props): Output {
    if (props !== undefined) this.currentProps = props
    if (this.currentProps === undefined) throw new Error('Initial props are required')
    this.active = true
    this.hookIndex = 0
    const dispatcherRef = (React as typeof React & {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
    }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    const previousDispatcher = dispatcherRef.current
    dispatcherRef.current = this.dispatcher as never
    try {
      this.output = this.component(this.currentProps)
    } finally {
      dispatcherRef.current = previousDispatcher
    }
    this.commitEffects()
    return this.output
  }

  replayEffects(): void {
    for (const slot of this.slots) {
      if (slot?.kind !== 'effect') continue
      slot.cleanup?.()
      slot.cleanup = undefined
    }
    for (const slot of this.slots) {
      if (slot?.kind !== 'effect') continue
      const cleanup = slot.create()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      slot.pending = false
    }
  }

  unmount(): void {
    this.active = false
    for (const slot of this.slots) {
      if (slot?.kind === 'effect') slot.cleanup?.()
      if (slot?.kind === 'external-store') slot.unsubscribe?.()
    }
  }

  private commitEffects(): void {
    for (const slot of this.slots) {
      if (slot?.kind !== 'effect' || !slot.pending) continue
      slot.cleanup?.()
      const cleanup = slot.create()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      slot.pending = false
    }
  }
}

function childrenOf(node: ReactElement): ReactNode[] {
  const children = (node.props as { children?: ReactNode }).children
  return Array.isArray(children) ? children : children === undefined ? [] : [children]
}

function findElement(root: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement {
  const queue = Array.isArray(root) ? [...root] : [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!React.isValidElement(node)) continue
    if (predicate(node)) return node
    queue.unshift(...childrenOf(node))
  }
  throw new Error('Expected element was not found')
}

function findElementByType(root: ReactNode, type: unknown): ReactElement {
  return findElement(root, element => element.type === type)
}

function findClickableText(root: ReactNode, text: string): ReactElement {
  return findElement(root, element => {
    const props = element.props as { children?: ReactNode; onClick?: unknown }
    return typeof props.onClick === 'function' && props.children === text
  })
}

function renderedText(root: ReactNode): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root)
  if (Array.isArray(root)) return root.map(renderedText).join('')
  if (!React.isValidElement(root)) return ''
  return childrenOf(root).map(renderedText).join('')
}

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

function stubLibraryScanWindow(): void {
  const windowListeners = new Map<string, Set<EventListener>>()
  const documentListeners = new Map<string, Set<EventListener>>()
  const add = (listeners: Map<string, Set<EventListener>>, type: string, listener: EventListener) => {
    const current = listeners.get(type) ?? new Set<EventListener>()
    current.add(listener)
    listeners.set(type, current)
  }
  const remove = (listeners: Map<string, Set<EventListener>>, type: string, listener: EventListener) => listeners.get(type)?.delete(listener)
  const windowMock = {
    localStorage: createStorage(),
    addEventListener: vi.fn((type: string, listener: EventListener) => add(windowListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: EventListener) => remove(windowListeners, type, listener)),
    dispatchEvent: vi.fn(),
    requestAnimationFrame: vi.fn(() => 0),
    cancelAnimationFrame: vi.fn(),
    setInterval: (handler: TimerHandler, timeout?: number) => globalThis.setInterval(handler, timeout),
    clearInterval: (handle: number | ReturnType<typeof setInterval>) => globalThis.clearInterval(handle),
  }
  const documentMock = {
    body: {},
    activeElement: null,
    querySelector: () => null,
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: vi.fn((type: string, listener: EventListener) => add(documentListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: EventListener) => remove(documentListeners, type, listener)),
  }
  vi.stubGlobal('window', windowMock)
  vi.stubGlobal('document', documentMock)
  vi.stubGlobal('HTMLElement', class {})
}

function folder(id: number, libraryId: number, name: string): FolderView {
  return {
    id,
    library_id: libraryId,
    parent_id: null,
    name,
    path: `D:\\Anime\\${name}`,
    is_series: 1,
    anilist_id: null,
    has_poster: 0,
    size: 1024,
    file_count: 1,
    tags: [],
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
  }
}

function metadataHarness(onRefresh = vi.fn(async () => undefined)) {
  stubLibraryScanWindow()
  return new HookHarness((props: { libraryId: number; refresh?: () => Promise<void> }) => MetadataLibraryActions({
    libraryId: props.libraryId, items: [folder(1, 1, 'A'), folder(2, 2, 'B')], folderIds: [props.libraryId],
    scopeKey: `library:${props.libraryId}`, scopeLabel: `媒体库 ${props.libraryId}`, scopeReady: true,
    menuContainer: {} as HTMLElement, closeMenu: () => {}, onRefresh: props.refresh ?? onRefresh, onStatus: () => {},
  }))
}

function startMetadata(harness: ReturnType<typeof metadataHarness>) {
  ;(findClickableText(harness.output, '匹配元数据').props as { onClick: () => void }).onClick()
  const tree = harness.render()
  ;(findClickableText(tree, '开始匹配').props as { onClick: () => void }).onClick()
}

function scanSnapshot(revision: number, changed = false): LibraryScanSnapshot {
  return {
    instanceId: 'scan-test-instance',
    revision,
    libraries: [{
      libraryId: 1,
      reason: 'manual',
      status: 'complete',
      revision,
      result: changed ? { added: 1, updated: 0, removed: 0, errors: [], changed: true } : undefined,
    }],
  }
}

function ScanRefreshProbe({ onStatus }: { onStatus: React.Dispatch<React.SetStateAction<string>> }): ReactElement {
  useLibraryScanRefresh(vi.fn(), onStatus)
  return React.createElement('div')
}

function libraryItems(root: ReactNode): FolderView[] {
  return (findElementByType(root, DataTable).props as { items: FolderView[] }).items
}

function filterBar(root: ReactNode): ReactElement<{ value: FilterState; onChange: (value: FilterState) => void }> {
  return findElementByType(root, FilterBar) as ReactElement<{ value: FilterState; onChange: (value: FilterState) => void }>
}

describe('LibraryView async route scope', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorage())
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    routerMocks.navigate.mockReset()
    vi.spyOn(coreApi.tags, 'list').mockResolvedValue([])
    vi.spyOn(coreApi.libraries, 'list').mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not reload the library when the scan version is unchanged', async () => {
    vi.useFakeTimers()
    stubLibraryScanWindow()
    const list = vi.spyOn(coreApi.folders, 'list').mockResolvedValue([folder(1, 1, 'A')])
    const scanStatus = vi.spyOn(coreApi.libraries, 'scanStatus').mockResolvedValue(scanSnapshot(0))
    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))

    harness.render({ libraryId: 1 })
    await settlePromises()
    harness.render()
    await vi.advanceTimersByTimeAsync(2000)
    await settlePromises()

    expect(scanStatus).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('passes the selected media domain to the folder list request', async () => {
    const listRequests: QueryParams[] = []
    vi.spyOn(coreApi.folders, 'list').mockImplementation(async params => {
      listRequests.push({ ...params })
      return [folder(1, 1, 'Anime')]
    })
    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))

    let tree = harness.render({ libraryId: 1 })
    await settlePromises()
    tree = harness.render()
    filterBar(tree).props.onChange({ ...filterBar(tree).props.value, mediaDomain: 'anime' })
    tree = harness.render()
    await settlePromises()

    expect(listRequests.at(-1)?.mediaDomain).toBe('anime')
    filterBar(tree).props.onChange({ ...filterBar(tree).props.value, q: 'anime-only' })
    tree = harness.render()
    await settlePromises()
    filterBar(tree).props.onChange({ ...filterBar(tree).props.value, mediaDomain: 'live_action' })
    tree = harness.render()
    await settlePromises()

    expect(filterBar(tree).props.value.q).toBe('')
    expect(listRequests.at(-1)).toMatchObject({ mediaDomain: 'live_action' })
    filterBar(tree).props.onChange({ ...filterBar(tree).props.value, mediaDomain: 'anime' })
    tree = harness.render()
    await settlePromises()
    expect(filterBar(tree).props.value.q).toBe('anime-only')
    harness.unmount()
  })

  it('clears an automatic polling failure after the next successful status read', async () => {
    vi.useFakeTimers()
    stubLibraryScanWindow()
    const scanStatus = vi.spyOn(coreApi.libraries, 'scanStatus')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(scanSnapshot(0))
    let message = ''
    const setStatus: React.Dispatch<React.SetStateAction<string>> = next => {
      message = typeof next === 'function' ? next(message) : next
    }
    const harness = new HookHarness((props: { onStatus: React.Dispatch<React.SetStateAction<string>> }) => ScanRefreshProbe(props))

    harness.render({ onStatus: setStatus })
    await settlePromises()
    expect(message).toBe('自动更新状态读取失败：offline')

    await vi.advanceTimersByTimeAsync(2000)
    await settlePromises()
    expect(scanStatus).toHaveBeenCalledTimes(2)
    expect(message).toBe('')
    harness.unmount()
  })

  it('preserves a later manual status when polling clears its earlier failure', async () => {
    vi.useFakeTimers()
    stubLibraryScanWindow()
    vi.spyOn(coreApi.libraries, 'scanStatus')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(scanSnapshot(0))
    let message = ''
    const setStatus: React.Dispatch<React.SetStateAction<string>> = next => {
      message = typeof next === 'function' ? next(message) : next
    }
    const harness = new HookHarness((props: { onStatus: React.Dispatch<React.SetStateAction<string>> }) => ScanRefreshProbe(props))

    harness.render({ onStatus: setStatus })
    await settlePromises()
    expect(message).toBe('自动更新状态读取失败：offline')
    message = '手动操作已完成'

    await vi.advanceTimersByTimeAsync(2000)
    await settlePromises()
    expect(message).toBe('手动操作已完成')
    harness.unmount()
  })

  it('keeps filtered editing state and intersects selection during a background refresh', async () => {
    vi.useFakeTimers()
    stubLibraryScanWindow()
    const initial = [folder(1, 1, 'A'), folder(2, 1, 'B')]
    const refreshed = [folder(1, 1, 'A refreshed'), folder(3, 1, 'C')]
    let listCall = 0
    const listRequests: QueryParams[] = []
    const list = vi.spyOn(coreApi.folders, 'list').mockImplementation(async params => {
      listRequests.push({ ...params })
      listCall++
      return listCall <= 2 ? initial : refreshed
    })
    const snapshots = [scanSnapshot(0), scanSnapshot(0), scanSnapshot(1, true)]
    const scanStatus = vi.spyOn(coreApi.libraries, 'scanStatus').mockImplementation(async () => snapshots.shift() ?? scanSnapshot(1, true))
    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))

    let tree = harness.render({ libraryId: 1 })
    await settlePromises()
    tree = harness.render()
    const filters = filterBar(tree)
    filters.props.onChange({ ...filters.props.value, q: 'keep-filter' })
    tree = harness.render()
    await settlePromises()
    tree = harness.render()

    ;(findElementByType(tree, DataTable).props as { onToggleSelect: (id: number) => void }).onToggleSelect(1)
    tree = harness.render()

    await vi.advanceTimersByTimeAsync(2000)
    await settlePromises()
    expect(scanStatus).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2000)
    await settlePromises()
    tree = harness.render()

    const table = findElementByType(tree, DataTable)
    expect((table.props as { items: FolderView[] }).items.map(item => item.id)).toEqual([1, 3])
    expect([...(table.props as { selected: Set<number> }).selected]).toEqual([1])
    expect(filterBar(tree).props.value.q).toBe('keep-filter')
    expect(listRequests.at(-1)?.q).toBe('keep-filter')
    harness.unmount()
  })

  it('stops a pending scan poll after unmount without writing state', async () => {
    vi.useFakeTimers()
    stubLibraryScanWindow()
    const pending = deferred<LibraryScanSnapshot>()
    const scanStatus = vi.spyOn(coreApi.libraries, 'scanStatus').mockReturnValue(pending.promise)
    vi.spyOn(coreApi.folders, 'list').mockResolvedValue([folder(1, 1, 'A')])
    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))

    harness.render({ libraryId: 1 })
    await settlePromises()
    harness.unmount()
    pending.resolve(scanSnapshot(1, true))
    await settlePromises()
    await vi.advanceTimersByTimeAsync(4000)

    expect(scanStatus).toHaveBeenCalledTimes(1)
    expect(harness.writesAfterUnmount).toBe(0)
  })

  it('drops a scan completion from the previous library before it can change the new route', async () => {
    const firstLoad = deferred<FolderView[]>()
    const secondLoad = deferred<FolderView[]>()
    const scan = deferred<{ added: number; updated: number; removed: number; errors: string[] }>()
    const listRequests: QueryParams[] = []
    vi.spyOn(coreApi.folders, 'list').mockImplementation(params => {
      listRequests.push({ ...params })
      if (listRequests.length === 1) return firstLoad.promise
      if (listRequests.length === 2) return secondLoad.promise
      return Promise.resolve([folder(1, 1, 'stale-A')])
    })
    vi.spyOn(coreApi.libraries, 'scan').mockReturnValue(scan.promise)

    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))
    let tree = harness.render({ libraryId: 1 })
    firstLoad.resolve([folder(1, 1, 'A')])
    await settlePromises()
    tree = harness.render()

    const scanPromise = (findClickableText(tree, '扫描媒体库').props as { onClick: () => Promise<void> }).onClick()
    tree = harness.render()
    expect(renderedText(tree)).toContain('扫描中…')

    tree = harness.render({ libraryId: 2 })
    secondLoad.resolve([folder(2, 2, 'B')])
    await settlePromises()
    tree = harness.render()
    expect(libraryItems(tree).map(item => item.name)).toEqual(['B'])
    expect(renderedText(tree)).not.toContain('扫描中…')

    scan.resolve({ added: 1, updated: 0, removed: 0, errors: [] })
    await scanPromise
    await settlePromises()
    tree = harness.render()

    expect(listRequests).toHaveLength(2)
    expect(libraryItems(tree).map(item => item.name)).toEqual(['B'])
    expect(renderedText(tree)).not.toContain('扫描完成')
    harness.unmount()
  })

  it('refreshes the same library with the newest filter after a scan completes', async () => {
    const scan = deferred<{ added: number; updated: number; removed: number; errors: string[] }>()
    const listRequests: QueryParams[] = []
    vi.spyOn(coreApi.folders, 'list').mockImplementation(async params => {
      if (!params) throw new Error('Expected folder list parameters')
      listRequests.push({ ...params })
      return [folder(1, 1, String(params.q || 'all'))]
    })
    vi.spyOn(coreApi.libraries, 'scan').mockReturnValue(scan.promise)

    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))
    let tree = harness.render({ libraryId: 1 })
    await settlePromises()
    tree = harness.render()
    const scanPromise = (findClickableText(tree, '扫描媒体库').props as { onClick: () => Promise<void> }).onClick()

    const filters = filterBar(tree)
    filters.props.onChange({ ...filters.props.value, q: 'newest' })
    tree = harness.render()
    await settlePromises()
    tree = harness.render()

    scan.resolve({ added: 0, updated: 1, removed: 0, errors: [] })
    await scanPromise
    await settlePromises()
    tree = harness.render()

    expect(listRequests.at(-1)?.q).toBe('newest')
    expect(renderedText(tree)).toContain('扫描完成：新增 0，更新 1')
    harness.unmount()
  })

  it('does not report a metadata-start failure after unmount', async () => {
    const start = deferred<{ running: boolean; jobId: string; folderIds: number[] }>()
    vi.spyOn(metadataApi, 'matchLibrary').mockReturnValue(start.promise)
    const status = vi.spyOn(metadataApi, 'libraryMatchStatus')
    const onRefresh = vi.fn(async () => undefined)
    const harness = metadataHarness(onRefresh)
    harness.render({ libraryId: 1 }); startMetadata(harness)
    harness.unmount()
    start.reject(new Error('old route failed'))
    await settlePromises()
    expect(harness.writesAfterUnmount).toBe(0)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('keeps the original job and frozen completion callback across scope changes', async () => {
    vi.useFakeTimers()
    const start = deferred<{ running: boolean; jobId: string; folderIds: number[] }>()
    vi.spyOn(metadataApi, 'matchLibrary').mockReturnValue(start.promise)
    const status = vi.spyOn(metadataApi, 'libraryMatchStatus').mockResolvedValue({ jobId: 'original', folderIds: [1], running: false, total: 0, done: 0, matched: 0, failed: 0, current: '' })
    const originalRefresh = vi.fn(async () => undefined), newRefresh = vi.fn(async () => undefined)
    const harness = metadataHarness(originalRefresh)
    harness.render({ libraryId: 1 }); startMetadata(harness)
    harness.render({ libraryId: 2, refresh: newRefresh })

    start.resolve({ running: true, jobId: 'original', folderIds: [1] })
    await vi.advanceTimersByTimeAsync(500)
    await settlePromises()

    expect(status).toHaveBeenCalledWith(1, 'original')
    expect(originalRefresh).toHaveBeenCalledTimes(1)
    expect(newRefresh).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('refreshes the library when metadata matching finishes', async () => {
    vi.useFakeTimers()
    const start = vi.spyOn(metadataApi, 'matchLibrary').mockResolvedValue({ running: true, jobId: 'scoped', folderIds: [1] })
    vi.spyOn(metadataApi, 'libraryMatchStatus').mockResolvedValue({ jobId: 'scoped', folderIds: [1], running: false, total: 1, done: 1, matched: 1, failed: 0, current: 'done' })
    const onRefresh = vi.fn(async () => undefined)
    const harness = metadataHarness(onRefresh)
    harness.render({ libraryId: 1 }); startMetadata(harness)

    await vi.advanceTimersByTimeAsync(500)
    await settlePromises()

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(1, 'auto', [1])
    expect(renderedText(harness.render())).toContain('范围内任务已完成')
    harness.unmount()
  })

  it('reports a conflict instead of adopting an unrelated running task', async () => {
    vi.useFakeTimers()
    vi.spyOn(metadataApi, 'matchLibrary').mockRejectedValue(Object.assign(new Error('已有其他任务运行中'), { status: 409 }))
    const status = vi.spyOn(metadataApi, 'libraryMatchStatus')
    const onRefresh = vi.fn(async () => undefined)
    const harness = metadataHarness(onRefresh)
    harness.render({ libraryId: 1 }); startMetadata(harness)
    await vi.advanceTimersByTimeAsync(500)
    await settlePromises()
    expect(status).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(renderedText(harness.render())).toContain('已有其他任务运行中')
    harness.unmount()
  })

  it('does not update state or reload after unmounting a pending scan', async () => {
    const scan = deferred<{ added: number; updated: number; removed: number; errors: string[] }>()
    const list = vi.spyOn(coreApi.folders, 'list').mockResolvedValue([folder(1, 1, 'A')])
    vi.spyOn(coreApi.libraries, 'scan').mockReturnValue(scan.promise)

    const harness = new HookHarness((props: { libraryId: number }) => LibraryView(props))
    let tree = harness.render({ libraryId: 1 })
    await settlePromises()
    tree = harness.render()
    const scanPromise = (findClickableText(tree, '扫描媒体库').props as { onClick: () => Promise<void> }).onClick()
    harness.unmount()

    scan.resolve({ added: 1, updated: 0, removed: 0, errors: [] })
    await scanPromise
    await settlePromises()

    expect(list).toHaveBeenCalledTimes(1)
    expect(harness.writesAfterUnmount).toBe(0)
  })
})
