import type { ClientModule } from '../../src/modules/contracts'
import AppBackground from './client/AppBackground'
import WallpaperSettings from './client/WallpaperSettings'

export default {
  settingsSections: [{ id: 'settings-wallpapers', label: '背景与壁纸', group: 'appearance', order: 45, component: WallpaperSettings }],
  Background: AppBackground,
} satisfies ClientModule
