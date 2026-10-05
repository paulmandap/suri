import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Main, preload and renderer all import shared code as `@shared/...`.
const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Two windows, two preloads (ADR-014). A sandboxed preload can't load a
      // shared chunk, so they share no runtime code; scripts/check-preloads.mjs
      // fails the build if one ever needs a chunk. (electron-vite's
      // `isolatedEntries` would do this, but it crashes outside a terminal.)
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          settings: resolve('src/preload/settings.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        ...shared
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
})
