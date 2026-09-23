import { useState } from 'react'
import SegmentedControl from '../ui/SegmentedControl'
import { setMotionLevel, useMotion, type MotionLevel } from '../../lib/motion'

export default function MotionControl() {
  const { level, reduced } = useMotion()
  const [error, setError] = useState('')
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-text-secondary">动画效果</span>
      <SegmentedControl<MotionLevel> value={level} ariaLabel="动画效果" options={[
        { value: 'minimal', label: '近乎无动画' }, { value: 'balanced', label: '适量动画' }, { value: 'rich', label: '丰富动画' },
      ]} onChange={value => setError(setMotionLevel(value) ? '' : '已在当前窗口生效，但无法保存到本机。')} />
    </div>
    <p className="text-xs text-text-secondary">近乎无动画：即时切换；适量：短暂淡入淡出；丰富：增加按压、菜单和侧栏位移反馈。立即生效。{reduced && ' 系统已开启减少动态效果，将优先减少位移和缩放。'}</p>
    {error && <p role="status" className="text-xs text-amber-300">{error}</p>}
  </div>
}
