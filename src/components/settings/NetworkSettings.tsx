import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../../types'
import { api } from '../../api'
import Button from '../ui/Button'
import SegmentedControl from '../ui/SegmentedControl'

export type ProxyMode = 'system' | 'manual' | 'direct'

export interface ProxyStatus {
  mode: ProxyMode
  source: ProxyMode
  proxyUrl?: string
  message: string
  error?: { code: string; message: string }
}

const MODE_OPTIONS: { value: ProxyMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'manual', label: '手动代理' },
  { value: 'direct', label: '直连' },
]
const SOURCE_LABELS: Record<ProxyMode, string> = {
  system: 'Windows 系统设置',
  manual: '手动地址',
  direct: '直连',
}

export function resolveProxyMode(settings: Settings): ProxyMode {
  if (settings.proxy_mode === 'manual' || settings.proxy_mode === 'direct' || settings.proxy_mode === 'system') {
    return settings.proxy_mode
  }
  return settings.proxy_url?.trim() || settings.proxy_url_configured === '1' ? 'manual' : 'system'
}

export function networkSettingsPayload(mode: ProxyMode, proxyUrl: string): Settings {
  return mode === 'manual'
    ? { proxy_mode: mode, proxy_url: proxyUrl.trim() }
    : { proxy_mode: mode, proxy_url: '' }
}

async function readProxyStatus(): Promise<ProxyStatus> {
  const response = await fetch('/api/settings/proxy-status', { cache: 'no-store' })
  const value = await response.json() as ProxyStatus & { error?: ProxyStatus['error'] | string }
  if (!response.ok) {
    const message = typeof value.error === 'string' ? value.error : value.error?.message
    throw new Error(message || '代理状态读取失败（' + response.status + '）')
  }
  return value
}

export default function NetworkSettings() {
  const [mode, setMode] = useState<ProxyMode>('system')
  const [proxyUrlDraft, setProxyUrlDraft] = useState('')
  const [proxyUrlHidden, setProxyUrlHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')

  const refreshStatus = useCallback(async () => {
    setStatusError('')
    try {
      setProxyStatus(await readProxyStatus())
    } catch (error) {
      setProxyStatus(null)
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    let active = true
    api.settings.get()
      .then(settings => {
        if (!active) return
        setMode(resolveProxyMode(settings))
        setProxyUrlDraft(settings.proxy_url ?? '')
        setProxyUrlHidden(settings.proxy_url_configured === '1' && !settings.proxy_url)
      })
      .catch(error => {
        if (active) setSettingsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { if (active) setLoading(false) })
    void refreshStatus()
    return () => { active = false }
  }, [refreshStatus])

  const save = async () => {
    if (saving || loading) return
    setSaving(true)
    setSavedMessage('')
    setSaveError('')
    try {
      await api.settings.update(networkSettingsPayload(mode, proxyUrlDraft))
      setProxyUrlHidden(false)
      setSavedMessage('代理设置已保存')
      await refreshStatus()
    } catch (error) {
      setSaveError('保存失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="settings-network" className="ui-panel scroll-mt-4 space-y-3 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">网络</h2>
        <Button size="sm" disabled={loading || saving} onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</Button>
      </div>
      <fieldset disabled={loading || saving} className="space-y-3">
        <SegmentedControl
          value={mode}
          options={MODE_OPTIONS}
          ariaLabel="代理模式"
          onChange={value => { setMode(value); setSavedMessage(''); setSaveError('') }} />
        {mode === 'manual' && (
          <label className="block text-sm text-text-secondary">
            HTTP(S) 代理地址
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-primary"
              placeholder="http://127.0.0.1:7897"
              title={proxyUrlHidden ? '旧代理地址已隐藏，请重新填写' : undefined}
              value={proxyUrlDraft}
              aria-invalid={Boolean(saveError) || undefined}
              onChange={event => { setProxyUrlDraft(event.target.value); setProxyUrlHidden(false); setSavedMessage(''); setSaveError('') }} />
          </label>
        )}
        {mode === 'manual' && proxyUrlHidden && <p role="note" className="text-xs text-amber-200">旧代理地址已隐藏，可能包含不支持的信息。请重新填写 HTTP(S) 地址。</p>}
      </fieldset>
      <p className="text-xs leading-relaxed text-text-secondary">系统模式使用 Windows 已启用的静态代理和绕过规则。手动模式仅支持 HTTP(S)，不支持代理认证、SOCKS 或 PAC。</p>
      <p className="text-xs leading-relaxed text-text-secondary">本机服务直连；浏览器和 Wallpaper Engine 内嵌网页由宿主管理。代理错误会显示，不会静默改为直连。</p>
      {settingsError && <p role="alert" className="text-xs text-red-300">读取代理设置失败：{settingsError}</p>}
      {proxyStatus && (
        <>
          <p role={proxyStatus.error ? 'alert' : 'status'} className={proxyStatus.error ? 'text-xs text-red-300' : 'text-xs text-text-secondary'}>
            {proxyStatus.error?.message ?? proxyStatus.message}
          </p>
          {!proxyStatus.error && <p className="break-all text-xs text-text-secondary">配置来源：{SOURCE_LABELS[proxyStatus.source]}{proxyStatus.proxyUrl ? ' · ' + proxyStatus.proxyUrl : ''}</p>}
        </>
      )}
      {statusError && <p role="alert" className="text-xs text-red-300">{statusError}</p>}
      {saveError && <p role="alert" className="text-xs text-red-300">{saveError}</p>}
      {savedMessage && <p role="status" className="text-xs text-emerald-300">{savedMessage}</p>}
    </section>
  )
}
