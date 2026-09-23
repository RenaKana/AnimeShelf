import type { ClientModule } from '../../src/modules/contracts'
import { ArrowDownIcon } from '../../src/components/ui/Icons'
import DownloadPage from './client/DownloadPage'

export default {
  routes: [{ path: '/download', element: <DownloadPage /> }],
  navItems: [{ to: '/download', label: '下载', icon: <ArrowDownIcon />, order: 28 }],
} satisfies ClientModule
