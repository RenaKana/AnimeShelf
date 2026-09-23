const chineseCollection = /(?:全集|全季|合集|全\s*\d{1,3}\s*(?:集|[话話]))/
const completeRelease = /(?:^|[^A-Za-z])complete(?=$|[^A-Za-z])/i
const batchRelease = /[\[(【（]\s*batch(?:\s+(?:release|pack))?\s*[\])】）]/i
const batchWord = /(?:^|[^A-Za-z])batch(?=$|[^A-Za-z])/i
const batchSingleEpisode = /(?:^|[^A-Za-z])batch\s*[-–—:]\s*(?:(?:s\d{1,2}\s*)?e(?:p(?:isode)?)?\s*)?\d{1,3}(?:v\d+)?(?![A-Za-z0-9]|\s*(?:-|~|–|—|至|到))/i
const finishedRelease = /(?:^|[^A-Za-z])(?:fin|end)(?=$|[^A-Za-z])|完[结結]/i
const fullDate = /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g

function hasAscendingRange(title: string): boolean {
  const rangeText = title.replace(fullDate, date => ' '.repeat(date.length))
  const patterns = [
    /(?:^|[^A-Za-z0-9])(?:e(?:p(?:isode)?)?\s*)?(\d{1,3})\s*(?:-|~|–|—|至|到)\s*(?:e(?:p(?:isode)?)?\s*)?(\d{1,3})(?=$|[^A-Za-z0-9])/gi,
    /(?:^|[^A-Za-z0-9])(?:s(?:eason)?\s*)(\d{1,2})\s*(?:-|~|–|—|至|到)\s*(?:s(?:eason)?\s*)?(\d{1,2})(?=$|[^A-Za-z0-9])/gi,
  ]
  return patterns.some(pattern => {
    for (const match of rangeText.matchAll(pattern)) {
      if (Number(match[2]) > Number(match[1])) return true
    }
    return false
  })
}

export function classifyCollection(title: string, sourceConfirmed = false): boolean {
  if (sourceConfirmed) return true
  const normalized = title.normalize('NFKC')
  if (chineseCollection.test(normalized) || completeRelease.test(normalized) || batchRelease.test(normalized)) return true
  if (batchWord.test(normalized) && !batchSingleEpisode.test(normalized)) return true
  const hasRange = hasAscendingRange(normalized)
  return hasRange && (batchWord.test(normalized) || finishedRelease.test(normalized))
}
