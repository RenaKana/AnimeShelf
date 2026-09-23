import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = (props: IconProps) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
})

export const HomeIcon = (props: IconProps) => <svg {...base(props)}><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></svg>
export const CalendarIcon = (props: IconProps) => <svg {...base(props)}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
export const StarIcon = (props: IconProps) => <svg {...base(props)}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z"/></svg>
export const LibraryIcon = (props: IconProps) => <svg {...base(props)}><path d="M4 4h5v16H4zM10.5 4H16v16h-5.5zM17.5 7H21v13h-3.5z"/></svg>
export const PinIcon = (props: IconProps) => <svg {...base(props)}><path d="m14 4 6 6-3 1-4 4-1 5-2-2-2-2 5-1 4-4 1-3-6-6-3 1 3 3-6 6"/></svg>
export const RefreshIcon = (props: IconProps) => <svg {...base(props)}><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M18.4 9A7 7 0 0 0 6.2 6.2L4 9M5.6 15A7 7 0 0 0 17.8 17.8L20 15"/></svg>
export const PauseIcon = (props: IconProps) => <svg {...base(props)}><path d="M8 5v14M16 5v14"/></svg>
export const SettingsIcon = (props: IconProps) => <svg {...base(props)}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 .9V21h-4v-.7a1.7 1.7 0 0 0-1-.9 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-.9-1H3v-4h.7a1.7 1.7 0 0 0 .9-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.9V3h4v.7a1.7 1.7 0 0 0 1 .9 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 .9 1h.7v4h-.7a1.7 1.7 0 0 0-.9 1Z"/></svg>
export const ChevronLeftIcon = (props: IconProps) => <svg {...base(props)}><path d="m15 18-6-6 6-6"/></svg>
export const ChevronRightIcon = (props: IconProps) => <svg {...base(props)}><path d="m9 18 6-6-6-6"/></svg>
export const ChevronDownIcon = (props: IconProps) => <svg {...base(props)}><path d="m6 9 6 6 6-6"/></svg>
export const CheckIcon = (props: IconProps) => <svg {...base(props)}><path d="m5 12 4 4L19 6"/></svg>
export const ArrowUpIcon = (props: IconProps) => <svg {...base(props)}><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg>
export const ArrowDownIcon = (props: IconProps) => <svg {...base(props)}><path d="M12 5v14m5.5-5.5L12 19l-5.5-5.5"/></svg>
export const MoreIcon = (props: IconProps) => <svg {...base(props)}><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
export const PlayIcon = (props: IconProps) => <svg {...base(props)}><path d="m8 5 11 7-11 7V5Z"/></svg>
export const SearchIcon = (props: IconProps) => <svg {...base(props)}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
export const FolderIcon = (props: IconProps) => <svg {...base(props)}><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z"/></svg>
export const FileIcon = (props: IconProps) => <svg {...base(props)}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>
export const InfoIcon = (props: IconProps) => <svg {...base(props)}><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>
export const TagIcon = (props: IconProps) => <svg {...base(props)}><path d="M20 13 13 20 4 11V4h7z"/><circle cx="8.5" cy="8.5" r="1"/></svg>
export const TrashIcon = (props: IconProps) => <svg {...base(props)}><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg>
