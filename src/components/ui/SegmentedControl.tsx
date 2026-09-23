export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export default function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel, className = '' }: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}) {
  return (
    <div className={`ui-segmented inline-flex min-h-9 shrink-0 flex-wrap items-center rounded-lg border border-border/70 bg-surface/70 p-1 ${className}`} role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onKeyDown={event => {
            const index = options.findIndex(item => item.value === option.value)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
              : event.key === 'ArrowRight' ? (index + 1) % options.length
              : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : -1
            if (next < 0) return
            event.preventDefault()
            onChange(options[next].value)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
          }}
          className={`h-7 rounded-md px-3 text-xs font-medium transition ${value === option.value ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-white'}`}
          onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}
