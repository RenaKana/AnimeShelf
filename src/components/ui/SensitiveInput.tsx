import { forwardRef, useEffect, useState, type FocusEvent, type InputHTMLAttributes } from 'react'

export interface SensitiveInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Changing this value also resets the field to its safe, hidden state. */
  resetKey?: string | number
  showLabel?: string
  hideLabel?: string
}

/**
 * A compact password field for saved credentials and one-time secrets.
 * The value is intentionally controlled by the caller; visibility is only
 * transient UI state and is reset on unmount, resetKey changes, or focus leave.
 */
const SensitiveInput = forwardRef<HTMLInputElement, SensitiveInputProps>(function SensitiveInput({
  resetKey,
  showLabel = '显示密钥',
  hideLabel = '隐藏密钥',
  className,
  onBlur,
  ...inputProps
}, ref) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(false)
  }, [resetKey])

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVisible(false)
    onBlur?.(event as unknown as FocusEvent<HTMLInputElement>)
  }

  return (
    <div className="mt-1 flex min-w-0 gap-2" onBlur={handleBlur}>
      <input
        ref={ref}
        {...inputProps}
        type={visible ? 'text' : 'password'}
        className={className}
      />
      <button
        type="button"
        className="shrink-0 rounded-lg border border-border px-2.5 text-xs text-text-secondary transition hover:border-accent/50 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        disabled={inputProps.disabled}
        onClick={() => setVisible(current => !current)}
      >
        {visible ? '隐藏' : '显示'}
      </button>
    </div>
  )
})

SensitiveInput.displayName = 'SensitiveInput'

export default SensitiveInput
