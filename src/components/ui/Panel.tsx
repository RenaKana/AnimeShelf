import type { HTMLAttributes, ReactNode } from 'react'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  subtle?: boolean
}

export default function Panel({ children, subtle = false, className = '', ...props }: PanelProps) {
  return (
    <div
      {...props}
      className={`${subtle ? 'ui-panel-subtle border-white/[0.07] bg-black/15' : 'ui-panel border-white/10 bg-[#111722]/88 shadow-[0_16px_42px_rgba(0,0,0,0.18)] backdrop-blur-xl'} rounded-2xl border ${className}`}>
      {children}
    </div>
  )
}
