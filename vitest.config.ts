import { defineConfig } from 'vitest/config'
import './vitest.env'
import { CORE_URL } from './services/core/config/ports'

export default defineConfig({
  define: {
    __CORE_URL__: JSON.stringify(CORE_URL)
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
