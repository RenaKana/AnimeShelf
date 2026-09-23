import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getDialogTabDestination } from './dialogBehavior'
import { CheckIcon, ChevronDownIcon } from './Icons'
import { useOverlayPresence } from './useOverlayPresence'

export interface SelectMenuOption<T extends string> {
  value: T
  label: string
}

export default function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  minWidthClass = 'min-w-32',
  disabled = false,
  menuPosition = 'absolute',
  menuWidth = 'content',
  wrapOptions = false,
  size = 'sm',
  iconOnly = false,
}: {
  value: T
  options: ReadonlyArray<SelectMenuOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
  minWidthClass?: string
  disabled?: boolean
  menuPosition?: 'absolute' | 'fixed'
  menuWidth?: 'content' | 'trigger'
  wrapOptions?: boolean
  size?: 'sm' | 'md'
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const { present, presenceProps } = useOverlayPresence(open, 'menu')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [fixedMenuPosition, setFixedMenuPosition] = useState<{ left: number; top: number; minWidth: number; maxHeight: number; above: boolean } | null>(null)
  const listboxId = useId()
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const selected = options[selectedIndex] ?? options[0]

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open, fixedMenuPosition !== null])

  const focusOption = (index: number) => {
    const next = Math.max(0, Math.min(options.length - 1, index))
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const closeAndFocusTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const focusDialogSibling = (backward: boolean): boolean => {
    const trigger = triggerRef.current
    const dialog = trigger?.closest<HTMLElement>('[role="dialog"], [aria-modal="true"]')
    if (!trigger || !dialog) return false
    const destination = getDialogTabDestination(dialog, trigger, backward)
    if (!destination) return false
    setOpen(false)
    destination.focus()
    return true
  }

  const selectOption = (option: SelectMenuOption<T>) => {
    if (disabled) return
    onChange(option.value)
    closeAndFocusTrigger()
  }

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const toggleMenu = () => {
    if (open) {
      setOpen(false)
      return
    }
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open || menuPosition !== 'fixed') {
      if (!present) setFixedMenuPosition(null)
      return
    }
    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const gap = 7
      const estimatedHeight = Math.min(256, options.length * 32 + 12)
      const above = rect.bottom + gap + estimatedHeight > window.innerHeight && rect.top - gap > estimatedHeight
      const minWidth = Math.max(rect.width, rootRef.current?.getBoundingClientRect().width ?? rect.width)
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - minWidth - 8))
      const availableHeight = above ? rect.top - gap * 2 : window.innerHeight - rect.bottom - gap * 2
      setFixedMenuPosition({
        left,
        top: above ? rect.top - gap : rect.bottom + gap,
        minWidth,
        maxHeight: Math.max(80, Math.min(256, availableHeight)),
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
  }, [menuPosition, open, present, options.length])

  return (
    <div ref={rootRef} className={`relative shrink-0 ${minWidthClass} ${className} ${open ? 'z-[90]' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={disabled ? false : open}
        aria-disabled={disabled || undefined}
        aria-controls={listboxId}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ${size === 'md' ? 'h-10 text-sm' : 'h-9 text-xs'} ${disabled ? 'cursor-not-allowed border-border/40 bg-[var(--ui-control-bg)] text-text-secondary/45 opacity-65' : open ? 'border-accent/65 bg-accent/10 text-text-primary shadow-[0_0_0_3px_rgb(var(--ui-accent)/0.1)]' : 'border-border/70 bg-[var(--ui-control-bg)] text-text-secondary hover:border-border hover:bg-[var(--ui-control-hover-bg)] hover:text-text-primary'} focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/15`}
        onClick={toggleMenu}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex(event.key === 'ArrowDown' ? selectedIndex : Math.max(0, options.length - 1))
            setOpen(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            closeAndFocusTrigger()
          }
        }}>
        {!iconOnly && <span className="min-w-0 truncate">{selected?.label ?? ariaLabel}</span>}
        <ChevronDownIcon width={14} height={14} className={`shrink-0 transition-transform duration-200 ease-[var(--ease-out)] ${open ? 'rotate-180 text-accent' : 'text-text-secondary/70'}`} />
      </button>

      {present && (() => {
        const menu = (
        <div
          ref={menuRef}
          {...presenceProps}
          id={listboxId}
          data-ui-menu="ui-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          className={`ui-panel-strong ${menuPosition === 'fixed' ? 'fixed' : 'absolute left-0 top-[calc(100%+0.45rem)]'} ${menuWidth === 'trigger' && menuPosition !== 'fixed' ? 'w-full' : ''} z-[140] max-h-64 min-w-full overflow-y-auto rounded-xl border border-border/70 p-1.5 text-text-primary shadow-[0_18px_48px_rgba(0,0,0,0.42)] [@starting-style]:-translate-y-1 [@starting-style]:opacity-0 transition-[opacity,transform] duration-150 ease-[var(--ease-out)]`}
          style={menuPosition === 'fixed' && fixedMenuPosition ? {
            left: fixedMenuPosition.left,
            top: fixedMenuPosition.top,
            minWidth: fixedMenuPosition.minWidth,
            width: menuWidth === 'trigger' ? fixedMenuPosition.minWidth : undefined,
            maxWidth: menuWidth === 'trigger' ? 'calc(100vw - 16px)' : undefined,
            maxHeight: fixedMenuPosition.maxHeight,
            transformOrigin: fixedMenuPosition.above ? 'bottom left' : 'top left',
            transform: fixedMenuPosition.above ? 'translateY(-100%)' : undefined,
          } : undefined}
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
              event.stopPropagation()
              closeAndFocusTrigger()
            } else if (event.key === 'Tab') {
              if (focusDialogSibling(event.shiftKey)) {
                event.preventDefault()
                event.stopPropagation()
              } else setOpen(false)
            }
          }}>
          {options.map((option, index) => {
            const current = option.value === value
            return (
              <button
                key={option.value || '__all__'}
                ref={node => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                aria-selected={current}
                tabIndex={activeIndex === index ? 0 : -1}
                className={`flex ${wrapOptions ? 'min-h-8 items-start py-2' : 'h-8 items-center'} w-full gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors ${current ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary'}`}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}>
                <CheckIcon width={14} height={14} className={`shrink-0 ${wrapOptions ? 'mt-0.5' : ''} ${current ? 'opacity-100' : 'opacity-0'}`} />
                <span className={wrapOptions ? 'min-w-0 flex-1 whitespace-normal break-words pr-3 leading-5' : menuWidth === 'trigger' ? 'min-w-0 flex-1 truncate pr-3' : 'whitespace-nowrap pr-3'}>{option.label}</span>
              </button>
            )
          })}
        </div>
        )
        if (menuPosition === 'fixed') {
          return fixedMenuPosition && typeof document !== 'undefined' ? createPortal(menu, document.body) : null
        }
        return menu
      })()}
    </div>
  )
}
