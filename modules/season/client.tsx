import type { ClientModule } from '../../src/modules/contracts'
import { CalendarIcon, StarIcon } from '../../src/components/ui/Icons'
import SeasonCalendar from './client/SeasonCalendar'
import FavoritesView from './client/FavoritesView'
import SeasonSettings from './client/SeasonSettings'
import { favoritesService } from './client/favoritesService'

export default {
  routes: [
    { path: '/season', element: <SeasonCalendar /> },
    { path: '/favorites', element: <FavoritesView /> },
  ],
  navItems: [
    { to: '/season', label: '追番', icon: <CalendarIcon />, order: 20 },
    { to: '/favorites', label: '心愿单', icon: <StarIcon />, order: 30 },
  ],
  settingsSections: [{ id: 'settings-season-display', label: '心愿单显示', order: 50, component: SeasonSettings }],
  services: { 'season.favorites': favoritesService },
} satisfies ClientModule
