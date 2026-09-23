import { cloneElement, isValidElement, useRef, type ReactElement, type ReactNode } from 'react'
import { useOverlayPresence } from './useOverlayPresence'

/** Place around the conditional DOM overlay, not around a component owning dialog behavior.
 * Behavior hooks still see open=false immediately; only the inert visual is retained. */
export default function OverlayPresence({ open, kind = 'dialog', children }: {
  open: boolean; kind?: 'dialog' | 'menu'; children: ReactNode
}) {
  const last = useRef<ReactElement<Record<string, unknown>> | null>(null)
  const { present, presenceProps } = useOverlayPresence(open, kind)
  if (open && isValidElement(children)) last.current = children as ReactElement<Record<string, unknown>>
  if (!present) { last.current = null; return null }
  const node = open && isValidElement(children) ? children as ReactElement<Record<string, unknown>> : last.current
  return node ? cloneElement(node, presenceProps) : null
}
