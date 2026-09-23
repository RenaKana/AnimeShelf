import { useEffect, useState } from 'react'
import type { ModuleSettingsProps } from '../../../src/modules/contracts'
import type { Settings } from '../../../src/types'
import Button from '../../../src/components/ui/Button'
import SensitiveInput from '../../../src/components/ui/SensitiveInput'
import { metadataApi } from './api'
import PosterRepairControls from './PosterRepairControls'

export interface MetadataSettingsDraft {
  settings: Settings
  tmdbKeyDraft: string
  clearTmdbKey: boolean
  bangumiTokenDraft: string
  clearBangumiToken: boolean
}

/** Send saved secrets only when the user intentionally changes or clears them. */
export function metadataSettingsPayload(draft: MetadataSettingsDraft): Settings {
  const patch: Settings = {
    auto_match_metadata: draft.settings.auto_match_metadata ?? '',
    proxy_url: draft.settings.proxy_url ?? '',
  }
  if (draft.clearTmdbKey) patch.clear_tmdb_key = '1'
  else if (draft.tmdbKeyDraft.trim()) patch.tmdb_key = draft.tmdbKeyDraft.trim()
  if (draft.clearBangumiToken) patch.clear_bangumi_token = '1'
  else if (draft.bangumiTokenDraft.trim()) patch.bangumi_token = draft.bangumiTokenDraft.trim()
  return patch
}

export default function MetadataSettings({ onRefresh }: ModuleSettingsProps) {
  const [settings, setSettings] = useState<Settings>({})
  const [tmdbKeyDraft, setTmdbKeyDraft] = useState('')
  const [clearTmdbKey, setClearTmdbKey] = useState(false)
  const [bangumiTokenDraft, setBangumiTokenDraft] = useState('')
  const [clearBangumiToken, setClearBangumiToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    metadataApi.getSettings()
      .then(value => { if (active) setSettings(value) })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const set = (key: string, value: string) => setSettings(previous => ({ ...previous, [key]: value }))
  const save = async () => {
    if (saving) return
    setSaving(true); setMessage('')
    try {
      const patch = metadataSettingsPayload({ settings, tmdbKeyDraft, clearTmdbKey, bangumiTokenDraft, clearBangumiToken })
      await metadataApi.updateSettings(patch)
      const nextSettings = { ...settings }
      if (clearTmdbKey) nextSettings.tmdb_key_configured = '0'
      else if (tmdbKeyDraft.trim()) nextSettings.tmdb_key_configured = '1'
      if (clearBangumiToken) nextSettings.bangumi_token_configured = '0'
      else if (bangumiTokenDraft.trim()) nextSettings.bangumi_token_configured = '1'
      setSettings(nextSettings)
      setTmdbKeyDraft('')
      setClearTmdbKey(false)
      setBangumiTokenDraft('')
      setClearBangumiToken(false)
      setMessage('元数据设置已保存')
      onRefresh?.()
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setSaving(false) }
  }
  return <section id="settings-metadata" className="ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="font-semibold">元数据 / 网络</h2><p className="mt-1 text-xs text-text-secondary">配置匹配数据源，并控制扫描后的自动匹配。</p></div>
      <Button size="sm" disabled={loading || saving} onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</Button>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(settings.auto_match_metadata ?? '0') === '1'} disabled={loading || saving} onChange={event => set('auto_match_metadata', event.target.checked ? '1' : '0')} /> 扫描时自动匹配元数据</label>
    <label className="block text-sm text-text-secondary">TMDB API Key（真人影视/中文元数据，可选）
      <SensitiveInput aria-label="TMDB API Key" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" placeholder={settings.tmdb_key_configured === '1' ? '已保存；留空保持不变' : 'https://www.themoviedb.org/settings/api 申请'} value={tmdbKeyDraft} disabled={loading || saving || clearTmdbKey} resetKey={saving ? 'saving' : settings.tmdb_key_configured} onChange={event => { setTmdbKeyDraft(event.target.value); if (event.target.value) setClearTmdbKey(false) }} />
      {settings.tmdb_key_configured === '1' && <span className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={clearTmdbKey} disabled={loading || saving} onChange={event => { setClearTmdbKey(event.target.checked); if (event.target.checked) setTmdbKeyDraft('') }} />清除已保存的 TMDB 密钥</span>}
    </label>
    <label className="block text-sm text-text-secondary">Bangumi Access Token（可选）
      <SensitiveInput aria-label="Bangumi Access Token" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" placeholder={settings.bangumi_token_configured === '1' ? '已保存；留空保持不变' : 'bgm.tv 登录后获取 Access Token'} value={bangumiTokenDraft} disabled={loading || saving || clearBangumiToken} resetKey={saving ? 'saving' : settings.bangumi_token_configured} onChange={event => { setBangumiTokenDraft(event.target.value); if (event.target.value) setClearBangumiToken(false) }} />
      {settings.bangumi_token_configured === '1' && <span className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={clearBangumiToken} disabled={loading || saving} onChange={event => { setClearBangumiToken(event.target.checked); if (event.target.checked) setBangumiTokenDraft('') }} />清除已保存的 Bangumi 令牌</span>}
    </label>
    <label className="block text-sm text-text-secondary">代理地址（留空使用系统代理）<input className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" placeholder="http://127.0.0.1:7897" value={settings.proxy_url ?? ''} disabled={loading || saving} onChange={event => set('proxy_url', event.target.value)} /></label>
    <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-3">
      <PosterRepairControls includeFavorites missingOnly onRefresh={onRefresh} />
      {message && <span role="status" className={message.includes('失败') ? 'text-xs text-red-300' : 'text-xs text-text-secondary'}>{message}</span>}
    </div>
  </section>
}
