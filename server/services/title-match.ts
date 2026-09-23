// 用于“媒体库已有”提示的保守标题匹配。
// ID 匹配才是可靠依据；名称只在清洗后完全一致时兜底，避免系列总名命中新篇章。
export function normalizeLibraryTitle(value: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')                    // [压制组]、[年份]、[编码信息]
    .replace(/【[^】]*】/g, ' ')                      // 【压制组】
    .replace(/\([^)]*\)/g, ' ')                     // (英文原名)、(年份)
    .replace(/（[^）]*）/g, ' ')                     // 中文括号
    .replace(/\b(19|20)\d{2}\b/g, ' ')              // 年份
    .replace(/\b\d{3,4}p\b/g, ' ')                  // 分辨率
    .replace(/\b(bd|bluray|web|dvd|rip|ma10p|flac|aac|x26[45]|hevc|h\.?26[45])\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function titlesLikelySame(a: string, b: string): boolean {
  const normalizedA = normalizeLibraryTitle(a)
  const normalizedB = normalizeLibraryTitle(b)
  return normalizedA.length >= 2 && normalizedA === normalizedB
}
