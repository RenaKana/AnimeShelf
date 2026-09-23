import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachVideoPlayback } from '../client/videoPlayback'

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  get hidden() { return this.visibilityState === 'hidden' }
}

class TestVideo extends EventTarget {
  paused = true
  playCalls = 0
  pauseCalls = 0
  loadCalls = 0
  videoWidth = 1280
  videoHeight = 720
  readyState = 2
  currentTime = 0
  src = 'same-source.mp4'
  frameToken = 1
  nextPlay: () => Promise<void> = () => Promise.resolve()
  nextFrameId = 0
  frameCallbacks = new Map<number, VideoFrameRequestCallback>()
  cancelledFrameIds: number[] = []

  play() {
    this.playCalls += 1
    this.paused = false
    return this.nextPlay()
  }

  pause() {
    this.pauseCalls += 1
    this.paused = true
  }

  load() {
    this.loadCalls += 1
  }

  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    const id = ++this.nextFrameId
    this.frameCallbacks.set(id, callback)
    return id
  }

  cancelVideoFrameCallback(id: number) {
    this.cancelledFrameIds.push(id)
    this.frameCallbacks.delete(id)
  }

  presentNextFrame() {
    const next = this.frameCallbacks.entries().next().value as [number, VideoFrameRequestCallback] | undefined
    if (!next) return
    this.frameCallbacks.delete(next[0])
    next[1](0, {} as VideoFrameCallbackMetadata)
  }
}

class TestCanvas {
  width = 0
  height = 0
  style = { visibility: 'hidden' }
  drawCalls = 0
  drawnFrameToken: number | null = null

  getContext(): { drawImage: (source: TestVideo) => void } | null {
    return {
      drawImage: (source: TestVideo) => {
        this.drawCalls += 1
        this.drawnFrameToken = source.frameToken
      },
    }
  }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

let testDocument: TestDocument
let testWindow: EventTarget

function setup(video = new TestVideo()) {
  testDocument = new TestDocument()
  testWindow = new EventTarget()
  const canvas = new TestCanvas()
  vi.stubGlobal('document', testDocument)
  vi.stubGlobal('window', testWindow)
  const cleanup = attachVideoPlayback(video as unknown as HTMLVideoElement, canvas as unknown as HTMLCanvasElement)
  return { video, canvas, cleanup }
}

function dispatch(target: EventTarget, type: string) {
  target.dispatchEvent(new Event(type))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachVideoPlayback', () => {
  it('pauses while hidden and resumes once across visibility, focus, and pageshow', async () => {
    const { video } = setup()
    expect(video.playCalls).toBe(1)

    testDocument.visibilityState = 'hidden'
    dispatch(testDocument, 'visibilitychange')
    expect(video.pauseCalls).toBe(1)

    testDocument.visibilityState = 'visible'
    dispatch(testDocument, 'visibilitychange')
    dispatch(testWindow, 'focus')
    dispatch(testWindow, 'focus')
    dispatch(testWindow, 'pageshow')
    await flushPromises()

    expect(video.playCalls).toBe(2)
    expect(video.loadCalls).toBe(0)
  })

  it('pauses on visible-window blur and keeps the captured frame until a fresh video frame', async () => {
    const { video, canvas } = setup()
    video.currentTime = 14.25
    expect(video.playCalls).toBe(1)

    dispatch(testWindow, 'blur')
    expect(testDocument.visibilityState).toBe('visible')
    expect(video.paused).toBe(true)
    expect(video.currentTime).toBe(14.25)
    expect(video.src).toBe('same-source.mp4')
    expect(video.loadCalls).toBe(0)
    expect(canvas.style.visibility).toBe('visible')
    expect(canvas.drawCalls).toBe(1)
    expect(canvas.drawnFrameToken).toBe(1)
    expect([canvas.width, canvas.height]).toEqual([1280, 720])

    dispatch(video, 'loadeddata')
    dispatch(video, 'canplay')
    dispatch(testWindow, 'pageshow')
    await flushPromises()
    expect(video.paused).toBe(true)
    expect(video.playCalls).toBe(1)

    dispatch(testWindow, 'focus')
    expect(video.paused).toBe(false)
    expect(video.playCalls).toBe(2)
    expect(canvas.style.visibility).toBe('visible')

    video.frameToken = 2
    video.presentNextFrame()
    expect(canvas.style.visibility).toBe('hidden')
    expect(video.src).toBe('same-source.mp4')
    expect(video.loadCalls).toBe(0)
  })

  it('ignores an old frame completion after cleanup and a new source attachment', () => {
    const { video, canvas, cleanup } = setup()
    dispatch(testWindow, 'blur')
    dispatch(testWindow, 'focus')
    const staleFrame = video.frameCallbacks.values().next().value as VideoFrameRequestCallback
    cleanup()

    video.src = 'next-source.mp4'
    video.frameToken = 2
    video.paused = true
    const nextCleanup = attachVideoPlayback(video as unknown as HTMLVideoElement, canvas as unknown as HTMLCanvasElement)
    dispatch(testWindow, 'blur')
    expect(canvas.drawnFrameToken).toBe(2)
    expect(canvas.style.visibility).toBe('visible')

    staleFrame(0, {} as VideoFrameCallbackMetadata)
    expect(canvas.style.visibility).toBe('visible')
    expect(video.loadCalls).toBe(0)
    nextCleanup()
  })

  it('invalidates an earlier frame waiter across repeated blur and focus', () => {
    const { video, canvas } = setup()
    dispatch(testWindow, 'blur')
    dispatch(testWindow, 'focus')
    const staleFrame = video.frameCallbacks.values().next().value as VideoFrameRequestCallback

    video.frameToken = 2
    dispatch(testWindow, 'blur')
    expect(video.cancelledFrameIds).toHaveLength(1)
    expect(canvas.drawnFrameToken).toBe(2)
    expect(canvas.style.visibility).toBe('visible')

    dispatch(testWindow, 'focus')
    staleFrame(0, {} as VideoFrameCallbackMetadata)
    expect(canvas.style.visibility).toBe('visible')
    video.presentNextFrame()
    expect(canvas.style.visibility).toBe('hidden')
  })

  it('still pauses when a decoded frame cannot be copied to canvas', () => {
    const { video, canvas } = setup()
    canvas.getContext = () => null

    expect(() => dispatch(testWindow, 'blur')).not.toThrow()
    expect(video.paused).toBe(true)
    expect(canvas.style.visibility).toBe('hidden')
  })

  it('handles rejected play promises and retries on media readiness', async () => {
    const { video } = setup()
    await flushPromises()
    video.paused = true
    video.nextPlay = () => Promise.reject(new Error('autoplay blocked'))
    dispatch(testWindow, 'focus')
    await flushPromises()
    video.paused = true

    expect(() => dispatch(video, 'canplay')).not.toThrow()
    expect(video.playCalls).toBe(3)
  })

  it('cleans up every listener and ignores pending completion after disposal', async () => {
    let resolvePlay!: () => void
    const video = new TestVideo()
    video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = resolve })
    const { cleanup } = setup(video)
    cleanup()

    testDocument.visibilityState = 'hidden'
    dispatch(testDocument, 'visibilitychange')
    testDocument.visibilityState = 'visible'
    dispatch(testDocument, 'visibilitychange')
    dispatch(testWindow, 'focus')
    dispatch(testWindow, 'pageshow')
    dispatch(video, 'loadeddata')
    dispatch(video, 'canplay')
    resolvePlay()
    await flushPromises()

    expect(video.playCalls).toBe(1)
    expect(video.pauseCalls).toBe(0)
  })

  it('allows a new request after hide/show even when the previous play is unresolved', async () => {
    const resolvers: Array<() => void> = []
    const video = new TestVideo()
    video.nextPlay = () => new Promise<void>(resolve => { resolvers.push(resolve) })
    setup(video)
    expect(video.playCalls).toBe(1)

    testDocument.visibilityState = 'hidden'
    dispatch(testDocument, 'visibilitychange')
    testDocument.visibilityState = 'visible'
    dispatch(testDocument, 'visibilitychange')
    dispatch(testWindow, 'focus')
    expect(video.playCalls).toBe(2)
    video.paused = true
    dispatch(testWindow, 'focus')
    dispatch(testWindow, 'focus')
    expect(video.playCalls).toBe(2)

    resolvers[0]()
    await flushPromises()
    dispatch(testWindow, 'focus')
    expect(video.playCalls).toBe(2)

    resolvers[1]()
  })
})
