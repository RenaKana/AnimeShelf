import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { generateModules } from './scripts/modules.mjs'
generateModules()
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: { environment: 'node', include: ['server/**/*.test.ts', 'modules/**/*.test.ts', 'modules/**/*.test.tsx'] },
})
