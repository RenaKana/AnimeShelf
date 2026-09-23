import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon } from './Icons'

export interface MultiSelectOption<T extends string | number> {
  value: T
  label: string
}

export function shouldToggleMultiSelectOption(key: string, targetRole: string | undefined): boolean {
  return targetRole === 'option' && (key === 'Enter' || key === ' ' || key === 'Spacebar')
}

export default function MultiSelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  selectionLabel = '已选',
  className = '',
  minWidthClass = 'min-w-32',
  disabled = false,
  menuPosition = 'absolute',
  menuWidth = 'content',
}: {
  value: ReadonlyArray<T>
  options: ReadonlyArray<MultiSelectOption<T>>
  onChange: (value: T[]) => void
  ariaLabel: string
  placeholder: string
  selectionLabel?: string
  className?: string
  minWidthClass?: string
  disabled?: boolean
  menuPosition?: 'absolute' | 'fixed'
  menuWidth?: 'content' | 'trigger'
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const [fixedMenuPosition, setFixedMenuPosition] = useState<{ left: number; top: number; minWidth: number; maxHeight: number; above: boolean } | null>(null)
  const selected = Array.from(value)
  const selectedSet = new Set(selected)
  const selectedCount = selected.length

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus())
      : undefined
    return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [activeIndex, open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useLayoutEffect(() => {
    if (!open || menuPosition !== 'fixed') {
      setFixedMenuPosition(null)
      return
    }
    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const gap = 7
      const estimatedHeight = Math.min(320, Math.max(72, options.length * 34 + 44))
      const above = rect.bottom + gap + estimatedHeight > window.innerHeight && rect.top - gap > estimatedHeight
      const minWidth = Math.max(rect.width, rootRef.current?.getBoundingClientRect().width ?? rect.width)
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - minWidth - 8))
      const availableHeight = above ? rect.top - gap * 2 : window.innerHeight - rect.bottom - gap * 2
      setFixedMenuPosition({
        left,
        top: above ? rect.top - gap : rect.bottom + gap,
        minWidth,
        maxHeight: Math.max(96, Math.min(320, availableHeight)),
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
  }, [menuPosition, open, options.length])

  const closeAndFocusTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const focusOption = (index: number) => {
    if (options.length === 0) return
    const next = (index + options.length) % options.length
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const toggleOption = (option: MultiSelectOption<T>) => {
    const next = selectedSet.has(option.value)
      ? selected.filter(valueItem => valueItem !== option.value)
      : [...selected, option.value]
    onChange(next)
  }

  const openMenu = (initialIndex = Math.max(0, options.findIndex(option => selectedSet.has(option.value)))) => {
    setActiveIndex(initialIndex)
    setOpen(true)
  }

  const toggleMenu = () => {
    if (disabled) return
    if (open) {
      closeAndFocusTrigger()
      return
    }
    openMenu()
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(Math.max(0, options.length - 1))
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      toggleMenu()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeAndFocusTrigger()
    }
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const optionTarget = target.closest<HTMLElement>('[role="option"]')
    const optionTargetRole = optionTarget ? 'option' : undefined
    if (event.key !== 'Escape' && event.key !== 'Tab' && !optionTarget) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(activeIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(activeIndex - 1)
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
    } else if (shouldToggleMultiSelectOption(event.key, optionTargetRole)) {
      const optionIndex = Number(optionTarget?.dataset.optionIndex)
      const option = Number.isInteger(optionIndex) ? options[optionIndex] : undefined
      if (!option) return
      event.preventDefault()
      toggleOption(option)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  const selectedLabel = selectedCount > 0 ? `${selectionLabel} ${selectedCount}` : placeholder
  const title = selectedCount > 0
    ? options.filter(option => selectedSet.has(option.value)).map(option => option.label).join('、')
    : placeholder

  return (
    <div ref={rootRef} className={`relative shrink-0 ${minWidthClass} ${open ? 'z-[90]' : ''} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={disabled ? false : open}
        aria-controls={listboxId}
        title={title}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 text-xs font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-150 ${disabled ? 'cursor-not-allowed border-border/40 bg-[var(--ui-control-bg)] text-text-secondary/45 opacity-65' : open ? 'border-accent/65 bg-accent/10 text-text-primary shadow-[0_0_0_3px_rgb(var(--ui-accent)/0.1)]' : 'border-border/70 bg-[var(--ui-control-bg)] text-text-secondary hover:border-border hover:bg-[var(--ui-control-hover-bg)] hover:text-text-primary'} focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/15`}
        onClick={toggleMenu}
        onKeyDown={handleTriggerKeyDown}>
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <ChevronDownIcon width={14} height={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (() => {
        const menu = (
        <div
          ref={menuRef}
          id={listboxId}
          data-ui-menu="ui-multi-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable="true"
          className={`ui-panel-strong ${menuPosition === 'fixed' ? 'fixed' : 'absolute left-0 top-[calc(100%+0.4rem)]'} ${menuWidth === 'trigger' && menuPosition !== 'fixed' ? 'w-full' : ''} z-[140] max-h-72 min-w-full w-max max-w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border/70 p-1.5 text-text-primary shadow-[0_18px_42px_rgba(0,0,0,0.34)] backdrop-blur-xl`}
          style={menuPosition === 'fixed' && fixedMenuPosition ? {
            left: fixedMenuPosition.left,
            top: fixedMenuPosition.top,
            minWidth: fixedMenuPosition.minWidth,
            width: menuWidth === 'trigger' ? fixedMenuPosition.minWidth : undefined,
            maxWidth: menuWidth === 'trigger' ? 'calc(100vw - 16px)' : undefined,
            maxHeight: fixedMenuPosition.maxHeight,
            transform: fixedMenuPosition.above ? 'translateY(-100%)' : undefined,
          } : undefined}
          onKeyDown={handleMenuKeyDown}>
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-2 py-1.5">
            <span className="text-[10px] font-medium text-text-secondary">{selectedCount > 0 ? `${selectionLabel} ${selectedCount}` : '未选择'}</span>
            <button
              type="button"
              disabled={selectedCount === 0}
              className="rounded px-1.5 py-1 text-[10px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-default disabled:opacity-35"
              onClick={() => onChange([])}>
              清除全部
            </button>
          </div>
          {options.length > 0 ? options.map((option, index) => {
            const current = selectedSet.has(option.value)
            return (
              <button
                key={`${String(option.value)}-${index}`}
                ref={node => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                data-option-index={index}
                aria-selected={current}
                tabIndex={activeIndex === index ? 0 : -1}
                className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs outline-none transition-colors ${current ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary'}`}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => toggleOption(option)}>
                <CheckIcon width={14} height={14} className={`shrink-0 ${current ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            )
          }) : (
            <span className="block px-2.5 py-2 text-xs text-text-secondary/60">暂无选项</span>
          )}
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
