import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node and never reach the internet (see CLAUDE.md).
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // node:sqlite (the history, ADR-020) is marked experimental in Node 22 and
    // says so in every test worker. Electron's Node 24 runs it without a word.
    execArgv: ['--disable-warning=ExperimentalWarning']
  }
})
