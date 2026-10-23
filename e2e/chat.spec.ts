import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Chats on every route but the Max plan (which needs a real Claude login),
// against the fake providers: Settings → Models & keys sets each one up, the
// picker offers its models, and a reply streams back.

async function openModelsAndKeys(page: Page): Promise<void> {
  await page.getByTitle('Settings').click()
  await page.getByRole('button', { name: 'Models & keys' }).click()
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Models & keys' })).toBeHidden()
}

// Picks a model in the composer; `nth` tells apart the same model on two
// routes (the Max plan's comes first, then the API key's).
async function pick(page: Page, label: RegExp, nth = 0): Promise<void> {
  await page.getByTitle('Choose a model').click()
  await page.locator('.popover').getByRole('button', { name: label }).nth(nth).click()
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: /^Ask .+ anything$/ })
  await box.fill(text)
  await box.press('Enter')
}

async function addKey(page: Page, key: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Anthropic API key' }).fill(key)
  await page.getByRole('button', { name: 'Add key' }).click()
}

async function connectAzure(page: Page): Promise<void> {
  await page
    .getByRole('textbox', { name: 'Azure endpoint' })
    .fill('https://orcha-test.openai.azure.com')
  await page.getByRole('textbox', { name: 'Azure key' }).fill('azure-test-key-0123456789')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('gpt-6-sol', { exact: true })).toBeVisible({ timeout: 20_000 })
}

test('an Anthropic key is checked, kept, and chats run on it', async ({ orcha }) => {
  const { page, fake } = orcha
  await openModelsAndKeys(page)

  // A refused key isn't kept.
  await addKey(page, 'sk-ant-bad-0000000000')
  await expect(page.locator('.text-red-400')).toBeVisible()
  await expect(page.getByText('…0000')).toBeHidden()

  await addKey(page, 'sk-ant-test-0123456789')
  await expect(page.getByText('…6789')).toBeVisible()
  await expect(page.getByText('default', { exact: true })).toBeVisible()
  await closeSettings(page)

  await pick(page, /Haiku 5\.5/, 1)
  await send(page, 'Hello from the key')
  await expect(page.getByText('Fake reply: Hello from the key')).toBeVisible()

  const call = fake.requests.find((r) => r.provider === 'anthropic' && r.method === 'POST')
  expect(call?.body).toMatchObject({ model: 'claude-haiku-5-5', stream: true })
  // API version 2026-10-21 refuses sampling on every Claude model.
  expect(call?.body).not.toHaveProperty('temperature')
})

test('Azure is connected by probing its deployments, and GPT chats run on it', async ({
  orcha
}) => {
  const { page, fake } = orcha
  await openModelsAndKeys(page)
  await connectAzure(page)
  await closeSettings(page)

  await pick(page, /GPT-6 Sol/)
  await send(page, 'Hello from Azure')
  await expect(page.getByText('Fake reply: Hello from Azure')).toBeVisible()

  const chat = fake.requests.find(
    (r) => r.provider === 'azure' && (r.body as { stream?: boolean } | null)?.stream
  )
  expect(chat?.path).toBe('/openai/v1/responses')
  expect(chat?.body).toMatchObject({ model: 'gpt-6-sol', store: false })
})

test('a local model chats through Ollama', async ({ orcha }) => {
  const { page, fake } = orcha
  await pick(page, /fake:latest/)
  await send(page, 'Hello from this computer')
  await expect(page.getByText('Fake reply: Hello from this computer')).toBeVisible()

  const call = fake.requests.find((r) => r.provider === 'ollama' && r.path === '/api/chat')
  expect(call?.body).toMatchObject({ model: 'fake:latest', keep_alive: '5m' })
  expect((call?.body as { options?: { num_ctx?: number } }).options?.num_ctx).toBeGreaterThan(0)
})

test('a chat carries on across providers, with the earlier turns as text', async ({ orcha }) => {
  const { page, fake } = orcha
  await openModelsAndKeys(page)
  await addKey(page, 'sk-ant-test-0123456789')
  await expect(page.getByText('…6789')).toBeVisible()
  await connectAzure(page)
  await closeSettings(page)

  await pick(page, /Haiku 5\.5/, 1)
  await send(page, 'First on Claude')
  await expect(page.getByText('Fake reply: First on Claude')).toBeVisible()

  await pick(page, /GPT-6 Sol/)
  await send(page, 'Then on GPT')
  await expect(page.getByText('Fake reply: Then on GPT')).toBeVisible()

  const gpt = fake.requests.find(
    (r) => r.provider === 'azure' && (r.body as { stream?: boolean } | null)?.stream
  )
  const sent = JSON.stringify(gpt?.body)
  expect(sent).toContain('First on Claude')
  expect(sent).toContain('Fake reply: First on Claude')
})
