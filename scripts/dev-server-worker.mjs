import { pathToFileURL } from 'node:url'
import path from 'node:path'

const serverBundle = process.argv[2]
if (!serverBundle) throw new Error('Missing compiled backend path')

if (serverBundle === '--vite') {
  let vite
  let startup = Promise.resolve()
  let stopping

  const stopVite = () => stopping ??= (async () => {
    try {
      await startup
      if (vite) await vite.close()
      process.exit(0)
    } catch (error) {
      stopping = undefined
      console.error('Vite shutdown failed:', error)
      process.send?.({ type: 'shutdown-failed', error: error instanceof Error ? error.message : String(error) })
    }
  })()

  // Install control handlers before the first import/listen await so an early
  // parent stop cannot strand a Vite server that finishes starting later.
  process.once('disconnect', () => { void stopVite() })
  process.once('SIGINT', () => { void stopVite() })
  process.once('SIGTERM', () => { void stopVite() })
  process.on('message', message => {
    if (message && message.type === 'shutdown') void stopVite()
  })

  startup = (async () => {
    const { createServer } = await import('vite')
    if (stopping) return
    vite = await createServer({ configFile: path.resolve('vite.config.ts') })
    if (stopping) return
    await vite.listen()
    if (stopping) return
    const address = vite.httpServer?.address()
    const port = typeof address === 'object' && address ? address.port : null
    process.send?.({ type: 'service-status', clientPort: port, webUrl: port ? `http://127.0.0.1:${port}` : null })
  })()
  await startup
} else {
  let serverModule
  let loading = Promise.resolve()
  let stopping

  const stopBackend = () => stopping ??= (async () => {
    try {
      await loading
      await serverModule?.shutdownServer?.()
      process.exit(0)
    } catch (error) {
      stopping = undefined
      console.error('Backend shutdown failed:', error)
      process.send?.({ type: 'shutdown-failed', error: error instanceof Error ? error.message : String(error) })
    }
  })()

  // IPC 由 dev-server.mjs 建立。热重启、父进程结束时先关闭 HTTP/SQLite，避免遗留数据库锁。
  process.once('disconnect', () => { void stopBackend() })
  process.once('SIGINT', () => { void stopBackend() })
  process.once('SIGTERM', () => { void stopBackend() })
  process.on('message', message => {
    if (message && message.type === 'shutdown') void stopBackend()
  })

  // 使用 dev.mjs 已探测的共享端口；Vite 读取同一变量配置代理。
  process.env.PORT = process.env.ANIMESHELF_DEV_API_PORT ?? '3002'
  process.env.LISTEN_HOST = '127.0.0.1'
  process.env.ANIMESHELF_SERVICE_CHILD = '1'

  loading = import(pathToFileURL(serverBundle).href).then(module => { serverModule = module })
  await loading
}
