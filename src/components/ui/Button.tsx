import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'border-transparent bg-accent text-on-accent shadow-sm hover:bg-accent-hover',
  secondary: 'border-white/10 bg-white/[0.055] text-text-primary hover:border-white/20 hover:bg-white/[0.09]',
  ghost: 'border-transparent bg-transparent text-text-secondary hover:bg-white/[0.055] hover:text-text-primary',
  danger: 'border-red-400/15 bg-red-500/10 text-red-300 hover:bg-red-500/15 hover:text-red-200',
}

const SIZE: Record<Size, string> = {
  sm: 'h-8 rounded-lg px-2.5 text-xs',
  md: 'h-9 rounded-lg px-3.5 text-sm',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon, className = '', children, ...props }, ref) {
  return (
    <button
      type="button"
      {...props}
      ref={ref}
      data-ui-button={variant}
      className={`inline-flex shrink-0 items-center justify-center gap-2 border font-medium transition-[background-color,border-color,color,opacity] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]} ${className}`}>
      {icon}
      {children}
    </button>
  )
})

export default Button
