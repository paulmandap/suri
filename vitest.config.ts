import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node and must never touch the network (see CLAUDE.md).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
