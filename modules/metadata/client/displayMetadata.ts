import type { DisplayMetadataCandidate } from '../../../src/types'

const KIND_LABEL: Record<DisplayMetadataCandidate['kind'], string> = {
  self: '当前目录',
  season: '季度',
  movie: '剧场版',
  special: '特别篇 / OVA',
  extras: '附加内容',
  unknown: '子目录',
}

export function displayMetadataOptions(
  candidates: DisplayMetadataCandidate[],
  effectiveName?: string,
  hasEffectiveMetadata = true,
) {
  return [
    {
      value: 'auto',
      label: hasEffectiveMetadata
        ? (effectiveName ? `自动（当前：${effectiveName}）` : '自动选择')
        : '自动（当前未找到可用资料）',
    },
    ...candidates.map(candidate => ({
      value: String(candidate.id),
      label: `${KIND_LABEL[candidate.kind]} · ${candidate.name}${candidate.hasMetadata ? '' : ' · 无元数据'}`,
    })),
  ]
}

export function selectedDisplayMetadataValue(folderId?: number | null): string {
  return folderId == null ? 'auto' : String(folderId)
}

export function automaticDisplayMetadataNotice(hasMetadata: boolean): string {
  return hasMetadata
    ? '已恢复自动选择展示资料'
    : '已切换自动模式，但未找到唯一可用的展示资料，请手动选择'
}
