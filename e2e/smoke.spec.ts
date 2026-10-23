import { expect, test } from './fixtures'

// Known defects that still log on every start. Delete an entry when it is
// fixed; anything not listed here fails the boot test.
const KNOWN_ERRORS = [
  // KaTeX's inline data: fonts are blocked by default-src 'self' in index.html;
  // adding "font-src 'self' data:" to the CSP fixes it.
  /^Loading the font 'data:font[/]woff2;base64,/
]

test('boots to the new-chat screen with no console errors', async ({ orcha }) => {
  const { page, errors } = orcha
  await expect(page.getByTitle('Settings')).toBeVisible()
  // The new-chat composer is what a fresh install opens on.
  await expect(page.getByRole('textbox', { name: 'Ask Claude anything' })).toBeVisible()
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
