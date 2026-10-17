import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { APP_ORIGIN, CORE_URL, RENDERER_HOST, RENDERER_PORT } from './services/core/config/ports'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/main/index.ts')
      }
    },
    define: {
      __CORE_URL__: JSON.stringify(CORE_URL),
      __APP_ORIGIN__: JSON.stringify(APP_ORIGIN)
    }
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs'
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/index.html'),
          settings: resolve(__dirname, 'src/settings/index.html'),
          overlay: resolve(__dirname, 'src/overlay/index.html'),
          handle: resolve(__dirname, 'src/handle/index.html'),
        }
      }
    },
    plugins: [react()],
    server: {
      host: RENDERER_HOST,
      port: RENDERER_PORT,
      strictPort: true
    },
    define: {
      __CORE_URL__: JSON.stringify(CORE_URL)
    }
  }
})
