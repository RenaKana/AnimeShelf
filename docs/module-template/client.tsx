import type { ClientModule } from '../../src/modules/contracts'

function SampleSettings() {
  return <section id="sample-settings" className="ui-panel rounded-2xl p-5">
    <h2 className="font-semibold">示例模块设置</h2>
    <p className="mt-2 text-sm text-text-secondary">在模块内添加设置控件。</p>
  </section>
}

export default {
  routes: [{ path: '/sample', element: <p>示例模块页面</p> }],
  navItems: [{ to: '/sample', label: '示例模块', icon: <span>◇</span>, order: 90 }],
  settingsSections: [{ id: 'sample-settings', label: '示例模块', component: SampleSettings }],
} satisfies ClientModule
