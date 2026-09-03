import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts')
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
        }
      }
    },
    plugins: [react()]
  }
})