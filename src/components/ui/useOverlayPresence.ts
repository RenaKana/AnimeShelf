import { useLayoutEffect, useState } from 'react'
import { motionDuration, useMotion } from '../../lib/motion'

/** Retain only the visual exit; close semantics and focus restoration stay immediate. */
export function useOverlayPresence(open: boolean, kind: 'menu' | 'dialog') {
  const [retained, setRetained] = useState(open)
  const { level, reduced } = useMotion()
  const duration = motionDuration(kind, level, reduced)
  useLayoutEffect(() => {
    if (open) { setRetained(true); return }
    if (!duration) { setRetained(false); return }
    const timer = window.setTimeout(() => setRetained(false), duration)
    return () => window.clearTimeout(timer)
  }, [open, duration])
  return {
    present: open || (retained && duration > 0),
    presenceProps: {
      'data-overlay-kind': kind,
      'data-overlay-state': open ? 'open' : 'closed',
      'aria-hidden': !open || undefined,
      ...(!open ? { inert: '' } : {}),
    },
  }
}
