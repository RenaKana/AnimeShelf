// 后端编译：esbuild bundle server/index.ts → dist-electron/server.cjs
// node_modules 全部外置（packages: external）——Electron 打包时随 dependencies 一起分发，
// node-sqlite3-wasm 的 .wasm 按原路径从 node_modules 加载（bundle 内联会破坏其加载路径）
import { build } from 'esbuild'
import fs from 'fs'
import { generateModules } from './modules.mjs'

generateModules()

fs.mkdirSync('dist-electron', { recursive: true })

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist-electron/server.cjs',
  packages: 'external',
  logLevel: 'info',
})
console.log('✓ server.cjs built')
