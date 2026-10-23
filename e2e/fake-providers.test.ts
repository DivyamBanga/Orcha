import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeProviders, type FakeProviders } from './fake-providers'

let fake: FakeProviders
beforeAll(async () => {
  fake = await startFakeProviders()
})
afterAll(() => fake.close())

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', body: JSON.stringify(body) })

describe('fake providers', () => {
  it('streams an Anthropic reply, with thinking on a marker', async () => {
    const res = await post(`${fake.anthropicUrl}/v1/messages`, {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi ORCHA_THINK' }] }]
    })
    const text = await res.text()
    expect(text).toContain('thinking_delta')
    expect(text).toContain('"text":"Fake "')
    expect(text.trim().endsWith('"type":"message_stop"}')).toBe(true)
  })

  it('streams an Azure reply that ends in response.completed', async () => {
    const res = await post(`${fake.azureUrl}/openai/v1/responses`, {
      model: 'gpt-6-sol',
      input: 'yo',
      stream: true
    })
    const text = await res.text()
    expect(text).toContain('response.output_text.delta')
    expect(text).toContain('event: response.completed')
  })

  it('has one Azure deployment, and refuses a probe as invalid rather than answering it', async () => {
    const missing = await post(`${fake.azureUrl}/openai/v1/responses`, {
      model: 'gpt-5',
      input: 'x'
    })
    expect(missing.status).toBe(404)
    const probe = await post(`${fake.azureUrl}/openai/v1/responses`, {
      model: 'gpt-6-sol',
      input: 'x',
      max_output_tokens: 1
    })
    expect(probe.status).toBe(400)
  })

  it('lists models for a key and refuses one with "bad" in it', async () => {
    const ok = await fetch(`${fake.anthropicUrl}/v1/models`, {
      headers: { authorization: 'Bearer sk-ant-test' }
    })
    expect(((await ok.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
    const bad = await fetch(`${fake.anthropicUrl}/v1/models`, {
      headers: { authorization: 'Bearer sk-ant-bad' }
    })
    expect(bad.status).toBe(401)
  })

  it('answers the Ollama discovery calls and chats in NDJSON', async () => {
    expect(await (await fetch(`${fake.ollamaUrl}/api/version`)).json()).toEqual({
      version: '0.30.3'
    })
    const tags = (await (await fetch(`${fake.ollamaUrl}/api/tags`)).json()) as {
      models: unknown[]
    }
    expect(tags.models).toHaveLength(1)
    const chat = await post(`${fake.ollamaUrl}/api/chat`, {
      model: 'fake:latest',
      messages: [{ role: 'user', content: 'hello' }]
    })
    const lines = (await chat.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { done: boolean; message: { content: string } })
    expect(lines.at(-1)?.done).toBe(true)
    expect(lines.map((l) => l.message.content).join('')).toBe('Fake reply: hello')
  })

  it('fails on error markers with the right status', async () => {
    const res = await post(`${fake.anthropicUrl}/v1/messages`, {
      messages: [{ role: 'user', content: 'ORCHA_ERROR_429' }]
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('1')
  })

  it('records what it was sent', () => {
    expect(fake.requests.some((r) => r.provider === 'azure')).toBe(true)
  })
})
