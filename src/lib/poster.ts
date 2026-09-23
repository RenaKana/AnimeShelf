// 海报版本由服务端依据真正提供图片的元数据目录与缓存文件生成；
// 普通切库/筛选时保持 URL 稳定，只有海报文件实际变化时才自动换 URL。
export function posterUrl(item: { id: number; poster_version?: string | null }): string | null {
  return item.poster_version
    ? `/api/folders/${item.id}/poster?v=${encodeURIComponent(item.poster_version)}`
    : null
}

export function retainVisiblePosterErrors(
  errors: Set<string>,
  items: Array<{ id: number; poster_version?: string | null }>,
): Set<string> {
  const visibleUrls = new Set(items.map(item => posterUrl(item)).filter((url): url is string => Boolean(url)))
  return new Set([...errors].filter(url => visibleUrls.has(url)))
}
