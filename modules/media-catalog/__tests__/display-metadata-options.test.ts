import { describe, expect, it } from 'vitest'
import { displayMetadataOptions, selectedDisplayMetadataValue } from '../../metadata/client/displayMetadata'

describe('display metadata options', () => {
  const candidates = [
    { id: 10, name: '作品', path: 'D:\\Anime\\作品', kind: 'self' as const, depth: 0, hasMetadata: false },
    { id: 11, name: '第一季', path: 'D:\\Anime\\作品\\第一季', kind: 'season' as const, depth: 1, hasMetadata: true },
    { id: 12, name: 'SPs', path: 'D:\\Anime\\作品\\SPs', kind: 'extras' as const, depth: 1, hasMetadata: true },
  ]

  it('labels automatic, season and extras choices clearly', () => {
    expect(displayMetadataOptions(candidates, '第一季', true)).toEqual([
      { value: 'auto', label: '自动（当前：第一季）' },
      { value: '10', label: '当前目录 · 作品 · 无元数据' },
      { value: '11', label: '季度 · 第一季' },
      { value: '12', label: '附加内容 · SPs' },
    ])
  })

  it('states when automatic selection has no usable metadata', () => {
    expect(displayMetadataOptions(candidates, '作品', false)[0]).toEqual({
      value: 'auto',
      label: '自动（当前未找到可用资料）',
    })
  })

  it('distinguishes automatic selection from an explicit folder', () => {
    expect(selectedDisplayMetadataValue(null)).toBe('auto')
    expect(selectedDisplayMetadataValue(11)).toBe('11')
  })

  it('reports whether automatic selection actually found metadata', async () => {
    const module = await import('../../metadata/client/displayMetadata') as any
    expect(module.automaticDisplayMetadataNotice).toBeTypeOf('function')
    if (typeof module.automaticDisplayMetadataNotice !== 'function') return

    expect(module.automaticDisplayMetadataNotice(true)).toBe('已恢复自动选择展示资料')
    expect(module.automaticDisplayMetadataNotice(false))
      .toBe('已切换自动模式，但未找到唯一可用的展示资料，请手动选择')
  })
})
