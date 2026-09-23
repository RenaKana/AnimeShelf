import type { ClientModule } from '../../src/modules/contracts'
import CollectionFolderView from './client/CollectionFolderView'
import MediaCatalogPanel from './client/MediaCatalogPanel'
import MediaCatalogSidebarSection from './client/MediaCatalogSidebarSection'

export default {
  sidebarSections: [
    { id: 'media-catalog-collections', order: 100, component: MediaCatalogSidebarSection },
  ],
  folderPanels: [
    { id: 'media-catalog-panel', slot: 'content', component: MediaCatalogPanel },
  ],
  folderViews: [
    { id: 'collection-view', matches: folder => folder.pinned === 1, component: CollectionFolderView, coreViewReturnLabel: '返回合集作品' },
  ],
} satisfies ClientModule
