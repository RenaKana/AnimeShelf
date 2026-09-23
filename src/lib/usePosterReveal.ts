import { useState, type HTMLAttributes } from 'react'

export function usePosterReveal(): HTMLAttributes<HTMLElement> & { 'data-synopsis-open': boolean } {
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  return {
    'data-synopsis-open': hovered || keyboardFocused,
    onPointerEnter: event => { if (event.pointerType !== 'touch') setHovered(true) },
    onPointerLeave: () => setHovered(false),
    // Mouse clicks must not leave the synopsis latched open after pointer exit.
    onPointerDown: () => setKeyboardFocused(false),
    onFocus: event => {
      if (event.target.matches(':focus-visible')) setKeyboardFocused(true)
    },
    onBlur: event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setKeyboardFocused(false)
    },
    onKeyDown: event => {
      if (event.key === 'Escape') { setHovered(false); setKeyboardFocused(false) }
    },
  }
}
