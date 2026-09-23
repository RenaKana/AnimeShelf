import ExternalApiSettings from './client/ExternalApiSettings'
import type { ClientModule } from '../../src/modules/contracts'

export default {
  settingsSections: [
    { id: 'settings-external-api', label: '外部 API', order: 80, component: ExternalApiSettings },
  ],
} satisfies ClientModule
