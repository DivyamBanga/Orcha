import { defineConfig } from '@playwright/test'

// One Electron app per test (see e2e/fixtures.ts), so tests never share state.
// Workers stay at 1: each app is a full Orcha and they would only fight over
// the machine the owner is using.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results'
})
