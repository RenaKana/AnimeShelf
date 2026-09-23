import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { generateModules, watchModules } from './scripts/modules.mjs'

generateModules()

const apiPort = Number(process.env.ANIMESHELF_DEV_API_PORT ?? 3002)
const clientPort = Number(process.env.ANIMESHELF_DEV_CLIENT_PORT ?? 5173)
const apiTarget = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  // Scan the app entry; the Android SDK contains thousands of documentation HTML files.
  optimizeDeps: { entries: ['index.html'] },
  plugins: [react(), {
    name: 'animeshelf-source-modules',
    buildStart() { generateModules() },
    configureServer(server) {
      const stop = watchModules(() => { server.ws.send({ type: 'full-reload' }) })
      server.httpServer?.once('close', stop)
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: clientPort,
    strictPort: true,
    watch: {
      ignored: ['**/mobile/**', '**/data/**', '**/.artifacts/**', '**/.pnpm-store/**', '**/dist-electron/**', '**/release/**'],
    },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/posters': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/wallpapers': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
