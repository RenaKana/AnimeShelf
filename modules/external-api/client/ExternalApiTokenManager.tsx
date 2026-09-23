import { useEffect, useRef, useState } from 'react'
import type { ExternalApiRole, ExternalApiTokenInfo } from '../../../shared/external-api'
import { createExternalApiToken, revokeExternalApiToken, updateExternalApiToken } from './externalApiClient'
import Button from '../../../src/components/ui/Button'
import SensitiveInput from '../../../src/components/ui/SensitiveInput'
import SelectMenu from '../../../src/components/ui/SelectMenu'

const ROLE_OPTIONS: ReadonlyArray<{ value: ExternalApiRole; label: string }> = [
  { value: 'files', label: '文件管理（最高）' },
  { value: 'edit', label: '数据编辑' },
  { value: 'read', label: '只读' },
  { value: 'disabled', label: '禁用' },
]

const ROLE_LABEL: Record<ExternalApiRole, string> = {
  files: '文件管理', edit: '数据编辑', read: '只读', disabled: '禁用',
}

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '永不过期'
}

function toLocalDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function toExpiry(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('到期时间无效')
  return date.toISOString()
}

function confirmFilesRole(): boolean {
  return window.confirm('文件管理权限允许调用方物理重命名、移动和永久删除媒体目录，删除无法撤销。确认授予此权限？')
}

interface EditDraft { id: string; name: string; role: ExternalApiRole; expiresAt: string }

export default function ExternalApiTokenManager({
  tokens,
  disabled,
  onTokensChange,
}: {
  tokens: ExternalApiTokenInfo[]
  disabled: boolean
  onTokensChange: (update: (current: ExternalApiTokenInfo[]) => ExternalApiTokenInfo[]) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<ExternalApiRole>('read')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<EditDraft | null>(null)
  const [secretInfo, setSecretInfo] = useState<ExternalApiTokenInfo | null>(null)
  const [copyMessage, setCopyMessage] = useState('')
  const aliveRef = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const secretRef = useRef('')
  const secretInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      busyRef.current = false
      controllerRef.current?.abort()
      secretRef.current = ''
    }
  }, [])

  const createToken = async () => {
    const tokenName = name.trim()
    if (!tokenName) { setError('请输入令牌名称'); return }
    if (role === 'files' && !confirmFilesRole()) return
    if (busyRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true
    setBusy('create'); setError(''); setCopyMessage('')
    try {
      const created = await createExternalApiToken({ name: tokenName, role, expires_at: toExpiry(expiresAt) }, controller.signal)
      if (!aliveRef.current || controller.signal.aborted) return
      onTokensChange(current => [created.token_info, ...current.filter(token => token.id !== created.token_info.id)])
      secretRef.current = created.token
      setSecretInfo(created.token_info)
      setName(''); setRole('read'); setExpiresAt('')
    } catch (reason) {
      if (aliveRef.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '令牌创建失败')
    } finally {
      busyRef.current = false
      if (aliveRef.current) setBusy(null)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const saveEdit = async () => {
    if (!edit || busyRef.current) return
    const editedName = edit.name.trim()
    if (!editedName) { setError('令牌名称不能为空'); return }
    if (edit.role === 'files' && tokens.find(token => token.id === edit.id)?.role !== 'files' && !confirmFilesRole()) return
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true
    setBusy(`edit:${edit.id}`); setError('')
    try {
      const updated = await updateExternalApiToken(edit.id, { name: editedName, role: edit.role, expires_at: toExpiry(edit.expiresAt) }, controller.signal)
      if (!aliveRef.current || controller.signal.aborted) return
      onTokensChange(current => current.map(token => token.id === updated.id ? updated : token))
      setEdit(null)
    } catch (reason) {
      if (aliveRef.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '令牌更新失败')
    } finally {
      busyRef.current = false
      if (aliveRef.current) setBusy(null)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const revoke = async (token: ExternalApiTokenInfo) => {
    if (busyRef.current || token.revoked_at || !window.confirm(`确认撤销令牌“${token.name}”？撤销后无法恢复。`)) return
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true
    setBusy(`revoke:${token.id}`); setError('')
    try {
      await revokeExternalApiToken(token.id, controller.signal)
      if (!aliveRef.current || controller.signal.aborted) return
      const revokedAt = new Date().toISOString()
      onTokensChange(current => current.map(item => item.id === token.id ? { ...item, revoked_at: revokedAt } : item))
      if (edit?.id === token.id) setEdit(null)
      if (secretInfo?.id === token.id) { secretRef.current = ''; setSecretInfo(null); setCopyMessage('') }
    } catch (reason) {
      if (aliveRef.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '令牌撤销失败')
    } finally {
      busyRef.current = false
      if (aliveRef.current) setBusy(null)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const copySecret = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(secretRef.current)
      if (aliveRef.current) setCopyMessage('已复制')
    } catch {
      secretInputRef.current?.focus(); secretInputRef.current?.select()
      if (aliveRef.current) setCopyMessage('无法自动复制，请手动选择')
    }
  }

  const dismissSecret = () => { secretRef.current = ''; setSecretInfo(null); setCopyMessage('') }

  return (
    <div className="space-y-4">
      <div className="border-t border-white/[0.07] pt-4">
        <h3 className="text-sm font-semibold text-text-primary">访问令牌</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">新令牌默认只读。文件管理权限包含物理重命名、移动和永久物理删除，请仅授予可信程序。</p>
      </div>

      {secretInfo && <div role="status" className="rounded-xl border border-amber-300/25 bg-amber-300/[0.07] p-3">
        <div className="text-sm font-medium text-amber-100">请立即保存“{secretInfo.name}”的令牌</div>
        <p className="mt-1 text-xs text-amber-100/70">完整密钥只显示这一次，关闭后无法再次查看。</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <SensitiveInput ref={secretInputRef} readOnly value={secretRef.current} aria-label="新令牌密钥" onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-amber-200/20 bg-black/25 px-3 py-2 font-mono text-xs text-amber-50 outline-none focus:border-amber-200/45" resetKey={secretInfo.id} showLabel="显示新令牌" hideLabel="隐藏新令牌" />
          <Button size="sm" onClick={() => { void copySecret() }}>复制</Button><Button size="sm" variant="ghost" onClick={dismissSecret}>关闭并清除</Button>
        </div>
        {copyMessage && <p className="mt-2 text-xs text-amber-100/75">{copyMessage}</p>}
      </div>}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_210px_auto]">
        <label className="min-w-0"><span className="sr-only">令牌名称</span><input value={name} onChange={event => setName(event.target.value)} disabled={disabled || !!busy || !!secretInfo} placeholder="令牌名称，如 自动整理脚本" className="h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm outline-none focus:border-accent disabled:opacity-50" /></label>
        <SelectMenu value={role} options={ROLE_OPTIONS} onChange={setRole} ariaLabel="新令牌权限" minWidthClass="min-w-0" disabled={disabled || !!busy || !!secretInfo} />
        <label className="min-w-0"><span className="sr-only">可选到期时间</span><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} disabled={disabled || !!busy || !!secretInfo} className="h-9 min-w-0 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-xs outline-none focus:border-accent disabled:opacity-50" /></label>
        <Button size="sm" variant="primary" disabled={disabled || !!busy || !!secretInfo || !name.trim()} onClick={() => { void createToken() }}>{busy === 'create' ? '创建中…' : '创建'}</Button>
      </div>
      {role === 'files' && <p role="alert" className="text-xs leading-5 text-amber-200/80">警告：文件管理令牌可永久物理删除目录；创建前还会再次确认。</p>}
      {error && <div role="alert" className="rounded-lg border border-red-300/15 bg-red-400/[0.08] px-3 py-2 text-sm text-red-200">{error}</div>}

      <div className="space-y-2" aria-label="现有访问令牌">
        {tokens.length === 0 ? <div className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-sm text-text-secondary">还没有访问令牌</div> : tokens.map(token => {
          const revoked = Boolean(token.revoked_at)
          const editing = edit?.id === token.id
          return <article key={token.id} className={`rounded-xl border p-3 ${revoked ? 'border-white/[0.05] bg-black/10 opacity-60' : 'border-white/[0.08] bg-black/15'}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{token.name}</span><code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-text-secondary">{token.prefix}…</code><span className="text-[11px] text-accent">{ROLE_LABEL[token.role]}</span>{revoked && <span className="text-[11px] text-red-300">已撤销</span>}</div><p className="mt-1 text-[11px] text-text-secondary/75">到期：{dateLabel(token.expires_at)} · 最近使用：{token.last_used_at ? dateLabel(token.last_used_at) : '从未'}</p></div>
              <div className="flex gap-2"><Button size="sm" disabled={disabled || !!busy || revoked} onClick={() => setEdit({ id: token.id, name: token.name, role: token.role, expiresAt: toLocalDateTime(token.expires_at) })}>编辑</Button><Button size="sm" variant="danger" disabled={disabled || !!busy || revoked} onClick={() => { void revoke(token) }}>{busy === `revoke:${token.id}` ? '撤销中…' : revoked ? '已撤销' : '撤销'}</Button></div>
            </div>
            {editing && edit && <div className="mt-3 grid gap-2 border-t border-white/[0.07] pt-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_210px_auto]">
              <input aria-label="编辑令牌名称" value={edit.name} disabled={!!busy} onChange={event => setEdit({ ...edit, name: event.target.value })} className="h-9 min-w-0 rounded-lg border border-white/10 bg-bg px-3 text-sm outline-none focus:border-accent" />
              <SelectMenu value={edit.role} options={ROLE_OPTIONS} onChange={next => setEdit({ ...edit, role: next })} ariaLabel="编辑令牌权限" minWidthClass="min-w-0" disabled={!!busy} />
              <input aria-label="编辑令牌到期时间" type="datetime-local" value={edit.expiresAt} disabled={!!busy} onChange={event => setEdit({ ...edit, expiresAt: event.target.value })} className="h-9 min-w-0 rounded-lg border border-white/10 bg-bg px-3 text-xs outline-none focus:border-accent" />
              <div className="flex gap-2"><Button size="sm" variant="primary" disabled={!!busy || !edit.name.trim()} onClick={() => { void saveEdit() }}>{busy === `edit:${token.id}` ? '保存中…' : '保存'}</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setEdit(null)}>取消</Button></div>
            </div>}
          </article>
        })}
      </div>
    </div>
  )
}
