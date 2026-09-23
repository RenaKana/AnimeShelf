import { expect, it, vi } from 'vitest'
import { createDb } from '../schema'
import { makeFileDb, type FileUpsert } from '../files'
import { makeFolderDb, type FolderUpsert } from '../folders'
import { makeLibraryDb } from '../libraries'
import { makeSettingsDb } from '../settings'

it('bounds and finalizes statements across repeated bulk upserts without changing no-op semantics', () => {
  const db = createDb(':memory:')
  const active = new Set<ReturnType<typeof db.prepare>>()
  let prepared = 0
  let finalized = 0
  const originalPrepare = db.prepare.bind(db)
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = originalPrepare(sql)
    const originalFinalize = statement.finalize.bind(statement)
    prepared++
    active.add(statement)
    statement.finalize = () => {
      originalFinalize()
      finalized++
      active.delete(statement)
    }
    return statement
  })

  try {
    const libraries = makeLibraryDb(db)
    const settings = makeSettingsDb(db)
    const folders = makeFolderDb(db)
    const files = makeFileDb(db)
    const library = libraries.create('Bulk lifecycle', 'D:\\Bulk', 'anime')
    settings.set('bulk_lifecycle', 'enabled')
    expect(settings.get('bulk_lifecycle')).toBe('enabled')
    expect(settings.getAll()).toEqual({ bulk_lifecycle: 'enabled' })

    const folderPaths = ['D:\\Bulk', 'D:\\Bulk\\Show', 'D:\\Bulk\\Show\\Season 1']
    const firstFolderStart = { prepared, finalized }
    folders.upsertTree(library.id, folderPaths)
    expect({ prepared: prepared - firstFolderStart.prepared, finalized: finalized - firstFolderStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })

    const fixedTimestamp = '2001-01-01 00:00:00'
    db.run('UPDATE folders SET updated_at = ? WHERE library_id = ?', [fixedTimestamp, library.id])
    db.run("UPDATE folders SET name = 'Custom Show', renamed = 1 WHERE path = ?", folderPaths[1])
    const identifiedFolders: FolderUpsert[] = folderPaths.map((path, index) => ({
      path,
      filesystem_identity: `folder-${index}`,
    }))
    const secondFolderStart = { prepared, finalized }
    const bootstrappedFolders = folders.upsertTree(library.id, identifiedFolders)
    expect({ prepared: prepared - secondFolderStart.prepared, finalized: finalized - secondFolderStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })
    expect(bootstrappedFolders.map(folder => ({
      path: folder.path,
      name: folder.name,
      renamed: folder.renamed,
      identity: folder.filesystem_identity,
      updatedAt: folder.updated_at,
    }))).toEqual([
      { path: folderPaths[0], name: 'Bulk', renamed: 0, identity: 'folder-0', updatedAt: fixedTimestamp },
      { path: folderPaths[1], name: 'Custom Show', renamed: 1, identity: 'folder-1', updatedAt: fixedTimestamp },
      { path: folderPaths[2], name: 'Season 1', renamed: 0, identity: 'folder-2', updatedAt: fixedTimestamp },
    ])

    const thirdFolderStart = { prepared, finalized }
    expect(folders.upsertTree(library.id, identifiedFolders)).toEqual(bootstrappedFolders)
    expect({ prepared: prepared - thirdFolderStart.prepared, finalized: finalized - thirdFolderStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })

    const seasonId = bootstrappedFolders[2].id
    const filePaths = ['01.mkv', '02.mkv', '03.mkv'].map(name => `D:\\Bulk\\Show\\Season 1\\${name}`)
    const initialFiles: FileUpsert[] = filePaths.map((path, index) => ({
      path,
      folder_id: seasonId,
      name: `${String(index + 1).padStart(2, '0')}.mkv`,
      size: 100 + index,
      date_modified: 1000 + index,
      ext: 'mkv',
    }))
    const firstFileStart = { prepared, finalized }
    expect(files.upsertMany(library.id, initialFiles)).toEqual({ added: 3, updated: 0 })
    expect({ prepared: prepared - firstFileStart.prepared, finalized: finalized - firstFileStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })

    db.run('UPDATE files SET updated_at = ? WHERE library_id = ?', [fixedTimestamp, library.id])
    const identifiedFiles = initialFiles.map((file, index) => ({ ...file, filesystem_identity: `file-${index}` }))
    const secondFileStart = { prepared, finalized }
    expect(files.upsertMany(library.id, identifiedFiles)).toEqual({ added: 0, updated: 0 })
    expect({ prepared: prepared - secondFileStart.prepared, finalized: finalized - secondFileStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })
    const bootstrappedFiles = files.getByFolder(seasonId)
    expect(bootstrappedFiles.map(file => ({
      path: file.path,
      identity: file.filesystem_identity,
      updatedAt: file.updated_at,
    }))).toEqual(filePaths.map((path, index) => ({
      path,
      identity: `file-${index}`,
      updatedAt: fixedTimestamp,
    })))

    const thirdFileStart = { prepared, finalized }
    expect(files.upsertMany(library.id, identifiedFiles)).toEqual({ added: 0, updated: 0 })
    expect({ prepared: prepared - thirdFileStart.prepared, finalized: finalized - thirdFileStart.finalized })
      .toEqual({ prepared: 2, finalized: 2 })
    expect(files.getByFolder(seasonId)).toEqual(bootstrappedFiles)

    expect(libraries.getById(library.id)).toEqual(library)
    expect(libraries.getAll()).toEqual([library])
    expect(folders.getById(seasonId)).toEqual(bootstrappedFolders[2])
    expect(folders.getChildren(bootstrappedFolders[1].id)).toEqual([bootstrappedFolders[2]])
    expect(files.getById(bootstrappedFiles[0].id)).toEqual(bootstrappedFiles[0])
    expect(folders.deleteMissing(library.id, new Set(folderPaths))).toBe(0)
    expect(files.deleteMissing(library.id, new Set(filePaths))).toBe(0)
    expect(prepared).toBe(finalized)
    expect(active.size).toBe(0)
  } finally {
    prepareSpy.mockRestore()
    for (const statement of active) {
      if (!statement.isFinalized) statement.finalize()
    }
    db.close()
  }
})
