import type { HTMLAttributes, ReactNode } from 'react'

/** Stable desktop shell shared by core and module pages. */
export function DesktopPresentation({ children }: { children: ReactNode }) {
  return <div className="desktop-frame relative z-10 flex h-full">{children}</div>
}

/** CSS slots preserve the search input and toolbar during responsive reflow. */
export function LibraryBrowsePresentation({ children }: { children: ReactNode }) {
  return <div className="library-browse-presentation contents">{children}</div>
}

export function SidebarPresentation({ collapsed, className, children, ...props }: HTMLAttributes<HTMLElement> & {
  collapsed: boolean; className: string; children: ReactNode
}) {
  return <aside {...props} data-collapsed={collapsed} className={`desktop-sidebar ${className}`}>{children}</aside>
}

export function DetailColumns({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`detail-columns ${className}`}>{children}</div>
}
