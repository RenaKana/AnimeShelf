import { describe, expect, it } from 'vitest'
import { queryString } from '../../../src/api'
import { libraryScanMessage, retainResultSelection, scanResultMessage } from '../../../src/lib/libraryScan'

describe('scan-aware library client', () => {
  it('encodes repeated filters without splitting tag names containing commas', () => {
    const params = new URLSearchParams(queryString({ tag: ['喜剧,冒险', '收藏'], status: ['状态:未看', '追番中'], libraryId: [4, 6], tagMatch: 'all' }))
    expect(params.getAll('tag')).toEqual(['喜剧,冒险', '收藏'])
    expect(params.getAll('libraryId')).toEqual(['4', '6'])
    expect(params.getAll('status')).toHaveLength(2)
    expect(queryString({ libraryId: 4 })).toBe('?libraryId=4')
  })
  it('never widens a selection when new results arrive', () => {
    const previous = new Set([1, 2])
    expect([...retainResultSelection(previous, [2, 3, 4])]).toEqual([2])
    expect(retainResultSelection(previous, [1, 2, 3])).toBe(previous)
    expect([...retainResultSelection(previous, [])]).toEqual([])
  })
  it('does not describe incomplete or failed scans as completed', () => {
    const result = { added: 0, updated: 0, removed: 0, errors: ['结果不完整'] }
    expect(scanResultMessage(result)).toContain('扫描未完成')
    expect(scanResultMessage(result)).not.toContain('扫描完成')
    expect(scanResultMessage({ ...result, errors: [], moved: 2, missing: 1 })).toContain('移动 2，缺失 1')
  })
  it('keeps waits and retries visible without treating them as terminal failures', () => {
    const base = { libraryId: 1, revision: 0, sequence: 1, reason: 'watch' as const }
    expect(libraryScanMessage([{ ...base, status: 'waiting', waitingReason: 'maintenance' }])).toBe('等待当前维护任务完成后扫描')
    expect(libraryScanMessage([{ ...base, status: 'waiting', waitingReason: 'filesystem_changed' }])).toBe('等待目录稳定后扫描')
    expect(libraryScanMessage([{ ...base, status: 'waiting', waitingReason: 'retry', error: '索引不完整' }])).toContain('索引不完整；稍后自动重试')
    expect(libraryScanMessage([{ ...base, status: 'scanning', waitingReason: 'retry', error: '索引不完整' }])).toContain('索引不完整；正在重新扫描')
    expect(libraryScanMessage([{ ...base, status: 'queued', waitingReason: 'retry', error: '索引不完整' }])).toContain('索引不完整；等待重新扫描')
    expect(libraryScanMessage([{ ...base, status: 'complete', result: { added: 0, updated: 0, removed: 0, errors: [], changed: false } }])).toBe('')
    expect(scanResultMessage({ added: 0, updated: 0, removed: 0, errors: ['占用'], code: 'LIBRARY_BUSY' })).not.toContain('未完成')
  })
})
