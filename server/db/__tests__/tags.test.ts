import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, ensureSystemTags } from '../schema'
import { makeLibraryDb } from '../libraries'
import { makeFolderDb } from '../folders'
import { makeFileDb } from '../files'
import { makeTagDb } from '../tags'

describe('tags', () => {
  let db: any, lib: any, folderDb: any, fileDb: any, tagDb: any
  beforeEach(() => {
    db = createDb(':memory:')
    ensureSystemTags(db)
    lib = makeLibraryDb(db).create('动漫', 'D:\\Anime', 'anime')
    folderDb = makeFolderDb(db)
    fileDb = makeFileDb(db)
    tagDb = makeTagDb(db)
    folderDb.upsertTree(lib.id, ['D:\\Anime', 'D:\\Anime\\作品A', 'D:\\Anime\\作品A\\S1'])
  })

  it('system tags exist and are protected', () => {
    expect(tagDb.list().filter((t: any) => t.kind === 'system')).toHaveLength(4)
    const sys = tagDb.list().find((t: any) => t.name === '状态:未看')
    expect(() => tagDb.delete(sys.id)).toThrow()
    expect(() => tagDb.update(sys.id, { name: '改名' })).toThrow()
    tagDb.update(sys.id, { color: '#ff0000' }) // 改色允许
  })

  it('links custom tag to folder and inherits down to file', async () => {
    const tag = tagDb.create('待补番')
    const folderA = folderDb.getByLibrary(lib.id).find((f: any) => f.name === '作品A')
    const s1 = folderDb.getByLibrary(lib.id).find((f: any) => f.name === 'S1')
    tagDb.link(tag.id, 'folder', folderA.id)

    fileDb.upsertMany(lib.id, [{ path: 'D:\\Anime\\作品A\\S1\\EP01.mkv', folder_id: s1.id, name: 'EP01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])

    // 作品A 自身有标签
    expect(tagDb.effectiveTags('folder', folderA.id).map((t: any) => t.name)).toContain('待补番')
    // S1（子目录）继承
    expect(tagDb.effectiveTags('folder', s1.id).map((t: any) => t.name)).toContain('待补番')
    // 文件继承：自身标签 + 祖先 folder 标签
    const file = fileDb.getByFolder(s1.id)[0]
    expect(tagDb.effectiveTags('file', file.id).map((t: any) => t.name)).toContain('待补番')
    // 兄弟目录不继承
    const root = folderDb.getByLibrary(lib.id).find((f: any) => f.path === 'D:\\Anime')
    expect(tagDb.effectiveTags('folder', root.id).map((t: any) => t.name)).not.toContain('待补番')
  })

  it('file-level tag does not leak to folder', () => {
    const tag = tagDb.create('已洗版')
    const s1 = folderDb.getByLibrary(lib.id).find((f: any) => f.name === 'S1')
    fileDb.upsertMany(lib.id, [{ path: 'D:\\Anime\\作品A\\S1\\EP01.mkv', folder_id: s1.id, name: 'EP01.mkv', size: 1, date_modified: 1, ext: 'mkv' }])
    const file = fileDb.getByFolder(s1.id)[0]
    tagDb.link(tag.id, 'file', file.id)
    expect(tagDb.effectiveTags('file', file.id).map((t: any) => t.name)).toContain('已洗版')
    expect(tagDb.effectiveTags('folder', s1.id).map((t: any) => t.name)).not.toContain('已洗版')
  })
})
