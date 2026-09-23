import { useState } from 'react'
import type { MediaCatalogKind, MediaCatalogManualPayload } from '../../../../src/types'
import { collectionClassification } from '../collectionNavigation'
import Button from '../../../../src/components/ui/Button'
import SelectMenu from '../../../../src/components/ui/SelectMenu'

export default function CollectionClassificationForm({ initial, busy, onSave }: { initial: MediaCatalogManualPayload; busy: boolean; onSave: (body: MediaCatalogManualPayload) => Promise<boolean> }) {
  const [kind, setKind] = useState<MediaCatalogKind | 'tv'>(initial.kind === 'season' || initial.kind === 'custom' && initial.customLabel === 'TV' ? 'tv' : initial.kind)
  const [seasons, setSeasons] = useState(initial.seasonNumbers?.join(',') ?? '')
  const [part, setPart] = useState(initial.partNumber ? String(initial.partNumber) : '')
  const [custom, setCustom] = useState(initial.customLabel ?? '')
  const [error, setError] = useState('')
  const submit = async () => {
    setError('')
    try { await onSave(collectionClassification(kind, seasons, part, custom)) } catch (e) { setError(e instanceof Error ? e.message : '请检查输入') }
  }
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2 min-w-0"><span className="mb-1 block text-xs text-text-secondary">类型</span><SelectMenu value={kind} onChange={setKind} disabled={busy} ariaLabel="作品类型" className="w-full" minWidthClass="min-w-0" menuPosition="fixed" menuWidth="trigger" size="md" options={[{ value: 'tv', label: 'TV / 季度' }, { value: 'movie', label: '剧场版' }, { value: 'ova', label: 'OVA' }, { value: 'special', label: 'SP' }, { value: 'custom', label: '自定义' }, { value: 'extras', label: '附加内容' }, { value: 'unknown', label: '暂不分类' }]} /></div>
      {kind === 'custom' && <label className="col-span-2 min-w-0 text-xs text-text-secondary">自定义类型<input aria-label="自定义类型名称" className="input mt-1" value={custom} maxLength={32} onChange={event => setCustom(event.target.value)} disabled={busy} required /></label>}
      {kind === 'tv' && <label className="min-w-0 text-xs text-text-secondary">季号（可空）<input aria-label="作品季号" className="input mt-1" value={seasons} placeholder="1,2" onChange={event => setSeasons(event.target.value)} disabled={busy} /></label>}
      <label className="min-w-0 text-xs text-text-secondary">Part（可空）<input aria-label="作品 Part" className="input mt-1" value={part} inputMode="numeric" onChange={event => setPart(event.target.value)} disabled={busy} /></label>
    </div>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    <Button type="submit" size="sm" disabled={busy}>保存类型</Button>
  </form>
}
