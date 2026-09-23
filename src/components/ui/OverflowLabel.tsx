import { useEffect, useRef, useState, type ReactNode } from 'react'

export default function OverflowLabel({ children, active = false, className = '', title }: {
  children: ReactNode
  active?: boolean
  className?: string
  title?: string
}) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const [overflowDistance, setOverflowDistance] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ))

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const measure = () => {
      const distance = Math.max(0, content.scrollWidth - viewport.clientWidth)
      setOverflowDistance(previous => previous === distance ? previous : distance)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(viewport)
      observer.observe(content)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [children])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update)
      return () => media.removeEventListener('change', update)
    }
    media.addListener(update)
    return () => media.removeListener(update)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    content.style.transform = ''
    content.getAnimations?.().forEach(animation => animation.cancel())
    if (!active || overflowDistance <= 0 || reducedMotion || typeof content.animate !== 'function') return
    const animation = content.animate([
      { transform: 'translate3d(0, 0, 0)' },
      { transform: `translate3d(-${overflowDistance}px, 0, 0)` },
    ], {
      duration: Math.max(1400, Math.min(3600, overflowDistance * 32)),
      direction: 'alternate',
      easing: 'ease-in-out',
      iterations: Infinity,
    })
    return () => {
      animation.cancel()
      content.style.transform = ''
    }
  }, [active, overflowDistance, reducedMotion])

  return (
    <span
      ref={viewportRef}
      className={`min-w-0 flex-1 overflow-hidden ${className}`}
      title={title ?? (typeof children === 'string' ? children : undefined)}>
      <span ref={contentRef} className="block w-max min-w-full whitespace-nowrap">{children}</span>
    </span>
  )
}
