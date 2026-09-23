import type { ClientModule } from '../../src/modules/contracts'
import MetadataFolderPanel from './client/MetadataFolderPanel'
import MetadataLibraryActions from './client/MetadataLibraryToolbar'
import MetadataSettings from './client/MetadataSettings'

export default {
  settingsSections: [
    { id: 'settings-metadata', label: '元数据', order: 20, component: MetadataSettings },
  ],
  folderPanels: [
    { id: 'metadata-folder-controls', slot: 'sidebar', component: MetadataFolderPanel },
  ],
  libraryActions: [
    { id: 'metadata-library-actions', component: MetadataLibraryActions },
  ],
} satisfies ClientModule
