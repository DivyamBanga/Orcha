import { resolve } from 'node:path'
import { expect, test } from './fixtures'

// Known defects that still log on every start. Delete an entry when it is
// fixed; anything not listed here fails the boot test.
const KNOWN_ERRORS: RegExp[] = []

test('boots to the new-chat screen with no console errors', async ({ orcha }) => {
  const { page, errors } = orcha
  await expect(page.getByTitle('Settings')).toBeVisible()
  // The new-chat composer is what a fresh install opens on.
  await expect(page.getByRole('textbox', { name: /^Ask .+ anything$/ })).toBeVisible()
  const unexpected = errors.filter((e) => !KNOWN_ERRORS.some((k) => k.test(e)))
  expect(unexpected, 'console errors during boot (includes CSP violations)').toEqual([])
})

test('Ctrl+K opens the command palette and Esc closes it', async ({ orcha }) => {
  const { page } = orcha
  const input = page.getByPlaceholder('Search chats and sessions, or type a command')
  await page.keyboard.press('Control+K')
  await expect(input).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
})

test('Settings opens and closes', async ({ orcha }) => {
  const { page } = orcha
  await page.getByTitle('Settings').click()
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeHidden()
})

test('never runs against the owner profile and never shows the window focused', async ({
  orcha
}) => {
  const info = await orcha.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { x: w.getPosition()[0], focused: w.isFocused(), visible: w.isVisible() }
  })
  expect(info.visible).toBe(true)
  expect(info.focused).toBe(false)
  expect(info.x).toBeLessThan(-1000)
})

test('only Orcha’s own page can call into the main process', async ({ orcha }) => {
  // The same preload, on a page that isn't Orcha's.
  const preload = resolve(__dirname, '../out/preload/index.js')
  const answer = await orcha.app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false } })
    try {
      await other.loadURL('data:text/html,<p>somewhere else</p>')
      return await other.webContents.executeJavaScript(
        'typeof window.orcha === "undefined" ? "no bridge" : window.orcha.models().then(() => "answered", (e) => String(e.message))'
      )
    } finally {
      other.destroy()
    }
  }, preload)
  expect(answer).toContain('Not allowed')
  // And the app's own page still gets answers.
  const models = await orcha.page.evaluate(() =>
    (window as unknown as { orcha: { models(): Promise<unknown[]> } }).orcha.models()
  )
  expect(models.length).toBeGreaterThan(0)
})
