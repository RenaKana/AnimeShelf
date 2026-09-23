import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CollectionResetDialog from '../client/collections/CollectionResetDialog'

describe('collection reset confirmation', () => {
  it('explains the exact logical reset boundary and requires typed confirmation', () => {
    const html = renderToStaticMarkup(createElement(CollectionResetDialog, {
      rootId: 594, rootName: '物语系列', snapshotVersion: 'version', busy: false,
      onClose: () => {}, onSave: async () => true,
    }))
    expect(html).toContain('物语系列')
    expect(html).toContain('自动和手动分类')
    expect(html).toContain('显示名称与顺序')
    expect(html).toContain('不会删除或移动磁盘文件夹、视频')
    expect(html).toContain('海报和元数据保持不变')
    expect(html).toContain('旧的撤回记录')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>完全重置并重新整理<\/button>/)
  })
})
