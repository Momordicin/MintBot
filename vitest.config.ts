import { defineConfig } from 'vitest/config'
import './vitest.env'
import { APP_ORIGIN, CORE_URL } from './services/core/config/ports'

export default defineConfig({
  define: {
    __CORE_URL__: JSON.stringify(CORE_URL),
    __APP_ORIGIN__: JSON.stringify(APP_ORIGIN)
  },
  test: {
    globals: true,
    env: { DB_PATH: ':memory:' },
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
