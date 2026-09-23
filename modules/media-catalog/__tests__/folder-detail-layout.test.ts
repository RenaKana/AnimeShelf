import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const folderDetailSource = readFileSync(resolve(process.cwd(), 'src/pages/FolderDetail.tsx'), 'utf8')
const fileDetailSource = readFileSync(resolve(process.cwd(), 'src/pages/FileDetail.tsx'), 'utf8')
const mediaCatalogPanelSource = readFileSync(resolve(process.cwd(), 'modules/media-catalog/client/MediaCatalogPanel.tsx'), 'utf8')
const collectionFolderViewSource = readFileSync(resolve(process.cwd(), 'modules/media-catalog/client/CollectionFolderView.tsx'), 'utf8')
const collectionDetailSource = readFileSync(resolve(process.cwd(), 'modules/media-catalog/client/collections/CollectionDetail.tsx'), 'utf8')
const metadataFolderPanelSource = readFileSync(resolve(process.cwd(), 'modules/metadata/client/MetadataFolderPanel.tsx'), 'utf8')
const workGroupSource = readFileSync(resolve(process.cwd(), 'modules/media-catalog/client/media-catalog/MediaCatalogWorkGroups.tsx'), 'utf8')
const directoryListPath = resolve(process.cwd(), 'modules/media-catalog/client/media-catalog/MediaCatalogDirectoryList.tsx')
const directoryListSource = existsSync(directoryListPath) ? readFileSync(directoryListPath, 'utf8') : ''
const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/Sidebar.tsx'), 'utf8')
const mediaCatalogEntrySource = readFileSync(resolve(process.cwd(), 'modules/media-catalog/client.tsx'), 'utf8')
const mediaCatalogSidebarPath = resolve(process.cwd(), 'modules/media-catalog/client/MediaCatalogSidebarSection.tsx')
const mediaCatalogSidebarSource = existsSync(mediaCatalogSidebarPath) ? readFileSync(mediaCatalogSidebarPath, 'utf8') : ''
const selectMenuSource = readFileSync(resolve(process.cwd(), 'src/components/ui/SelectMenu.tsx'), 'utf8')
const dialogBehaviorSource = readFileSync(resolve(process.cwd(), 'src/components/ui/dialogBehavior.ts'), 'utf8')

describe('folder detail layout', () => {
  it('keeps collection navigation behind the media-catalog client contribution', () => {
    expect(sidebarSource).toContain('contribution.sidebarSections')
    expect(sidebarSource).not.toContain('/api/folders?pinned=1')
    expect(sidebarSource).not.toContain('animeshelf:collection-changed')
    expect(mediaCatalogEntrySource).toContain('sidebarSections')
    expect(mediaCatalogSidebarSource).toContain('/api/folders?pinned=1')
    expect(mediaCatalogSidebarSource).toContain("addEventListener('animeshelf:collection-changed'")
    expect(mediaCatalogSidebarSource).toContain('<SidebarSectionLabel>合集</SidebarSectionLabel>')
  })

  it('uses collection wording for pinned folders', () => {
    expect(mediaCatalogPanelSource).toContain("'取消合集'")
    expect(mediaCatalogPanelSource).toContain("'设为合集'")
    expect(collectionDetailSource).toContain('>合集</span>')
    expect(mediaCatalogSidebarSource).toContain('<SidebarSectionLabel>合集</SidebarSectionLabel>')
    expect(mediaCatalogPanelSource).not.toContain('独立分类')
    expect(mediaCatalogSidebarSource).not.toContain('独立分类')
  })

  it('places the contributed season-and-directory section before the core directory and file lists', () => {
    const contentPanelsIndex = folderDetailSource.indexOf('{contentPanels.map')
    const directoriesIndex = folderDetailSource.indexOf('{active.children.length > 0 && (')
    const filesIndex = folderDetailSource.indexOf('{active.files.length > 0 && (')

    expect(mediaCatalogEntrySource).toContain("slot: 'content'")
    expect(contentPanelsIndex).toBeGreaterThan(-1)
    expect(directoriesIndex).toBeGreaterThan(contentPanelsIndex)
    expect(filesIndex).toBeGreaterThan(contentPanelsIndex)
    expect((mediaCatalogPanelSource.match(/<section aria-labelledby="media-catalog-title"/g) ?? [])).toHaveLength(1)
    expect(mediaCatalogPanelSource).toMatch(/<h2[^>]*id="media-catalog-title"[^>]*>[\s\S]*季度与目录[\s\S]*<\/h2>/)
    expect(mediaCatalogPanelSource).not.toContain('季度与子目录')
    expect(mediaCatalogPanelSource).not.toContain('<span>季度清单</span>')
  })

  it('keeps collapse state local to directory and pending controls', () => {
    expect(mediaCatalogPanelSource).not.toContain('catalogCollapsed')
    expect(mediaCatalogPanelSource).not.toContain('readBooleanPref(UI_PREF_KEYS.mediaCatalogOpen)')
    expect(mediaCatalogPanelSource).not.toContain('writePref(UI_PREF_KEYS.mediaCatalogOpen')
    expect(mediaCatalogPanelSource).toContain('重新识别')
    expect(directoryListSource).toMatch(/aria-expanded=/)
    expect(directoryListSource).toMatch(/aria-controls=/)
    expect(directoryListSource).toMatch(/候选目录|待处理目录/)
  })

  it('keeps a stable, wrapping catalog summary visible while collapsed', () => {
    expect(mediaCatalogPanelSource).toContain("const seasonLabel = summary?.season_numbers?.length ? formatSeasonNumbers(summary.season_numbers) : '未指定季号'")
    expect(mediaCatalogPanelSource).toContain('const canonical = shouldUseMediaCatalogWorkGroups(item.pinned, catalog)')
    expect(mediaCatalogPanelSource).toContain('const summary = canonical ? catalog?.summary : visible.media_catalog_summary')
    expect(mediaCatalogPanelSource).toContain('const entryCount = canonical ?')
    expect(mediaCatalogPanelSource).toContain('{summary?.unknown_count ?? 0}')
    expect(mediaCatalogPanelSource).toContain('{summary?.conflict_count ?? 0}')
    expect(mediaCatalogPanelSource).toContain('flex min-w-0 flex-wrap')
    expect(mediaCatalogPanelSource).toContain('>{seasonLabel}</span>')
  })

  it('counts physical directories for ordinary folders', () => {
    expect(mediaCatalogPanelSource).toContain('const directoryRows = useMemo(() => buildMediaCatalogDirectoryRows')
    expect(mediaCatalogPanelSource).toContain("{canonical ? '条目' : '目录'}")
  })

  it('uses collection work groups only for pinned roots and keeps ordinary titles in the flat catalog view', () => {
    expect(mediaCatalogPanelSource).toContain('media_catalog_v2')
    expect(mediaCatalogPanelSource).toContain('<MediaCatalogWorkGroups')
    expect(mediaCatalogPanelSource).toContain('<MediaCatalogDirectoryList')
    expect(workGroupSource).toContain('groupCanonicalMediaWorkGroups')
    expect(mediaCatalogPanelSource).toContain('{canonical && catalog && <MediaCatalogWorkGroups')
    expect(workGroupSource).toContain('canonicalMember.item.source_ids.map')
    expect(workGroupSource).toContain('physicalFolder.folderPath')
    expect(workGroupSource).toContain('legacyGroupByFolderId.get(mapping.folder_id)')
    expect(workGroupSource).toContain('shouldShowCanonicalItemTitle(group.title, group.members.length, canonicalMember.item)')
    expect(workGroupSource).toContain('shouldShowCanonicalMappingFolderName(canonicalMember.item, canonicalMember.mappings, mapping)')
  })

  it('keeps the reversible candidate panel available for both collection and ordinary folders', () => {
    expect(mediaCatalogPanelSource).toContain('showDirectoryRows={!canonical}')
    expect(mediaCatalogPanelSource.indexOf('<MediaCatalogDirectoryList')).toBeGreaterThan(mediaCatalogPanelSource.indexOf('<MediaCatalogWorkGroups'))
    expect(directoryListSource).toContain('showDirectoryRows')
    expect(directoryListSource).toContain('待处理目录')
  })

  it('uses the polished catalog kind menu and supports custom labels', () => {
    expect(mediaCatalogPanelSource).toContain('<SelectMenu')
    expect(directoryListSource).toContain('<SelectMenu')
    expect(workGroupSource).toContain('<SelectMenu')
    expect(mediaCatalogPanelSource).toContain("value: 'custom', label: '自定义'")
    expect(mediaCatalogPanelSource).toContain('directoryCustomLabel')
    expect(directoryListSource).toContain('catalogDraftCustomLabel')
    expect(workGroupSource).toContain('catalogDraftCustomLabel')
    expect(mediaCatalogPanelSource).not.toContain('<select')
  })

  it('keeps outer display metadata choices fully visible in a fixed trigger-width menu', () => {
    const displayMetadataLabelIndex = metadataFolderPanelSource.indexOf('ariaLabel="选择外层展示资料来源"')
    const displayMetadataSelectStart = metadataFolderPanelSource.lastIndexOf('<SelectMenu', displayMetadataLabelIndex)
    const displayMetadataSelectEnd = metadataFolderPanelSource.indexOf('/>', displayMetadataLabelIndex)
    const displayMetadataSelect = displayMetadataSelectStart >= 0 && displayMetadataSelectEnd >= 0
      ? metadataFolderPanelSource.slice(displayMetadataSelectStart, displayMetadataSelectEnd + 2)
      : ''
    expect(displayMetadataSelect).toContain('menuPosition="fixed"')
    expect(displayMetadataSelect).toContain('menuWidth="trigger"')
    expect(displayMetadataSelect).toContain('wrapOptions')
  })

  it('uses neutral custom type placeholders without concrete example labels', () => {
    for (const source of [mediaCatalogPanelSource, directoryListSource, workGroupSource]) {
      expect(source).not.toContain('业、卒、礼、煌、扩')
      expect(source).not.toContain('礼、煌、扩')
    }
  })

  it('shows fixed and custom kind badges for ordinary and collection directories', () => {
    expect(directoryListSource).toContain('mediaCatalogDisplayLabel')
    expect(directoryListSource).toContain('groupTypeLabels')
    expect(workGroupSource).toContain('mappingDisplayLabel')
    expect(workGroupSource).toContain('mapping.custom_label')
  })

  it('removes the old collection-root title editor and keeps a fixed catalog title', () => {
    expect(mediaCatalogPanelSource).toContain('季度与目录')
    expect(mediaCatalogPanelSource).not.toContain('<span>季度清单</span>')
    expect(mediaCatalogPanelSource).not.toContain('catalogTitleEditing')
    expect(mediaCatalogPanelSource).not.toContain('catalogTitleDraft')
    expect(mediaCatalogPanelSource).not.toContain('beginCatalogTitleEdit')
    expect(mediaCatalogPanelSource).not.toContain('runCatalogTitleSave')
    expect(mediaCatalogPanelSource).not.toContain('updateMediaCatalogTitle')
  })

  it('reopens the complete core folder view from collection settings and returns to the collection view', () => {
    expect(collectionDetailSource).toContain('onClick={onSettings}>文件夹设置</Button>')
    expect(collectionFolderViewSource).toContain('onSettings={props.onOpenCoreView}')
    expect(folderDetailSource).toContain('const [coreViewOpen, setCoreViewOpen] = useState(false)')
    expect(folderDetailSource).toContain('onOpenCoreView: () => setCoreViewOpen(true)')
    expect(folderDetailSource).toContain('if (matchingFolderView && !coreViewOpen)')
    expect(folderDetailSource).toContain('matchingFolderView && coreViewOpen')
    expect(folderDetailSource).toContain("matchingFolderView.coreViewReturnLabel ?? '返回模块视图'")
    expect(mediaCatalogEntrySource).toContain("coreViewReturnLabel: '返回合集作品'")
    expect(folderDetailSource).toContain('page-breadcrumb')
    expect(folderDetailSource).toContain('文件夹操作')
    expect(folderDetailSource).toContain('剧情简介')
    expect(folderDetailSource).toContain('{sidebarPanels.map')
    expect(folderDetailSource).toContain('{contentPanels.map')
    expect(folderDetailSource).toContain('{active.children.length > 0 && (')
    expect(folderDetailSource).toContain('{active.files.length > 0 && (')
  })

  it('preserves collection context through child and file navigation with explicit return controls', () => {
    expect(folderDetailSource).toContain('readCollectionRouteContext(searchParams)')
    expect(folderDetailSource).toContain('navigate(withCollectionContext(`/folder/${child.id}`))')
    expect(folderDetailSource).toContain('navigate(withCollectionContext(`/file/${file.id}`))')
    expect(fileDetailSource).toContain("searchParams.get('collection')")
    expect(fileDetailSource).toContain("searchParams.get('entry')")
    expect(fileDetailSource).toContain("searchParams.get('view')")
    expect(fileDetailSource).toContain('返回合集内容')
    expect(fileDetailSource).toContain('返回合集</button>')
    expect(fileDetailSource).toContain('collectionView=${collectionContext.view}')
  })

  it('shows persisted folder watch-state tags in both collection views', () => {
    expect(collectionDetailSource).toContain('/^状态:(未看|在看|看完)$/')
    expect(collectionDetailSource).toContain('collection-status collection-status-existing')
    expect(collectionDetailSource).toContain('status={renderTargetStatus(target, true)}')
    expect(collectionDetailSource).toContain('status={renderTargetStatus(target)}')
    expect(collectionDetailSource).toContain('>确认当前顺序</button>')
    expect(collectionDetailSource).toContain('>编辑顺序</button>')
    expect(collectionDetailSource).toContain('>移除失效引用</Button>')
  })

  it('checks the next linked directory and exposes missing media instead of silently skipping it', () => {
    expect(folderDetailSource).toContain('const nextFolder = await api.folders.get(next.folderId)')
    expect(folderDetailSource).toContain('if (nextFolder.path_missing === 1)')
    expect(folderDetailSource).toContain("status: 'unavailable', reason: '媒体目录已缺失'")
    expect(folderDetailSource).toContain('返回合集处理')
  })

  it('renders independent accessible work-group sections with remembered state and actions', () => {
    expect(workGroupSource).toContain('aria-expanded={workGroupOpen}')
    expect(workGroupSource).toContain("aria-controls={'media-work-group-content-' + group.id}")
    expect(workGroupSource).toContain('人工分组')
    expect(workGroupSource).toContain('合并到…')
    expect(workGroupSource).toContain('移出作品组')
    expect(workGroupSource).toContain('拆分')
    expect(workGroupSource).toContain('api.folders.renameMediaWorkGroup')
    expect(workGroupSource).toContain('api.folders.mergeMediaWorkGroups')
    expect(workGroupSource).toContain('api.folders.detachMediaWorkGroupItem')
    expect(workGroupSource).toContain('api.folders.splitMediaWorkGroup')
    expect(workGroupSource).toContain('setWorkGroupOpen')
    expect(workGroupSource).toContain('splitSelection')
    expect(workGroupSource).toContain('已确认')
    expect(workGroupSource).toContain('自动识别')
    expect(workGroupSource).toContain('group.summary.physical_folder_count')
    expect(workGroupSource).toContain('mediaCatalogWorkGroupMemberStatus')
    expect(workGroupSource).toContain('mediaCatalogPhysicalFolderStatus')
    expect(workGroupSource).toContain("canonicalMember.item.kind !== 'unknown'")
    expect(workGroupSource).toContain("canonicalMember.relation_role !== 'unknown'")
    expect(workGroupSource).not.toContain('{group.members.length > 1 && <Button size="sm" variant="ghost"')
  })

  it('renders detached items in a reversible ungrouped collection section', () => {
    expect(workGroupSource).toContain('groupCanonicalUngroupedMediaItems')
    expect(workGroupSource).toContain('未分组内容')
    expect(workGroupSource).toContain('加入作品组')
    expect(workGroupSource).toContain('api.folders.attachMediaWorkGroupItem')
    expect(workGroupSource).toContain('canonicalUngroupedItems')
  })

  it('shares panel-level catalog busy state across work-group and legacy mutations', () => {
    expect(mediaCatalogPanelSource).toContain('catalogBusy={busy} setCatalogBusy={setBusy}')
    expect(workGroupSource).toContain('setCatalogBusy')
    expect(workGroupSource).not.toContain('useState<WorkGroupBusy>')
    expect(workGroupSource).toContain("setCatalogBusy('rename')")
    expect(workGroupSource).toContain("setCatalogBusy('merge')")
    expect(workGroupSource).toContain("setCatalogBusy('detach')")
    expect(workGroupSource).toContain("setCatalogBusy('split')")
    expect(workGroupSource).toContain('disabled={catalogBusy !== null')
  })

  it('guards catalog responses by the folder that started the request', () => {
    expect(mediaCatalogPanelSource).toContain('shouldApplyMediaCatalogSnapshot(current.id, expectedFolderId)')
    expect(mediaCatalogPanelSource).toContain('applySnapshot(result, expected)')
    expect(workGroupSource).toContain('applyCatalogSnapshot(snapshot, folderId)')
    expect(mediaCatalogPanelSource).toContain('const expected = item.id')
  })

  it('opens and persists a work-group when starting a split', () => {
    expect(workGroupSource).toContain('setWorkGroupOpen(group.id, true)')
  })

  it('shows aggregated member seasons and keeps work-group errors outside the group map', () => {
    expect(workGroupSource).toContain('canonicalMember.seasonNumbers.length > 0')
    expect(workGroupSource).toContain('formatSeasonNumbers(canonicalMember.seasonNumbers)')
    const mutationError = '{error && <div role="alert"'
    expect(workGroupSource.match(new RegExp(mutationError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).toHaveLength(1)
    expect(workGroupSource.indexOf(mutationError)).toBeLessThan(workGroupSource.indexOf('canonicalWorkGroups.map'))
  })

  it('provides explicit save and cancel buttons for inline work-group title editing', () => {
    expect(workGroupSource).toContain('onClick={() => { void saveTitle(group) }}')
    expect(workGroupSource).toContain("catalogBusy === 'rename' ? '保存中…' : '保存'")
    expect(workGroupSource).toContain('onClick={clearEditing}>取消</Button>')
  })

  it('refreshes the contributed collection navigation immediately after pinning changes', () => {
    expect(mediaCatalogPanelSource).toContain("new CustomEvent('animeshelf:collection-changed')")
    expect(mediaCatalogSidebarSource).toContain("addEventListener('animeshelf:collection-changed'")
    expect(mediaCatalogSidebarSource).toContain("removeEventListener('animeshelf:collection-changed'")
  })

  it('exposes reversible catalog candidates and makes catalog badges prominent', () => {
    expect(directoryListSource).toContain('media_catalog_candidates')
    expect(directoryListSource).toContain('添加目录')
    expect(directoryListSource).toContain('添加并设置')
    expect(directoryListSource).toContain('移出清单')
    expect(directoryListSource).toContain("reason === 'excluded'")
    expect(workGroupSource).toContain('canonicalMember.item.season_number')
    expect(directoryListSource).toContain('min-h-8')
  })

  it('closes inline directory detail state with Escape', () => {
    expect(directoryListSource).toContain("event.key !== 'Escape'")
    expect(directoryListSource).toContain('event.defaultPrevented')
    expect(directoryListSource).toContain('setOpenRows(new Set())')
    expect(directoryListSource).toContain('setCatalogEditingFolderId(null)')
  })

  it('lets the portal catalog selector consume Escape before the dialog closes', () => {
    expect(mediaCatalogPanelSource).toContain('closeDisabled: busy !== null')
    expect(dialogBehaviorSource).toContain('if (event.defaultPrevented) return false')
    expect(selectMenuSource).toContain("setOpen(false)\n    triggerRef.current?.focus()")
    expect(selectMenuSource).toContain('event.stopPropagation()')
  })

  it('keeps focus inside the dialog when Tab closes a portaled catalog menu', () => {
    expect(selectMenuSource).toContain("closest<HTMLElement>('[role=\"dialog\"], [aria-modal=\"true\"]')")
    expect(selectMenuSource).toContain('getDialogTabDestination(dialog, trigger, backward)')
    expect(selectMenuSource).toContain('event.preventDefault()')
    expect(selectMenuSource).toContain('event.stopPropagation()')
    expect(selectMenuSource).toContain('destination.focus()')
  })

  it('uses one empty state and treats navigation-only folders as directories instead of pending media', () => {
    expect(folderDetailSource).not.toContain('这个目录暂时没有可显示的媒体文件')
    expect(directoryListSource).toContain("directory: 'border-white/10 bg-white/[0.035] text-text-secondary'")
    expect(directoryListSource).toContain("status === 'directory' ? '目录'")
    expect(directoryListSource).not.toContain('状态为待识别')
  })

  it('collapses candidate detail when cancelling its editor', () => {
    expect(directoryListSource).toContain('closeRow(folderId)')
  })

  it('uses compact navigation rows and a panel-level directory adjustment dialog', () => {
    expect(directoryListSource).not.toContain('media-catalog-directory-')
    expect(directoryListSource).not.toContain('条识别记录')
    expect(directoryListSource).not.toContain('>打开</Button>')
    expect(directoryListSource).toContain('onClick={() => navigate(`/folder/${folderId}`)}')
    expect(directoryListSource).toContain("onClick={() => onDirectoryAdjust(row)}")
    expect(directoryListSource).toContain('onDirectoryAdjust')

    expect(mediaCatalogPanelSource).toContain('dialogOpen')
    expect(mediaCatalogPanelSource).toContain('role="dialog"')
    expect(mediaCatalogPanelSource).toContain('aria-modal="true"')
    expect(mediaCatalogPanelSource).toContain('aria-labelledby="catalog-directory-dialog-title"')
    expect(mediaCatalogPanelSource).toContain('调整目录')
    expect(mediaCatalogPanelSource).toContain('目录名称')
    expect(mediaCatalogPanelSource).toContain('会重命名磁盘文件夹')
    expect(mediaCatalogPanelSource).toContain('关闭目录调整')
    expect(mediaCatalogPanelSource).toContain('nameChanged')
    expect(mediaCatalogPanelSource).toContain('api.folders.rename(directoryFolderId')
    expect(mediaCatalogPanelSource).toContain('api.folders.updateMediaCatalog(directoryFolderId')
    expect(mediaCatalogPanelSource).toMatch(/if \(nameChanged\)[\s\S]*api\.folders\.rename\([\s\S]*if \(catalogChanged\)[\s\S]*applySnapshot\(await api\.folders\.updateMediaCatalog\(/)
    expect(mediaCatalogPanelSource).toContain('dialogRef')
    expect(mediaCatalogPanelSource).toContain('initialFocusRef: nameRef')
    expect(mediaCatalogPanelSource).toContain('triggerRef')
    expect(mediaCatalogPanelSource).toContain('tabIndex={-1}')
    expect(mediaCatalogPanelSource).toContain('磁盘文件夹已重命名，但识别设置保存失败')
    expect(mediaCatalogPanelSource).not.toContain('可展开查看识别结果')
  })
})
