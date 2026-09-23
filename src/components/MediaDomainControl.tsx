import { MEDIA_DOMAIN_LABELS, MEDIA_DOMAIN_SOURCE_LABELS, type MediaDomain, type MediaDomainFields } from '../../shared/media-domain'
import SelectMenu from './ui/SelectMenu'

const MEDIA_DOMAIN_OPTIONS = [
  { value: 'auto', label: '自动判断' },
  { value: 'anime', label: '动漫' },
  { value: 'live_action', label: '真人影视' },
  { value: 'unknown', label: '待确认' },
] as const

export default function MediaDomainControl({ value, onChange, disabled = false, labelId = 'media-domain' }: {
  value: MediaDomainFields
  onChange: (value: MediaDomain | null) => void
  disabled?: boolean
  labelId?: string
}) {
  const reason = value.media_domain_reason === 'conflict' ? '来源类型冲突' : value.media_domain_reason === 'insufficient' ? '分类证据不足'
    : value.media_domain_reason === 'display_metadata' ? '跟随展示元数据' : value.media_domain_reason === 'manual_pending' ? '已手动设为待确认' : ''
  return <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
    <span id={labelId} className="text-text-secondary">媒体类型</span>
    <SelectMenu<MediaDomain | 'auto'>
      ariaLabel="媒体类型"
      options={MEDIA_DOMAIN_OPTIONS}
      value={value.media_domain_override ?? 'auto'}
      onChange={next => onChange(next === 'auto' ? null : next)}
      disabled={disabled}
      minWidthClass="min-w-28"
      menuPosition="fixed"
    />
    <span className="text-text-secondary" role="status">{MEDIA_DOMAIN_LABELS[value.media_domain ?? 'unknown']}{value.media_domain_source && value.media_domain_source !== 'unknown' ? ` · ${MEDIA_DOMAIN_SOURCE_LABELS[value.media_domain_source]}` : ''}{reason ? ` · ${reason}` : ''}</span>
  </div>
}
