import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { restartService } from '../lib/serviceRestart'
import Button from './ui/Button'
import { useDialogBehavior } from './ui/dialogBehavior'
import { RefreshIcon } from './ui/Icons'
import OverlayPresence from './ui/OverlayPresence'

type RestartPhase = 'idle' | 'confirm' | 'restarting' | 'error'
type RestartOwner = symbol | null

interface RestartState {
  phase: RestartPhase
  owner: RestartOwner
  message: string
  error: string
}

let restartState: RestartState = { phase: 'idle', owner: null, message: '', error: '' }
let restartController: AbortController | null = null
const listeners = new Set<() => void>()

function publish(patch: Partial<RestartState>) {
  restartState = { ...restartState, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function useRestartStore() {
  return useSyncExternalStore(subscribe, () => restartState, () => restartState)
}

export function useServiceRestartState() {
  const state = useRestartStore()
  return {
    restarting: state.phase === 'restarting',
    confirming: state.phase === 'confirm',
    message: state.message,
    error: state.error,
  }
}

function beginConfirmation(owner: RestartOwner) {
  if (restartController || restartState.phase === 'confirm' || restartState.phase === 'restarting') return
  publish({ phase: 'confirm', owner, message: '', error: '' })
}

function cancelConfirmation(owner: RestartOwner) {
  if (restartState.phase === 'confirm' && restartState.owner === owner) {
    publish({ phase: 'idle', owner: null, message: '', error: '' })
  }
}

async function confirmRestart(owner: RestartOwner) {
  if (restartController || restartState.phase !== 'confirm' || restartState.owner !== owner) return
  const controller = new AbortController()
  restartController = controller
  publish({ phase: 'restarting', owner, message: '正在请求重启服务…', error: '' })
  try {
    await restartService({
      signal: controller.signal,
      onAccepted: () => publish({ message: '正在等待服务恢复，就绪后将自动刷新页面…' }),
    })
    window.location.reload()
  } catch (error) {
    publish({
      phase: 'error',
      owner,
      message: '',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    restartController = null
  }
}

export interface ServiceRestartControlProps {
  disabled?: boolean
  compact?: boolean
}

export default function ServiceRestartControl({ disabled = false, compact = false }: ServiceRestartControlProps) {
  const state = useRestartStore()
  const ownerRef = useRef(Symbol('service-restart-control'))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const ownsConfirmation = state.phase === 'confirm' && state.owner === ownerRef.current
  const ownsError = state.phase === 'error' && state.owner === ownerRef.current
  const restarting = state.phase === 'restarting'

  useEffect(() => {
    const owner = ownerRef.current
    return () => cancelConfirmation(owner)
  }, [])

  useDialogBehavior({
    open: ownsConfirmation,
    dialogRef,
    initialFocusRef: cancelRef,
    triggerRef,
    onClose: () => cancelConfirmation(ownerRef.current),
  })

  return (
    <div className={compact ? 'flex w-full justify-center' : 'space-y-1'}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || restarting || state.phase === 'confirm'}
        onClick={() => beginConfirmation(ownerRef.current)}
        title={restarting ? state.message : ownsError ? `重启失败：${state.error}` : '重启服务'}
        aria-label={restarting ? '正在重启服务' : ownsError ? `重启失败：${state.error}` : '重启服务'}
        className={`flex h-9 items-center rounded-lg text-text-secondary transition-colors hover:bg-white/[0.055] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 ${compact ? 'w-9 justify-center' : 'w-full gap-2.5 px-3'}`}>
        <RefreshIcon />
        {!compact && <span className="text-sm font-medium">{restarting ? '正在重启…' : '重启服务'}</span>}
      </button>

      {ownsError && !compact && <p role="alert" className="px-3 text-xs leading-5 text-red-300">{state.error}</p>}

      {typeof document !== 'undefined' && createPortal(
        <OverlayPresence open={ownsConfirmation}>
          {ownsConfirmation && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={() => cancelConfirmation(ownerRef.current)}>
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="service-restart-title" tabIndex={-1} className="clean-dialog ui-panel-strong w-full max-w-md rounded-xl border border-white/10 bg-[#0d121b]/98 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.5)]" onClick={event => event.stopPropagation()}>
              <h2 id="service-restart-title" className="font-semibold text-white">重启 AnimeShelf 服务？</h2>
              <p className="mt-2 text-sm leading-6 text-text-secondary">扫描、恢复等媒体库维护操作进行中时，服务会拒绝重启。服务恢复后，此页面将自动刷新。</p>
              <div className="mt-5 flex justify-end gap-2">
                <Button ref={cancelRef} variant="ghost" onClick={() => cancelConfirmation(ownerRef.current)}>取消</Button>
                <Button variant="primary" onClick={() => { void confirmRestart(ownerRef.current) }}>确认重启</Button>
              </div>
            </div>
          </div>}
        </OverlayPresence>,
        document.body,
      )}
    </div>
  )
}
