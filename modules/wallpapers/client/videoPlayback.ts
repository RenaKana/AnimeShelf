type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number
  cancelVideoFrameCallback?: (id: number) => void
}

export function attachVideoPlayback(video: HTMLVideoElement, snapshot?: HTMLCanvasElement | null): () => void {
  const doc = typeof document === 'undefined' ? null : document
  const win = typeof window === 'undefined' ? null : window
  const framedVideo = video as VideoWithFrameCallbacks
  let disposed = false
  let requestId = 0
  let pendingRequest: number | null = null
  let pendingFrameCallback: number | null = null
  let frameWaitId = 0
  let windowFocused = typeof doc?.hasFocus === 'function' ? doc.hasFocus() : true

  const isVisible = () => !doc || (doc.visibilityState !== 'hidden' && doc.hidden !== true)
  const isForeground = () => isVisible() && windowFocused

  const setSnapshotVisible = (visible: boolean) => {
    if (snapshot) snapshot.style.visibility = visible ? 'visible' : 'hidden'
  }

  const cancelFrameWait = () => {
    frameWaitId += 1
    if (pendingFrameCallback !== null) {
      try {
        framedVideo.cancelVideoFrameCallback?.call(video, pendingFrameCallback)
      } catch {
        // The video may be detaching while a frame callback is cancelled.
      }
      pendingFrameCallback = null
    }
  }

  const clearSnapshot = () => {
    setSnapshotVisible(false)
    if (!snapshot) return
    try {
      snapshot.width = 0
      snapshot.height = 0
    } catch {
      // A detached canvas does not need to retain its backing store.
    }
  }

  const capturePausedFrame = () => {
    if (!snapshot) return
    try {
      const width = video.videoWidth
      const height = video.videoHeight
      if (video.readyState < 2 || width <= 0 || height <= 0) {
        setSnapshotVisible(false)
        return
      }
      if (snapshot.width !== width) snapshot.width = width
      if (snapshot.height !== height) snapshot.height = height
      const context = snapshot.getContext('2d')
      if (!context) {
        setSnapshotVisible(false)
        return
      }
      context.drawImage(video, 0, 0, width, height)
      setSnapshotVisible(true)
    } catch {
      setSnapshotVisible(false)
    }
  }

  const waitForFreshFrame = (playRequest: number) => {
    cancelFrameWait()
    const callbackToken = frameWaitId
    const requestFrame = framedVideo.requestVideoFrameCallback
    if (typeof requestFrame !== 'function') return

    let completed = false
    try {
      const id = requestFrame.call(video, () => {
        completed = true
        if (callbackToken !== frameWaitId || disposed || playRequest !== requestId) return
        pendingFrameCallback = null
        if (isForeground() && !video.paused) clearSnapshot()
      })
      if (!completed && callbackToken === frameWaitId) pendingFrameCallback = id
      else if (callbackToken !== frameWaitId) framedVideo.cancelVideoFrameCallback?.call(video, id)
    } catch {
      pendingFrameCallback = null
    }
  }

  const pauseWhileInactive = () => {
    cancelFrameWait()
    if (pendingRequest === null && video.paused) return
    capturePausedFrame()
    requestId += 1
    pendingRequest = null
    try {
      video.pause()
    } catch {
      // Media may already be detaching while the document is being hidden.
    }
  }

  const requestPlayback = () => {
    if (disposed) return
    if (!isForeground()) {
      pauseWhileInactive()
      return
    }
    if (!video.paused) {
      if (snapshot?.style.visibility === 'visible' && pendingFrameCallback === null) {
        waitForFreshFrame(requestId)
      }
      return
    }
    if (pendingRequest !== null) return

    const id = ++requestId
    pendingRequest = id
    let result: Promise<void>
    try {
      result = video.play()
    } catch {
      if (pendingRequest === id) pendingRequest = null
      return
    }
    if (snapshot?.style.visibility === 'visible') waitForFreshFrame(id)

    Promise.resolve(result).then(
      () => {
        if (pendingRequest === id) pendingRequest = null
        if (!disposed && id === requestId && !isForeground() && !video.paused) pauseWhileInactive()
      },
      () => {
        if (pendingRequest === id) pendingRequest = null
      },
    )
  }

  const onVisibilityChange = () => {
    if (isVisible()) requestPlayback()
    else pauseWhileInactive()
  }

  const onWindowBlur = () => {
    windowFocused = false
    pauseWhileInactive()
  }

  const onWindowFocus = () => {
    windowFocused = true
    requestPlayback()
  }

  doc?.addEventListener('visibilitychange', onVisibilityChange)
  win?.addEventListener('blur', onWindowBlur)
  win?.addEventListener('focus', onWindowFocus)
  win?.addEventListener('pageshow', requestPlayback)
  video.addEventListener('loadeddata', requestPlayback)
  video.addEventListener('canplay', requestPlayback)

  onVisibilityChange()

  return () => {
    if (disposed) return
    disposed = true
    requestId += 1
    pendingRequest = null
    cancelFrameWait()
    doc?.removeEventListener('visibilitychange', onVisibilityChange)
    win?.removeEventListener('blur', onWindowBlur)
    win?.removeEventListener('focus', onWindowFocus)
    win?.removeEventListener('pageshow', requestPlayback)
    video.removeEventListener('loadeddata', requestPlayback)
    video.removeEventListener('canplay', requestPlayback)
    clearSnapshot()
  }
}
