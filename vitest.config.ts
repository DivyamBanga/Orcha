import { defineConfig } from 'vitest/config'

// Unit tests for the app's own logic (relay/ has its own runner).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
