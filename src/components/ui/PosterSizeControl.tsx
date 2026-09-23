type PosterSizeControlProps = {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label?: string
  className?: string
}

function normalizeValue(value: number, min: number, max: number, step: number): number {
  const numeric = Number.isFinite(value) ? value : min
  const clamped = Math.min(max, Math.max(min, numeric))
  return Math.round((clamped - min) / step) * step + min
}

export default function PosterSizeControl({
  value,
  min,
  max,
  step = 10,
  onChange,
  label = '海报大小',
  className = '',
}: PosterSizeControlProps) {
  const currentValue = normalizeValue(value, min, max, step)
  const update = (nextValue: number) => onChange(normalizeValue(nextValue, min, max, step))

  return (
    <div className={`poster-size-control flex max-w-full flex-wrap items-center gap-2 text-xs text-text-secondary ${className}`}>
      <span className="shrink-0 font-medium text-text-primary">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={currentValue}
        aria-label={`${label}（${currentValue}px）`}
        onChange={event => update(Number(event.target.value))}
        className="poster-size-range min-w-16 flex-1 cursor-pointer accent-accent"
      />
      <output className="w-12 shrink-0 text-right tabular-nums text-text-primary">
        {currentValue}px
      </output>
    </div>
  )
}
