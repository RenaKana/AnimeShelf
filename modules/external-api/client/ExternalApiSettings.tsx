import { useEffect, useRef, useState } from 'react'
import type { ExternalApiStatus, ExternalApiTokenInfo } from '../../../shared/external-api'
import { getExternalApiStatus, updateExternalApiConfig } from './externalApiClient'
import Button from '../../../src/components/ui/Button'
import ExternalApiTokenManager from './ExternalApiTokenManager'

const DEFAULT_PORT = '3003'

function statusPresentation(status: ExternalApiStatus | null): { label: string; className: string } {
  if (!status) return { label: '状态未知', className: 'text-text-secondary' }
  if (status.status === 'running') return { label: '正在运行', className: 'text-emerald-300' }
  if (status.status === 'error') return { label: '启动失败', className: 'text-red-300' }
  return { label: status.enabled ? '未运行' : '已停用', className: 'text-text-secondary' }
}

export default function ExternalApiSettings() {
  const [status, setStatus] = useState<ExternalApiStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const aliveRef = useRef(true)
  const loadRequestRef = useRef(0)
  const configDirtyRef = useRef(false)
  const loadControllerRef = useRef<AbortController | null>(null)
  const saveControllerRef = useRef<AbortController | null>(null)
  const savingRef = useRef(false)

  const load = async () => {
    const requestId = ++loadRequestRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true); setLoadError('')
    try {
      const next = await getExternalApiStatus(controller.signal)
      if (!aliveRef.current || controller.signal.aborted || requestId !== loadRequestRef.current) return
      setStatus(next)
      if (!configDirtyRef.current) { setEnabled(next.enabled); setPort(String(next.port)) }
    } catch (reason) {
      if (aliveRef.current && !controller.signal.aborted && requestId === loadRequestRef.current) {
        setLoadError(reason instanceof Error ? reason.message : '外部 API 状态读取失败')
      }
    } finally {
      if (aliveRef.current && requestId === loadRequestRef.current) setLoading(false)
      if (loadControllerRef.current === controller) loadControllerRef.current = null
    }
  }

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => {
      aliveRef.current = false
      loadRequestRef.current += 1
      loadControllerRef.current?.abort()
      saveControllerRef.current?.abort()
    }
    // Initial owner-status request only; retries are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateDraft = (patch: { enabled?: boolean; port?: string }) => {
    configDirtyRef.current = true
    if (patch.enabled !== undefined) setEnabled(patch.enabled)
    if (patch.port !== undefined) setPort(patch.port)
    setSaveError('')
  }

  const saveConfig = async () => {
    if (savingRef.current) return
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) {
      setSaveError('端口必须是 1024 到 65535 之间的整数')
      return
    }
    const controller = new AbortController()
    saveControllerRef.current = controller
    savingRef.current = true
    setSaving(true); setSaveError(''); setCopyMessage('')
    try {
      const next = await updateExternalApiConfig({ enabled, port: numericPort }, controller.signal)
      if (!aliveRef.current || controller.signal.aborted) return
      setStatus(current => current ? { ...next, tokens: current.tokens } : next)
      setEnabled(next.enabled); setPort(String(next.port)); configDirtyRef.current = false
      if (next.status === 'error') setSaveError(next.error || '外部 API 未能启动')
    } catch (reason) {
      if (aliveRef.current && !controller.signal.aborted) setSaveError(reason instanceof Error ? reason.message : '外部 API 设置保存失败')
    } finally {
      savingRef.current = false
      if (aliveRef.current) setSaving(false)
      if (saveControllerRef.current === controller) saveControllerRef.current = null
    }
  }

  const copyBaseUrl = async () => {
    if (!status?.base_url) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(status.base_url)
      if (aliveRef.current) setCopyMessage('地址已复制')
    } catch {
      if (aliveRef.current) setCopyMessage('无法自动复制，请手动选择地址')
    }
  }

  const updateTokens = (update: (current: ExternalApiTokenInfo[]) => ExternalApiTokenInfo[]) => {
    setStatus(current => current ? { ...current, tokens: update(current.tokens) } : current)
  }

  const presented = statusPresentation(status)
  const controlsDisabled = loading || !status

  return (
    <section id="settings-external-api" className="ui-panel scroll-mt-4 space-y-4 rounded-2xl border border-white/10 bg-[#111722]/88 p-4 shadow-[0_14px_36px_rgba(0,0,0,0.14)] backdrop-blur-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><h2 className="font-semibold">外部 API</h2><p className="mt-1 text-xs leading-5 text-text-secondary">仅监听本机 127.0.0.1，供可信的本地自动化程序访问。应用退出后接口不可用。</p></div>
        <Button size="sm" variant="primary" disabled={controlsDisabled || saving} onClick={() => { void saveConfig() }}>{saving ? '保存中…' : '保存设置'}</Button>
      </div>

      {loading && <div role="status" className="rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2 text-sm text-text-secondary">正在读取外部 API 状态…</div>}
      {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300/15 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200"><span>{loadError}</span><Button size="sm" variant="ghost" onClick={() => { void load() }}>重试</Button></div>}

      <div className="grid gap-3 rounded-xl border border-white/[0.07] bg-black/15 p-3 sm:grid-cols-[minmax(0,1fr)_140px] xl:grid-cols-[minmax(0,1fr)_140px_minmax(220px,1fr)] sm:items-end">
        <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={controlsDisabled || saving} onChange={event => updateDraft({ enabled: event.target.checked })} className="h-4 w-4 accent-accent" /><span>启用专用外部接口</span></label>
        <label className="text-xs text-text-secondary">端口<input type="number" min={1024} max={65535} step={1} value={port} disabled={controlsDisabled || saving} onChange={event => updateDraft({ port: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-bg px-3 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-50" /></label>
        <div className="min-w-0 text-xs text-text-secondary sm:col-span-2 xl:col-span-1"><div>实际状态：<strong className={presented.className}>{presented.label}</strong></div><div className="mt-1 flex min-w-0 items-center gap-2"><input readOnly aria-label="外部 API 基础地址" value={status?.base_url ?? `http://127.0.0.1:${port || DEFAULT_PORT}/api/v1`} onFocus={event => event.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-bg px-2 font-mono text-[11px] text-text-primary outline-none focus:border-accent" /><Button size="sm" disabled={!status?.base_url} onClick={() => { void copyBaseUrl() }}>复制</Button></div></div>
      </div>
      {(saveError || status?.error) && <div role="alert" className="rounded-lg border border-red-300/15 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200">{saveError || status?.error}</div>}
      {copyMessage && <p role="status" className="text-xs text-text-secondary">{copyMessage}</p>}

      <ExternalApiTokenManager tokens={status?.tokens ?? []} disabled={controlsDisabled} onTokensChange={updateTokens} />

      <details className="border-t border-white/[0.07] pt-4 text-xs text-text-secondary">
        <summary className="cursor-pointer font-medium text-text-primary">调用示例</summary>
        <p className="mt-2 leading-5">外部接口不会跨域开放。请求时在 Authorization 头中提供令牌：</p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-white/[0.07] bg-black/25 p-3 font-mono text-[11px] leading-5 text-text-primary">{`GET /api/v1/me\nAuthorization: Bearer TOKEN_PLACEHOLDER`}</pre>
      </details>
    </section>
  )
}
