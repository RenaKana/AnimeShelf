import type { DownloadSource, SourceId } from './types'

export const DOWNLOAD_SOURCES: DownloadSource[] = [
  { id: 'bangumi', name: 'Bangumi.moe', url: 'https://bangumi.moe/' },
  { id: 'acgrip', name: 'ACG.RIP', url: 'https://acg.rip/' },
  { id: 'dmhy', name: '动漫花园', url: 'https://share.dmhy.org/' },
  { id: 'nyaa', name: 'Nyaa', url: 'https://nyaa.si/', note: '遵守原站限流，按实际响应显示状态' },
]
export const sourceInfo = (source: SourceId) => DOWNLOAD_SOURCES.find(item => item.id === source)!
