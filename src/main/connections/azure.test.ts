import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_SPECS } from '../../shared/models'
import { ProviderError } from '../chat/provider'
import { KNOWN_DEPLOYMENTS, normalizeEndpoint, probeDeployments, testConnection } from './azure'

describe('normalizeEndpoint', () => {
  const base = 'https://my-res.openai.azure.com'

  it('keeps just the address from whatever the portal hands out', () => {
    for (const pasted of [
      base,
      `${base}/`,
      `${base}/openai/v1`,
      `${base}/openai/v1/`,
      `${base}/openai/v1/responses?api-version=preview`,
      `${base}/openai/deployments/gpt-6-sol/chat/completions?api-version=2024-10-21`,
      `  ${base}/openai/v1/  `,
      'my-res.openai.azure.com',
      'https://MY-RES.openai.azure.com/OpenAI/v1',
      'https://user:secret@my-res.openai.azure.com/'
    ]) {
      expect(normalizeEndpoint(pasted)).toBe(base)
    }
  })

  it('keeps the host it was given (the Foundry form, the older one, other clouds)', () => {
    expect(normalizeEndpoint('https://my-res.services.ai.azure.com/openai/v1/')).toBe(
      'https://my-res.services.ai.azure.com'
    )
    expect(normalizeEndpoint('https://my-res.services.ai.azure.com/api/projects/p1')).toBe(
      'https://my-res.services.ai.azure.com'
    )
    expect(normalizeEndpoint('https://my-res.cognitiveservices.azure.com/')).toBe(
      'https://my-res.cognitiveservices.azure.com'
    )
    expect(normalizeEndpoint('https://my-res.openai.azure.us')).toBe(
      'https://my-res.openai.azure.us'
    )
  })

  it('refuses anything a key should not be sent to', () => {
    for (const bad of [
      '',
      '   ',
      'not a url',
      'http://my-res.openai.azure.com',
      'https://example.com/openai/v1',
      'https://my-res.openai.azure.com.example.com',
      'https://evilopenai.azure.com',
      'https://openai.azure.com',
      'ftp://my-res.openai.azure.com'
    ]) {
      expect(normalizeEndpoint(bad), bad).toBeNull()
    }
  })
})

describe('known deployments', () => {
  it('lists every GPT model Orcha knows, and the other kinds by name', () => {
    expect(KNOWN_DEPLOYMENTS.chat).toEqual(
      MODEL_SPECS.filter((m) => m.family === 'gpt').map((m) => m.id)
    )
    expect(KNOWN_DEPLOYMENTS.chat).toContain('gpt-6.1-sol')
    expect(KNOWN_DEPLOYMENTS.chat.some((n) => n.startsWith('claude'))).toBe(false)
    expect(KNOWN_DEPLOYMENTS.image).toEqual([
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2'
    ])
    expect(KNOWN_DEPLOYMENTS.embedding).toEqual([
      'text-embedding-3-large',
      'text-embedding-3-small'
    ])
    expect(KNOWN_DEPLOYMENTS.transcription).toEqual(['gpt-transcribe'])
  })
})

describe('testConnection', () => {
  const endpoint = 'https://my-res.openai.azure.com'
  const KEY = 'sk-test-0123456789abcdef'

  // A network that answers every request with one status.
  const answering = (status: number): typeof fetch =>
    (async () => new Response('{}', { status })) as typeof fetch

  it('asks for the list of models with the key in api-key, and says ok', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"object":"list","data":[]}', { status: 200 })
    }) as unknown as typeof fetch
    expect(await testConnection(`${endpoint}/`, KEY, fake)).toEqual({ health: 'ok', detail: null })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${endpoint}/openai/v1/models`)
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect(calls[0].init?.headers).toEqual({ 'api-key': KEY })
  })

  it('says why in plain words, and never repeats the key', async () => {
    const cases: [number, string][] = [
      [401, 'invalid'],
      [403, 'invalid'],
      [404, 'invalid'],
      [418, 'invalid'],
      [429, 'rate-limited'],
      [500, 'unreachable'],
      [503, 'unreachable']
    ]
    for (const [status, health] of cases) {
      const got = await testConnection(endpoint, KEY, answering(status))
      expect(got.health, String(status)).toBe(health)
      expect(got.detail, String(status)).toBeTruthy()
      expect(got.detail).not.toContain(KEY)
    }
    expect((await testConnection(endpoint, KEY, answering(401))).detail).toMatch(/key/i)
    expect((await testConnection(endpoint, KEY, answering(404))).detail).toMatch(
      /openai\.azure\.com/
    )
  })

  it('treats no network as unreachable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const got = await testConnection(endpoint, KEY, down)
    expect(got.health).toBe('unreachable')
    expect(got.detail).toMatch(/reach Azure/)
  })

  it('gives up after ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stuck = ((_url: string, init?: RequestInit) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )) as unknown as typeof fetch
      let done = false
      const pending = testConnection(endpoint, KEY, stuck).then((r) => {
        done = true
        return r
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await pending).health).toBe('unreachable')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- probing, against a stand-in for an Azure resource on this machine ----

interface Seen {
  path: string
  model: string
  billed: boolean // a well-formed request that reached a deployment that exists
}

interface Fake {
  url: string
  seen: Seen[] // requests that got past the key check
  requests: () => number // every request received
  peak: () => number
  close: () => Promise<void>
}

let running: Fake[] = []
afterEach(async () => {
  await Promise.all(running.map((f) => f.close()))
  running = []
})

// What Azure does with the four kinds of request, as far as the probe cares.
// `first` is the check Azure makes first: finding the deployment ("lookup", the
// assumption the probe leans on) or reading the request ("validate", which the
// probe has to detect and work around).
async function startFake(opts: {
  deployed: string[]
  first?: 'lookup' | 'validate'
  delayMs?: number
  key?: string
  failing?: Record<string, number>
  blocked?: string // a route (path prefix) that answers 403 to everything
}): Promise<Fake> {
  const seen: Seen[] = []
  let requests = 0
  let inflight = 0
  let peak = 0
  const reply = (res: ServerResponse, status: number, code: string, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message } }))
  }

  const answer = (req: IncomingMessage, raw: string, res: ServerResponse): void => {
    const path = req.url ?? ''
    if (req.headers['api-key'] !== (opts.key ?? 'good-key')) {
      return reply(res, 401, '401', 'Access denied due to invalid subscription key.')
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return void res.end('{"object":"list","data":[]}')
    }
    if (opts.blocked && path.startsWith(opts.blocked)) {
      return reply(res, 403, 'PermissionDenied', 'This route is not allowed.')
    }
    let model = ''
    let valid = false
    if (path.startsWith('/openai/v1/audio/transcriptions')) {
      model = /name="model"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1] ?? ''
      valid = raw.includes('name="file"')
    } else {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      model = String(body.model ?? '')
      if (path.startsWith('/openai/v1/responses')) {
        valid = 'input' in body && Number(body.max_output_tokens) >= 16
      } else if (path.startsWith('/openai/v1/embeddings')) {
        valid = 'input' in body
      } else if (path.startsWith('/openai/v1/images/generations')) {
        valid = 'prompt' in body
      }
    }
    const exists = opts.deployed.includes(model)
    seen.push({ path, model, billed: valid && exists })
    const failing = opts.failing?.[model]
    if (failing) return reply(res, failing, 'server_error', 'The server had an error.')
    const notFound = (): void =>
      reply(res, 404, 'DeploymentNotFound', 'The API deployment for this resource does not exist.')
    const invalid = (): void => reply(res, 400, 'invalid_request_error', 'The request is invalid.')
    const ok = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    if (opts.first === 'validate') {
      if (!valid) return invalid()
      return exists ? ok() : notFound()
    }
    if (!exists) return notFound()
    return valid ? ok() : invalid()
  }

  const server = createServer((req, res) => {
    requests++
    inflight++
    peak = Math.max(peak, inflight)
    res.on('close', () => inflight--)
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('latin1')
      setTimeout(() => answer(req, raw, res), opts.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const fake: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    requests: () => requests,
    peak: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  running.push(fake)
  return fake
}

const DEPLOYED = ['gpt-6-sol', 'gpt-4.1', 'text-embedding-3-large', 'gpt-image-2', 'gpt-transcribe']
const ALL_KNOWN = Object.values(KNOWN_DEPLOYMENTS).flat()

describe('probeDeployments', () => {
  it('finds what is deployed without sending a request that could be billed', async () => {
    const azure = await startFake({ deployed: DEPLOYED })
    const found = await probeDeployments(azure.url, 'good-key', ALL_KNOWN)

    expect(found).toEqual([
      { name: 'gpt-6-sol', model: 'gpt-6-sol', kind: 'chat', enabled: true, source: 'probe' },
      { name: 'gpt-4.1', model: 'gpt-4.1', kind: 'chat', enabled: true, source: 'probe' },
      { name: 'gpt-image-2', model: 'gpt-image-2', kind: 'image', enabled: true, source: 'probe' },
      {
        name: 'text-embedding-3-large',
        model: 'text-embedding-3-large',
        kind: 'embedding',
        enabled: true,
        source: 'probe'
      },
      {
        name: 'gpt-transcribe',
        model: 'gpt-transcribe',
        kind: 'transcription',
        enabled: true,
        source: 'probe'
      }
    ])
    // Not one of the requests was a real one.
    expect(azure.seen.filter((s) => s.billed)).toEqual([])
    // Each kind goes to its own route: preview for images and audio, none for the rest.
    const paths = new Set(azure.seen.map((s) => s.path))
    expect(paths).toEqual(
      new Set([
        '/openai/v1/responses',
        '/openai/v1/embeddings',
        '/openai/v1/images/generations?api-version=preview',
        '/openai/v1/audio/transcriptions?api-version=preview'
      ])
    )
    // A name that cannot exist is tried first, once for each kind.
    const controls = azure.seen.filter((s) => s.model.startsWith('orcha-probe-'))
    expect(controls.map((s) => s.path).sort()).toEqual([...paths].sort())
  })

  it('tries a name Orcha does not know as a chat model, and names the model it serves', async () => {
    const azure = await startFake({ deployed: ['my-fast-one', 'gpt-6-sol-2026-09-22'] })
    const found = await probeDeployments(azure.url, 'good-key', [
      'my-fast-one',
      'gpt-6-sol-2026-09-22',
      'nothing-here'
    ])
    expect(found).toEqual([
      { name: 'my-fast-one', model: null, kind: 'chat', enabled: true, source: 'probe' },
      {
        name: 'gpt-6-sol-2026-09-22',
        model: 'gpt-6-sol',
        kind: 'chat',
        enabled: true,
        source: 'probe'
      }
    ])
  })

  it('keeps the order given, and asks about each name once', async () => {
    const azure = await startFake({ deployed: ['gpt-5', 'gpt-4.1'] })
    const found = await probeDeployments(azure.url, 'good-key', [
      ' gpt-5 ',
      'gpt-4.1',
      'gpt-5',
      '',
      'gpt-4.1'
    ])
    expect(found.map((d) => d.name)).toEqual(['gpt-5', 'gpt-4.1'])
    expect(azure.seen.filter((s) => s.model === 'gpt-5')).toHaveLength(1)
  })

  it('falls back to the smallest real request when Azure reads the request before the name', async () => {
    const azure = await startFake({ deployed: DEPLOYED, first: 'validate' })
    const found = await probeDeployments(azure.url, 'good-key', ALL_KNOWN)

    // The three kinds with a cheap real request are still found...
    expect(found.map((d) => d.name).sort()).toEqual(
      ['gpt-4.1', 'gpt-6-sol', 'gpt-transcribe', 'text-embedding-3-large'].sort()
    )
    // ...at the price of one tiny request each, and none for an image.
    expect(
      azure.seen
        .filter((s) => s.billed)
        .map((s) => s.model)
        .sort()
    ).toEqual(['gpt-4.1', 'gpt-6-sol', 'gpt-transcribe', 'text-embedding-3-large'].sort())
    expect(azure.seen.some((s) => s.path.includes('images') && s.billed)).toBe(false)
    expect(found.some((d) => d.kind === 'image')).toBe(false)
  })

  it('tries four names at a time', async () => {
    const azure = await startFake({ deployed: ['gpt-5'], delayMs: 25 })
    const names = Array.from({ length: 24 }, (_, i) => `custom-${i}`)
    await probeDeployments(azure.url, 'good-key', names)
    expect(azure.peak()).toBeGreaterThan(1)
    expect(azure.peak()).toBeLessThanOrEqual(4)
  })

  it('stops and says so when Azure refuses the key', async () => {
    const azure = await startFake({ deployed: DEPLOYED, key: 'the-real-key' })
    const err = await probeDeployments(azure.url, 'wrong-key', ALL_KNOWN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'auth', status: 401 })
    expect((err as Error).message).toMatch(/key/)
    // It did not go on to try every name: one request per kind was enough to know.
    expect(azure.requests()).toBeLessThanOrEqual(4)
    expect(azure.requests()).toBeGreaterThan(0)
  })

  it('does not call the key refused because one route is', async () => {
    // The image route is not switched on for this resource; everything else works.
    const azure = await startFake({ deployed: DEPLOYED, blocked: '/openai/v1/images' })
    const found = await probeDeployments(azure.url, 'good-key', ALL_KNOWN)
    expect(found.map((d) => d.name)).toEqual([
      'gpt-6-sol',
      'gpt-4.1',
      'text-embedding-3-large',
      'gpt-transcribe'
    ])
  })

  it('says the key is refused when every route refuses it', async () => {
    const azure = await startFake({ deployed: DEPLOYED, blocked: '/openai/v1/' })
    const err = await probeDeployments(azure.url, 'good-key', ALL_KNOWN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'auth', status: 403 })
  })

  it('does not stop for a name that one deployment alone refuses', async () => {
    const answers = new Map([
      ['orcha-probe-nothing-deployed-here', 404],
      ['gpt-5', 403],
      ['gpt-4.1', 400]
    ])
    const fake = (async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      return new Response('{}', { status: answers.get(model) ?? 404 })
    }) as unknown as typeof fetch
    const found = await probeDeployments(
      'https://x.openai.azure.com',
      'k',
      ['gpt-5', 'gpt-4.1'],
      fake
    )
    expect(found.map((d) => d.name)).toEqual(['gpt-4.1'])
  })

  it('leaves out a name Azure could not answer for', async () => {
    const azure = await startFake({ deployed: ['gpt-5', 'gpt-4.1'], failing: { 'gpt-4.1': 503 } })
    const found = await probeDeployments(azure.url, 'good-key', ['gpt-5', 'gpt-4.1', 'gpt-4o'])
    expect(found.map((d) => d.name)).toEqual(['gpt-5'])
  })

  it('reports nothing for a kind whose missing names look no different', async () => {
    // Every answer, even for the control, says "invalid request": nothing to go on.
    const unsure = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch
    expect(await probeDeployments('https://x.openai.azure.com', 'k', ['gpt-5'], unsure)).toEqual([])
  })

  it('gives up on a request after ten seconds, and goes on with the rest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = ((_url: string, init?: RequestInit) => {
        const model = (JSON.parse(String(init?.body)) as { model: string }).model
        if (model === 'slow') {
          return new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          )
        }
        const status = model === 'gpt-5' ? 400 : 404
        return Promise.resolve(new Response('{}', { status }))
      }) as unknown as typeof fetch

      let done = false
      const pending = probeDeployments(
        'https://x.openai.azure.com',
        'k',
        ['slow', 'gpt-5', 'gone'],
        fake
      ).then((r) => {
        done = true
        return r
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await pending).map((d) => d.name)).toEqual(['gpt-5'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('testConnection against a local server', () => {
  it('works over a real connection', async () => {
    const azure = await startFake({ deployed: [] })
    expect(await testConnection(azure.url, 'good-key')).toEqual({ health: 'ok', detail: null })
    expect((await testConnection(azure.url, 'bad-key')).health).toBe('invalid')
  })
})
