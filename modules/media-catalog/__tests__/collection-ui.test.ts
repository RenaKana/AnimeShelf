import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { FolderDetail } from '../../../src/types'
import { describe, expect, it } from 'vitest'
import type { CollectionGroup, CollectionWork } from '../client/collectionNavigation'

const work: CollectionWork = {
  type: 'work', key: 'item:x', orderKey: 'item:x', title: '伤物语 铁血篇', label: '剧场版', sortName: '12伤物语',
  item: { id: 12, library_id: 1, root_folder_id: 1, item_key: 'x', title: '伤物语 铁血篇', title_zh: null, kind: 'movie', season_number: null, part_number: null, manual_locked: 0, confidence: 1, conflict_reason: null, source_ids: [] },
  group: null, folders: [{ id: 12, name: 'BD 1080p', path: '物语/BD 1080p', mappings: [] }],
}
describe('collection work list', () => {
  it('gives collections a compact header, work/folder navigation and no aggregate season heading', async () => {
    const { default: Detail } = await import('../client/collections/CollectionDetail')
    const item: FolderDetail = { id: 1, name: '物语系列', path: 'D:/Anime/物语', library_id: 1, parent_id: null, pinned: 1, is_series: 1, anilist_id: null, has_poster: 0, size: 0, file_count: 0, tags: [], created_at: '', updated_at: '', children: [], files: [], media_catalog: [], media_catalog_summary: null, media_catalog_candidates: [], media_catalog_v2: null }
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(Detail, { item, onRefresh: async () => {}, onSettings: () => {} })))
    expect(html).toContain('物语系列')
    expect(html).toContain('观看顺序')
    expect(html).toContain('系列结构')
    expect(html).toContain('浏览文件夹')
    expect(html).not.toContain('AI 整理')
    expect(html).not.toContain('未指定季号')
    expect(html).not.toContain('季度与子目录')
  })
  it('separates display-name editing from physical directories and keeps season optional', async () => {
    const { default: Editor } = await import('../client/collections/CollectionEditor')
    const html = renderToStaticMarkup(createElement(Editor, { rootId: 1, work, groups: [], busy: false, onClose: () => {}, onSave: async () => true }))
    expect(html).toContain('显示名称')
    expect(html).toContain('不会重命名磁盘文件夹')
    expect(html).toContain('关联目录')
    expect(html).toContain('所属分组')
  })
  it('uses a compact named work row and hides management controls in browsing mode', async () => {
    const { default: List } = await import('../client/collections/CollectionWorkList')
    const html = renderToStaticMarkup(createElement(List, { rows: [work], onOpen: () => {} }))
    expect(html).toContain('伤物语 铁血篇')
    expect(html).toContain('剧场版')
    expect(html).not.toContain('S1')
    expect(html).not.toContain('调整作品')
    expect(html).toContain('打开伤物语 铁血篇')
  })
  it('renders an existing watch-state tag in the shared work row', async () => {
    const { CollectionWorkItem } = await import('../client/collections/CollectionWorkList')
    const status = createElement('span', { className: 'collection-status collection-status-existing' }, ' · 状态:在看')
    const html = renderToStaticMarkup(createElement(CollectionWorkItem, { work, onOpen: () => {}, status }))
    expect(html).toContain('collection-status-existing')
    expect(html).toContain('状态:在看')
    expect(html).toContain('伤物语 铁血篇')
  })

  it('puts multiple versions behind a disclosure and shows reorder only in manage mode', async () => {
    const { default: List } = await import('../client/collections/CollectionWorkList')
    const row = { ...work, folders: [...work.folders, { ...work.folders[0], id: 13, name: 'BD 2160p' }] }
    const html = renderToStaticMarkup(createElement(List, { rows: [row], manage: true, onOpen: () => {}, onEdit: () => {}, onMove: () => {} }))
    expect(html).toContain('<details')
    expect(html).toContain('2 个目录')
    expect(html).toContain('调整作品')
    expect(html).toContain('上移伤物语 铁血篇')
    expect(html).toContain('BD 2160p')
  })
  it('shows one collapsible group for multiple members rather than repeated folder headings', async () => {
    const { default: List } = await import('../client/collections/CollectionWorkList')
    const group = { type: 'group', key: 'group:1', orderKey: 'group:1', title: '伤物语', label: '2 部作品', sortName: '伤物语', group: { id: 1 }, works: [work, { ...work, key: 'item:y', title: '伤物语 热血篇' }] } as CollectionGroup
    const html = renderToStaticMarkup(createElement(List, { rows: [group] }))
    expect(html).toContain('<summary')
    expect(html).toContain('伤物语 热血篇')
    expect(html).not.toContain('作品组→')
  })
})
