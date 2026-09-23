import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '../../db/schema'
import { makeLibraryDb } from '../../db/libraries'
import { makeSettingsDb } from '../../db/settings'
import { LibraryScanCoordinator } from '../library-scan-coordinator'
import { withLibraryMaintenance } from '../library-maintenance'
import type { LibraryScanResult } from '../../../shared/library-scan'

const success = (changed = false): LibraryScanResult => ({ added: 0, updated: 0, removed: 0, errors: [], changed })

describe('library scan coordinator', () => {
  let db: ReturnType<typeof createDb>
  let coordinator: LibraryScanCoordinator | undefined
  let first: number, second: number
  beforeEach(() => {
    vi.useFakeTimers()
    db = createDb(':memory:')
    first = makeLibraryDb(db).create('One', 'D:\\One', 'anime').id
    second = makeLibraryDb(db).create('Two', 'D:\\Two', 'anime').id
  })
  afterEach(async () => { await coordinator?.stop(); db.close(); vi.useRealTimers() })

  it('coalesces requests and serializes different libraries through one worker', async () => {
    let complete!: (result: LibraryScanResult) => void
    const scan = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { backgroundTasks: false, scan })
    coordinator.start()
    const a = coordinator.request(first), b = coordinator.request(first), c = coordinator.request(second)
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(1)
    complete(success(true))
    await Promise.all([a, b, c])
    expect(scan.mock.calls.map(call => call[0].id)).toEqual([first, second])
    expect(coordinator.snapshot().revision).toBe(1)
  })

  it('honors startup setting and leaves backgroundTasks=false isolated', async () => {
    makeSettingsDb(db).set('scan_on_startup', '1')
    makeSettingsDb(db).set('auto_scan', '0')
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { scan })
    coordinator.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.mock.calls.map(call => call[0].id)).toEqual([first, second])
    await coordinator.stop()
    coordinator = new LibraryScanCoordinator(db, 'two', { backgroundTasks: false, scan })
    coordinator.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('debounces file events, invalidates in-flight snapshots, and runs one trailing scan', async () => {
    const events = new Map<string, () => void>()
    const watch = vi.fn((root, callback) => { events.set(root, callback); return Object.assign(new EventEmitter(), { close: vi.fn() }) })
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { watch, scan })
    coordinator.start()
    const change = events.get('D:\\One')!
    change()
    await vi.advanceTimersByTimeAsync(1500)
    change()
    await vi.advanceTimersByTimeAsync(1999)
    expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(scan).toHaveBeenCalledTimes(1)
    let complete!: (result: LibraryScanResult) => void
    scan.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const manual = coordinator.request(first)
    await Promise.resolve()
    const options = scan.mock.calls[1][2]
    expect(options.isCurrent()).toBe(true)
    change(); change()
    expect(options.isCurrent()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(scan).toHaveBeenCalledTimes(2)
    complete(success())
    await manual
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(3)
  })

  it('retries incomplete snapshots and reports failures without advancing revision', async () => {
    const scan = vi.fn().mockResolvedValueOnce({ ...success(), errors: ['index lag'], retryable: true }).mockResolvedValue(success(true))
    const watch = () => Object.assign(new EventEmitter(), { close: vi.fn() })
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch })
    coordinator.start()
    await coordinator.request(first)
    expect(coordinator.snapshot()).toMatchObject({ revision: 0, libraries: [expect.objectContaining({ status: 'waiting', waitingReason: 'retry', error: 'index lag' }), expect.anything()] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(coordinator.snapshot().revision).toBe(1)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('periodically reconciles even when directory watching is unavailable', async () => {
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch: () => { throw new Error('offline') } })
    coordinator.start()
    expect(coordinator.snapshot().libraries[0].watchError).toContain('offline')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('waits for a long maintenance job and wakes exactly once on release without consuming retries', async () => {
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { backgroundTasks: false, scan })
    coordinator.start()
    let release!: () => void
    const maintenance = withLibraryMaintenance(db, '海报处理', () => new Promise<void>(resolve => { release = resolve }))
    expect((await coordinator.request(first)).code).toBe('LIBRARY_BUSY')
    expect((await coordinator.request(second)).code).toBe('LIBRARY_BUSY')
    expect(coordinator.snapshot().libraries.every(status => status.status === 'waiting' && status.waitingReason === 'maintenance' && !status.error)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).not.toHaveBeenCalled()
    release(); await maintenance
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.mock.calls.map(call => call[0].id)).toEqual([first, second])
    expect(coordinator.snapshot().libraries.every(status => status.status === 'complete')).toBe(true)
  })

  it('keeps cancelled snapshots in a waiting state and coalesces bursts without error flashes', async () => {
    const events = new Map<string, () => void>()
    let complete!: (result: LibraryScanResult) => void
    const scan = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch: (root, callback) => { events.set(root, () => callback('change', null)); return Object.assign(new EventEmitter(), { close: vi.fn() }) } })
    coordinator.start()
    const manual = coordinator.request(first)
    await Promise.resolve()
    events.get('D:\\One')!()
    complete({ ...success(), errors: ['扫描已取消'], code: 'SCAN_CANCELLED', retryable: true })
    await manual
    const waiting = coordinator.snapshot().libraries[0]
    expect(waiting).toMatchObject({ status: 'waiting', waitingReason: 'filesystem_changed', error: undefined })
    for (let index = 0; index < 5; index++) { await vi.advanceTimersByTimeAsync(1000); events.get('D:\\One')!() }
    expect(scan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(coordinator.snapshot().libraries[0].sequence).toBeGreaterThan(waiting.sequence!)
    expect(coordinator.snapshot().libraries[0].status).toBe('complete')
  })

  it('backs off 2/4/8 seconds and preserves the failure after the retry budget is exhausted', async () => {
    const scan = vi.fn().mockResolvedValue({ ...success(), errors: ['index lag'], retryable: true })
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch: () => Object.assign(new EventEmitter(), { close: vi.fn() }) })
    coordinator.start()
    await coordinator.request(first)
    for (const [delay, calls] of [[2000, 2], [4000, 3], [8000, 4]]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(scan).toHaveBeenCalledTimes(calls - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(scan).toHaveBeenCalledTimes(calls)
    }
    expect(coordinator.snapshot().libraries[0]).toMatchObject({ status: 'error', error: 'index lag', waitingReason: undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(scan).toHaveBeenCalledTimes(4)
  })

  it('does not let directory events shorten backoff or restart an exhausted failure cycle', async () => {
    let change!: () => void
    const scan = vi.fn().mockResolvedValue({ ...success(), errors: ['index lag'], retryable: true })
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch: (root, callback) => {
      if (root === 'D:\\One') change = () => callback('change', null)
      return Object.assign(new EventEmitter(), { close: vi.fn() })
    } })
    coordinator.start()
    await coordinator.request(first)
    await vi.advanceTimersByTimeAsync(2000)
    expect(scan).toHaveBeenCalledTimes(2)
    change()
    await vi.advanceTimersByTimeAsync(3999)
    expect(scan).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(scan).toHaveBeenCalledTimes(3)
    change()
    await vi.advanceTimersByTimeAsync(8000)
    expect(scan).toHaveBeenCalledTimes(4)
    for (let index = 0; index < 4; index++) {
      change()
      expect(coordinator.snapshot().libraries[0]).toMatchObject({ status: 'error', error: 'index lag' })
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect(scan).toHaveBeenCalledTimes(4)
    scan.mockResolvedValue(success(true))
    await coordinator.request(first, 'manual')
    expect(scan).toHaveBeenCalledTimes(5)
    expect(coordinator.snapshot().libraries[0]).toMatchObject({ status: 'complete', error: undefined })
  })

  it('does not wake removed libraries or restart work after shutdown on maintenance release', async () => {
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { backgroundTasks: false, scan })
    coordinator.start()
    let release!: () => void
    const maintenance = withLibraryMaintenance(db, '海报处理', () => new Promise<void>(resolve => { release = resolve }))
    await coordinator.request(first)
    await coordinator.request(second)
    db.exec(`DELETE FROM libraries WHERE id = ${first}`)
    coordinator.refresh()
    expect(coordinator.snapshot().libraries.map(status => status.libraryId)).toEqual([second])
    await coordinator.stop()
    release(); await maintenance
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scan).not.toHaveBeenCalled()
  })

  it('clears cancelled automatic waits and ignores late events from closed watchers', async () => {
    let change!: () => void
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', { scan, watch: (root, callback) => {
      if (root === 'D:\\One') change = () => callback('change', null)
      return Object.assign(new EventEmitter(), { close: vi.fn() })
    } })
    coordinator.start()
    change()
    expect(coordinator.snapshot().libraries[0].status).toBe('waiting')
    makeSettingsDb(db).set('auto_scan', '0')
    coordinator.refresh()
    change()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scan).not.toHaveBeenCalled()
    expect(coordinator.snapshot().libraries[0]).toMatchObject({ status: 'idle', waitingReason: undefined })
  })

  it('keeps a replacement coordinator subscribed when the old coordinator is stopped twice', async () => {
    const old = new LibraryScanCoordinator(db, 'old', { backgroundTasks: false, scan: vi.fn() })
    old.start(); await old.stop()
    const scan = vi.fn().mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'new', { backgroundTasks: false, scan })
    coordinator.start()
    await old.stop()
    let release!: () => void
    const maintenance = withLibraryMaintenance(db, '海报处理', () => new Promise<void>(resolve => { release = resolve }))
    await coordinator.request(first)
    release(); await maintenance
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledOnce()
  })

  it('does not cancel a scan for unrelated library events or an unchanged periodic refresh', async () => {
    const events = new Map<string, () => void>()
    let complete!: (result: LibraryScanResult) => void
    const scan = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue(success())
    coordinator = new LibraryScanCoordinator(db, 'one', {
      scan,
      watch: (root, callback) => { events.set(root, () => callback('change', null)); return Object.assign(new EventEmitter(), { close: vi.fn() }) },
    })
    coordinator.start()
    const active = coordinator.request(first)
    await Promise.resolve()
    const options = scan.mock.calls[0][2]
    events.get('D:\\Two')!()
    coordinator.refresh()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(options.isCurrent()).toBe(true)
    complete(success(true))
    await active
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.mock.calls.map(call => call[0].id)).toEqual([first, second, first])
  })

  it('ignores access-only change events but rescans for content, unknown, missing, and rename events', async () => {
    type TestWatchCallback = (eventType: 'rename' | 'change', filename: string | Buffer | null) => void
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-watch-'))
    const root = path.join(temp, 'library')
    const episode = path.join(root, 'episode.mkv')
    fs.mkdirSync(root)
    fs.writeFileSync(episode, 'episode')
    const events = new Map<string, TestWatchCallback>()
    const watch = vi.fn((watchRoot: string, callback: TestWatchCallback) => {
      events.set(watchRoot, callback)
      return Object.assign(new EventEmitter(), { close: vi.fn() })
    })
    const scan = vi.fn().mockImplementation(async (_library, _database, options) => {
      options.captureFilesystemBaseline?.(root)
      options.captureFilesystemBaseline?.(episode)
      return success()
    })
    try {
      db.prepare('UPDATE libraries SET root_path=? WHERE id=?').run([root, first])
      coordinator = new LibraryScanCoordinator(db, 'one', { watch, scan, debounceMs: 20 })
      coordinator.start()
      await coordinator.request(first)
      const change = events.get(root)!

      fs.readdirSync(root)
      change('change', path.basename(episode))
      await vi.advanceTimersByTimeAsync(100)
      expect(scan).toHaveBeenCalledTimes(1)

      fs.appendFileSync(episode, ' changed')
      change('change', path.basename(episode))
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(2)

      const added = path.join(root, 'added.mkv')
      fs.writeFileSync(added, 'added')
      change('change', path.basename(added))
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(3)

      fs.rmSync(added)
      change('change', path.basename(added))
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(4)

      change('rename', path.basename(episode))
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(5)

      change('change', null)
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(6)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('does not self-cancel when a changed directory emits an unchanged scan-time event', async () => {
    type TestWatchCallback = (eventType: 'rename' | 'change', filename: string | Buffer | null) => void
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-watch-directory-race-'))
    const root = path.join(temp, 'library')
    const episode = path.join(root, 'episode.mkv')
    const added = path.join(root, 'added.mkv')
    fs.mkdirSync(root)
    fs.writeFileSync(episode, 'episode')
    const events = new Map<string, TestWatchCallback>()
    const watch = vi.fn((watchRoot: string, callback: TestWatchCallback) => {
      events.set(watchRoot, callback)
      return Object.assign(new EventEmitter(), { close: vi.fn() })
    })
    let scanNumber = 0
    const scan = vi.fn().mockImplementation(async (_library, _database, options) => {
      scanNumber++
      options.captureFilesystemBaseline?.(root)
      options.captureFilesystemBaseline?.(episode)
      if (scanNumber === 2) {
        events.get(root)!('change', '.')
        expect(options.isCurrent?.()).toBe(true)
      }
      if (scanNumber === 3) {
        fs.appendFileSync(episode, ' changed after capture')
        events.get(root)!('change', path.basename(episode))
        expect(options.isCurrent?.()).toBe(false)
        return { ...success(), errors: ['扫描已取消'], code: 'SCAN_CANCELLED' }
      }
      return success()
    })
    try {
      db.prepare('UPDATE libraries SET root_path=? WHERE id=?').run([root, first])
      coordinator = new LibraryScanCoordinator(db, 'one', { watch, scan, debounceMs: 20 })
      coordinator.start()
      await coordinator.request(first)

      // A real directory-entry change makes the next scan capture a new root
      // fingerprint. The injected event after capture represents readdir's
      // access-only notification without changing that fingerprint again.
      fs.writeFileSync(added, 'added')
      events.get(root)!('change', path.basename(added))
      await vi.advanceTimersByTimeAsync(20)
      expect(scan).toHaveBeenCalledTimes(2)
      expect(coordinator.snapshot().libraries.find(value => value.libraryId === first)?.status).toBe('complete')
      await coordinator.request(first, 'manual')
      expect(scan).toHaveBeenCalledTimes(3)
      expect(coordinator.snapshot().libraries.find(value => value.libraryId === first)?.status).toBe('waiting')
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('keeps the committed baseline while a scan captures a new path before reading it', async () => {
    type TestWatchCallback = (eventType: 'rename' | 'change', filename: string | Buffer | null) => void
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'animeshelf-watch-race-'))
    const root = path.join(temp, 'library')
    const episode = path.join(root, 'episode.mkv')
    const added = path.join(root, 'added.mkv')
    fs.mkdirSync(root)
    fs.writeFileSync(episode, 'episode')
    const events = new Map<string, TestWatchCallback>()
    const watch = vi.fn((watchRoot: string, callback: TestWatchCallback) => {
      events.set(watchRoot, callback)
      return Object.assign(new EventEmitter(), { close: vi.fn() })
    })
    let firstScan = true
    const scan = vi.fn().mockImplementation(async (_library, _database, options) => {
      if (firstScan) {
        firstScan = false
        options.captureFilesystemBaseline?.(root)
        options.captureFilesystemBaseline?.(episode)
        return success()
      }
      options.captureFilesystemBaseline?.(added)
      fs.writeFileSync(added, 'added during scan')
      events.get(root)!('change', path.basename(added))
      expect(options.isCurrent?.()).toBe(false)
      return { ...success(), errors: ['扫描已取消'], code: 'SCAN_CANCELLED' }
    })
    try {
      db.prepare('UPDATE libraries SET root_path=? WHERE id=?').run([root, first])
      coordinator = new LibraryScanCoordinator(db, 'one', { watch, scan, debounceMs: 20 })
      coordinator.start()
      await coordinator.request(first)
      await coordinator.request(first, 'manual')
      expect(scan).toHaveBeenCalledTimes(2)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('closes old watchers when roots/settings change and cancels work before shutdown', async () => {
    const handles: Array<{ close: ReturnType<typeof vi.fn> }> = []
    const watch = vi.fn(() => { const handle = Object.assign(new EventEmitter(), { close: vi.fn() }); handles.push(handle); return handle })
    const scan = vi.fn((_library, _db, options) => new Promise<LibraryScanResult>(resolve => {
      options.signal.addEventListener('abort', () => resolve({ ...success(), errors: ['stopped'] }))
    }))
    coordinator = new LibraryScanCoordinator(db, 'one', { watch, scan })
    coordinator.start()
    db.prepare('UPDATE libraries SET root_path=? WHERE id=?').run(['D:\\Moved', first])
    coordinator.refresh()
    expect(handles[0].close).toHaveBeenCalledOnce()
    expect(watch).toHaveBeenCalledWith('D:\\Moved', expect.any(Function))
    const active = coordinator.request(first), queued = coordinator.request(second)
    await Promise.resolve()
    await coordinator.stop()
    expect((await active).errors).toEqual(['stopped'])
    expect((await queued).code).toBe('SERVER_STOPPING')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(handles.every(handle => handle.close.mock.calls.length > 0)).toBe(true)
  })
})
