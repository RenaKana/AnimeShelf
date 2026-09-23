import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import OverflowLabel from './OverflowLabel'

export function SidebarNavItem({ to, icon, label, collapsed, title }: {
  to: string
  icon: ReactNode
  label: string
  collapsed: boolean
  title?: string
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const labelActive = hovered || focused
  return (
    <NavLink
      to={to}
      title={title ?? label}
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={({ isActive }) => `sidebar-link group flex h-9 items-center rounded-lg transition-colors ${collapsed ? 'w-9 justify-center' : 'gap-2.5 px-3'} ${isActive ? 'bg-accent text-white shadow-[0_7px_18px_rgb(var(--ui-accent)/0.22)]' : 'text-text-secondary hover:bg-white/[0.055] hover:text-text-primary'}`}>
      <span className="shrink-0">{icon}</span>
      <OverflowLabel active={!collapsed && labelActive} className="sidebar-nav-label text-sm" title={label}>{label}</OverflowLabel>
    </NavLink>
  )
}

export function SidebarSectionLabel({ children }: { children: string }) {
  return <p className="sidebar-section-label px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-secondary/55">{children}</p>
}
