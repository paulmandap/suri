import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node and never reach the internet (see CLAUDE.md).
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
