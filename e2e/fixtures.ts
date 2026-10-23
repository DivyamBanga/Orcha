// The Electron launch fixture: a fresh, isolated Orcha for every test.
//
// Isolation, because the owner's own Orcha lives on this machine:
//  - --user-data-dir (and so the database and logs) is a temp folder;
//  - USERPROFILE/HOME point at a temp folder too, which covers os.homedir().
//    Electron's app.getPath('home') ignores both, so the fixture also checks
//    the user-data path is under the scratch root before going any further;
//  - ORCHA_ADMIN_FILE names a file that does not exist, so nothing can touch
//    the owner's relay token;
//  - CLAUDE*/ANTHROPIC* variables are dropped, so no real key is ever in reach.
//
// The window is created off-screen and shown without focus (--orcha-e2e), and
// every input goes through the DevTools protocol, never the OS, so a test run
// does not move the cursor or take the keyboard.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { startFakeProviders, type FakeProviders } from './fake-providers'

export interface Orcha {
  app: ElectronApplication
  /** The main window, past first-run setup. */
  page: Page
  /** Every console error and uncaught exception the page has reported. */
  errors: string[]
  fake: FakeProviders
  /** The scratch folder holding this test's profile. */
  root: string
}

const repoRoot = resolve(__dirname, '..')

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(ANTHROPIC|CLAUDE)/i.test(k)) env[k] = v
  }
  return { ...env, ...extra }
}

// A fresh profile lands on first-run setup (it needs GitHub and Claude logins,
// which a test machine does not have). The fixture gets past it the way a
// finished setup would look: the main process answers the setup check as
// "both connected" and the onboarded flag is saved, then the page reloads. The
// handler is swapped in the main process because window.orcha is read-only.
async function pastFirstRun(app: ElectronApplication, page: Page, errors: string[]): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('setup:status')
    ipcMain.handle('setup:status', () => ({ gh: true, claude: true }))
  })
  await page.evaluate(() =>
    (
      window as unknown as { orcha: { ui: { saveState(k: string, v: string): Promise<void> } } }
    ).orcha.ui.saveState('onboarded', '1')
  )
  // Whatever the first load reported is not interesting; the reload is the boot
  // a test gets to judge.
  errors.length = 0
  await page.reload()
  await page.getByTitle('Settings').waitFor()
}

export const test = base.extend<{ orcha: Orcha }>({
  // Playwright insists the first argument is a destructuring pattern.
  // eslint-disable-next-line no-empty-pattern
  orcha: async ({}, provide, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'orcha-e2e-'))
    const home = join(root, 'home')
    mkdirSync(home)
    const fake = await startFakeProviders()
    const app = await electron.launch({
      args: [
        join(repoRoot, 'out/main/index.js'),
        `--user-data-dir=${join(root, 'userData')}`,
        '--orcha-e2e'
      ],
      cwd: repoRoot,
      env: cleanEnv({
        USERPROFILE: home,
        HOME: home,
        ORCHA_ADMIN_FILE: join(home, 'no-relay-admin.json'),
        ...fake.env
      }),
      colorScheme: 'dark',
      locale: 'en-US',
      timeout: 60_000
    })
    const pid = app.process().pid
    try {
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      if (!userData.startsWith(root)) throw new Error(`Refusing to run: profile is ${userData}`)

      const page = await app.firstWindow()
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      page.on('pageerror', (e) => errors.push(e.message))
      await pastFirstRun(app, page, errors)
      await app.context().tracing.start({ screenshots: true, snapshots: true })
      await provide({ app, page, errors, fake, root })
      const failed = testInfo.status !== testInfo.expectedStatus
      await app
        .context()
        .tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined)
        .catch(() => {})
    } finally {
      await app.close().catch(() => {})
      // If it did not exit on its own, end the one process this test started.
      if (pid) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
      }
      await fake.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }
})

export { expect }
