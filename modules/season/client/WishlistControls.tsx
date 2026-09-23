import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon } from '@/components/ui/Icons'
import { useOverlayPresence } from '@/components/ui/useOverlayPresence'
import type {
  FavoriteLibraryStatusPresentation,
  FavoriteLibraryStatusTone,
} from './favoriteLayout'

export type WishlistSource = 'anilist' | 'bangumi' | 'tmdb'
export type WishlistLibraryStatus = 'auto' | 'present' | 'absent'
type WishlistDotTone = FavoriteLibraryStatusTone | 'accent' | 'info'

type WishlistOption<T extends string> = {
  value: T
  label: string
  dotTone?: WishlistDotTone
}

type WishlistDropdownProps<T extends string> = {
  value: T
  options: ReadonlyArray<WishlistOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  selectedLabel?: string
  selectedDotTone?: WishlistDotTone
  selectedTitle?: string
  disabled?: boolean
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  menuWidth?: number
  menuMinWidth?: number
  renderTrigger?: (props: WishlistTriggerRenderProps) => ReactNode
}

type WishlistTriggerRenderProps = {
  triggerRef: RefObject<HTMLButtonElement>
  listboxId: string
  open: boolean
  disabled: boolean
  toggleMenu: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

type MenuPosition = {
  left: number
  top: number
  width: number
  maxHeight: number
  above: boolean
}

const DOT_CLASSES: Record<WishlistDotTone, string> = {
  accent: 'bg-accent shadow-[0_0_8px_rgb(var(--ui-accent)/0.7)]',
  info: 'bg-sky-300 shadow-[0_0_8px_rgba(125,211,252,0.65)]',
  success: 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.65)]',
  neutral: 'bg-white/35',
  warning: 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.6)]',
}

function WishlistDot({ tone }: { tone: WishlistDotTone }) {
  return <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASSES[tone]}`} />
}

function WishlistDropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  selectedLabel,
  selectedDotTone,
  selectedTitle,
  disabled = false,
  className = '',
  open: controlledOpen,
  onOpenChange,
  menuWidth = 164,
  menuMinWidth = 0,
  renderTrigger,
}: WishlistDropdownProps<T>) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const open = controlledOpen ?? internalOpen
  const { present, presenceProps } = useOverlayPresence(open, 'menu')
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const selected = options[selectedIndex] ?? options[0]

  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) setTimeout(() => triggerRef.current?.focus(), 0)
  }

  const moveFocusPastTrigger = (backward: boolean) => {
    const trigger = triggerRef.current
    if (!trigger) {
      setOpen(false)
      return
    }
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter(element => (
      !element.hasAttribute('disabled')
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0
      && !menuRef.current?.contains(element)
    ))
    const triggerIndex = focusable.indexOf(trigger)
    const target = triggerIndex >= 0 ? focusable[triggerIndex + (backward ? -1 : 1)] : null
    setOpen(false)
    requestAnimationFrame(() => (target ?? trigger).focus())
  }

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
    return () => cancelAnimationFrame(frame)
  }, [activeIndex, open])

  useLayoutEffect(() => {
    if (!open && !present) {
      setMenuPosition(null)
      return
    }
    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const width = Math.min(menuWidth, Math.max(1, rect.width, menuMinWidth))
      const gap = 6
      const maxAvailableBelow = Math.max(80, window.innerHeight - rect.bottom - gap - 8)
      const maxAvailableAbove = Math.max(80, rect.top - gap - 8)
      const estimatedHeight = Math.min(256, options.length * 36 + 12)
      const above = estimatedHeight > maxAvailableBelow && maxAvailableAbove > maxAvailableBelow
      const maxHeight = Math.max(80, Math.min(256, above ? maxAvailableAbove : maxAvailableBelow))
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
      setMenuPosition({
        left,
        top: above ? rect.top - gap : rect.bottom + gap,
        width,
        maxHeight,
        above,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [menuMinWidth, menuWidth, open, options.length, present])

  const focusOption = (index: number) => {
    const next = Math.max(0, Math.min(options.length - 1, index))
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const selectOption = (option: WishlistOption<T>) => {
    if (disabled) return
    onChange(option.value)
    closeMenu(true)
  }

  const toggleMenu = () => {
    if (disabled) return
    if (open) {
      closeMenu(false)
      return
    }
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(event.key === 'ArrowDown' ? selectedIndex : Math.max(0, options.length - 1))
      setOpen(true)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeMenu(true)
    }
  }

  const menu = present && menuPosition && typeof document !== 'undefined' ? (
    <div
      ref={menuRef}
      {...presenceProps}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      className="clean-menu ui-panel-strong fixed z-[95] max-h-64 overflow-y-auto rounded-xl border border-white/12 p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.42)] [@starting-style]:-translate-y-1 [@starting-style]:opacity-0 transition-[opacity,transform] duration-150 ease-[var(--ease-out)]"
      style={{
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
        transform: menuPosition.above ? 'translateY(-100%)' : undefined,
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          focusOption((activeIndex + 1) % options.length)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          focusOption((activeIndex - 1 + options.length) % options.length)
        } else if (event.key === 'Home') {
          event.preventDefault()
          focusOption(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          focusOption(options.length - 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          closeMenu(true)
        } else if (event.key === 'Tab') {
          event.preventDefault()
          moveFocusPastTrigger(event.shiftKey)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const option = options[activeIndex]
          if (option) selectOption(option)
        }
      }}>
      {options.map((option, index) => {
        const current = option.value === value
        const tone = option.dotTone ?? 'neutral'
        return (
          <button
            key={option.value}
            ref={node => { optionRefs.current[index] = node }}
            type="button"
            role="option"
            aria-selected={current}
            tabIndex={activeIndex === index ? 0 : -1}
            className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors ${current ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-white/[0.065] hover:text-white focus-visible:bg-white/[0.065] focus-visible:text-white'}`}
            onMouseEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onClick={() => selectOption(option)}
          >
            <WishlistDot tone={tone} />
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  ) : null

  const defaultTrigger = (
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={disabled ? false : open}
      aria-controls={listboxId}
      title={selectedTitle}
      className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 text-xs font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ${disabled ? 'cursor-not-allowed border-white/[0.06] bg-black/10 text-text-secondary/45 opacity-65' : open ? 'border-accent/65 bg-accent/10 text-white shadow-[0_0_0_3px_rgb(var(--ui-accent)/0.1)]' : 'border-white/10 bg-black/20 text-text-secondary hover:border-white/20 hover:bg-white/[0.055] hover:text-white'} focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/15`}
      onClick={toggleMenu}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className="flex min-w-0 items-center gap-2">
        <WishlistDot tone={selectedDotTone ?? selected?.dotTone ?? 'neutral'} />
        <span className="truncate">{selectedLabel ?? selected?.label ?? ariaLabel}</span>
      </span>
      <ChevronDownIcon width={14} height={14} className={`shrink-0 transition-transform duration-200 ease-[var(--ease-out)] ${open ? 'rotate-180 text-accent' : 'text-text-secondary/70'}`} />
    </button>
  )

  return (
    <div ref={rootRef} className={`relative ${renderTrigger ? 'inline-block w-fit max-w-full shrink-0' : 'w-[164px] max-w-full shrink-0'} ${open ? 'z-[90]' : ''} ${className}`}>
      {renderTrigger ? renderTrigger({
        triggerRef,
        listboxId,
        open,
        disabled,
        toggleMenu,
        onKeyDown: handleTriggerKeyDown,
      }) : defaultTrigger}
      {typeof document !== 'undefined' && menu ? createPortal(menu, document.body) : null}
    </div>
  )
}

const SOURCE_OPTIONS: ReadonlyArray<WishlistOption<WishlistSource>> = [
  { value: 'bangumi', label: 'Bangumi', dotTone: 'accent' },
  { value: 'anilist', label: 'AniList', dotTone: 'info' },
  { value: 'tmdb', label: 'TMDB', dotTone: 'success' },
]

export function WishlistSourceSelect({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: WishlistSource
  onChange: (value: WishlistSource) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <WishlistDropdown
      value={value}
      options={SOURCE_OPTIONS}
      onChange={onChange}
      ariaLabel="选择资料搜索渠道"
      selectedTitle={`资料搜索渠道：${SOURCE_OPTIONS.find(option => option.value === value)?.label ?? 'Bangumi'}`}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

const LIBRARY_STATUS_OPTIONS: ReadonlyArray<WishlistOption<WishlistLibraryStatus>> = [
  { value: 'auto', label: '使用自动判断', dotTone: 'neutral' },
  { value: 'present', label: '标记为已收录', dotTone: 'warning' },
  { value: 'absent', label: '标记为未收录', dotTone: 'warning' },
]

export function WishlistLibraryStatusSelect({
  value,
  presentation,
  onChange,
  disabled = false,
}: {
  value: WishlistLibraryStatus
  presentation: FavoriteLibraryStatusPresentation
  onChange: (value: WishlistLibraryStatus) => void
  disabled?: boolean
}) {
  const folder = presentation.mode === 'auto' ? presentation.folder?.trim() : ''
  return (
    <WishlistDropdown
      value={value}
      options={LIBRARY_STATUS_OPTIONS}
      onChange={onChange}
      ariaLabel={presentation.ariaLabel}
      selectedLabel={presentation.label}
      selectedDotTone={presentation.tone}
      selectedTitle={presentation.ariaLabel}
      disabled={disabled}
      menuWidth={170}
      menuMinWidth={170}
      renderTrigger={({ triggerRef, listboxId, open, toggleMenu, onKeyDown }) => (
        <>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-label={presentation.ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={disabled ? false : open}
            aria-controls={listboxId}
            title={presentation.ariaLabel}
            className={`inline-flex max-w-full items-center gap-1.5 border-0 bg-transparent px-0 py-[3px] text-left text-xs font-medium text-text-primary outline-none transition-colors duration-150 ${disabled ? 'cursor-not-allowed text-text-secondary/45 opacity-65' : 'hover:text-accent'} focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-accent/20`}
            onClick={toggleMenu}
            onKeyDown={onKeyDown}
          >
            <WishlistDot tone={presentation.tone} />
            <span className="truncate">{presentation.label}</span>
          </button>
          {folder && <div className="ml-3.5 mt-0.5 max-w-[10rem] truncate text-[10px] leading-tight text-text-secondary" title={folder}>{folder}</div>}
        </>
      )}
    />
  )
}
