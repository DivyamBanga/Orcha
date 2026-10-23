import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelPull } from '../../shared/ai'
import {
  contextSize,
  describeFailure,
  kvBytesPerToken,
  locateOllama,
  OllamaManager,
  ollamaBaseUrl,
  readNdjson,
  thinkSupport,
  TARGET_CONTEXT,
  type OllamaManagerOptions
} from './ollama'
import { fakeOllama, json, ndjson, sleep, type FakeHandler, type FakeOllama } from './ollamaFake'

const GIB = 1024 ** 3
// The laptop this was measured on: 31.6 GiB, of which Windows lets the GPU use 57%.
const LAPTOP = 31.6 * GIB

// ---- what a real Ollama (0.40.8) answered for qwen3.5, trimmed ----

const THINKING_CAPS = ['completion', 'vision', 'tools', 'thinking']
const tag = (name: string, size: number, digest: string, over: object = {}): object => ({
  name,
  model: name,
  size,
  digest,
  details: {
    family: 'qwen35',
    parameter_size: name.endsWith('9b') ? '9.7B' : '4.7B',
    quantization_level: 'Q4_K_M',
    context_length: 262144
  },
  capabilities: THINKING_CAPS,
  ...over
})
const TAGS = {
  models: [
    tag('qwen3.5:4b', 3389983735, 'd4'),
    tag('qwen3.5:9b', 6594474711, 'd9'),
    tag('gpt-oss:20b', 13_800_000_000, 'dg', {
      details: { family: 'gptoss', parameter_size: '20.9B', quantization_level: 'MXFP4' },
      capabilities: ['completion', 'tools', 'thinking']
    }),
    tag('qwen3-embedding:0.6b', 639_000_000, 'de', { capabilities: ['embedding'] }),
    tag('gpt-oss:120b-cloud', 384, 'dc', {
      remote_model: 'gpt-oss:120b',
      remote_host: 'https://ollama.com:443'
    })
  ]
}
// Qwen3.5 is half attention layers' worth of KV: 4 KV heads on every fourth layer.
const QWEN_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.block_count': 32,
  'qwen35.attention.head_count': 16,
  'qwen35.attention.head_count_kv': Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 4 : 0)),
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.embedding_length': 2560,
  'qwen35.context_length': 262144
}
const SHOW: Record<string, object> = {
  'qwen3.5:4b': {
    capabilities: THINKING_CAPS,
    thinking: { values: [false, true], default: true },
    model_info: QWEN_INFO
  },
  'qwen3.5:9b': {
    capabilities: THINKING_CAPS,
    thinking: { values: [false, true], default: true },
    model_info: { ...QWEN_INFO, 'qwen35.embedding_length': 4096 }
  },
  'gpt-oss:20b': {
    capabilities: ['completion', 'tools', 'thinking'],
    thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
    model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 }
  },
  'qwen3-embedding:0.6b': { capabilities: ['embedding'], model_info: {} }
}

// An Ollama that knows these models, with the 9B loaded.
function ollama(over: Record<string, (res: Parameters<FakeHandler>[1]) => void> = {}): FakeHandler {
  return (req, res) => {
    const route = over[`${req.method} ${req.path}`]
    if (route) return route(res)
    if (req.path === '/api/version') return json(res, 200, { version: '0.40.8' })
    if (req.path === '/api/tags') return json(res, 200, TAGS)
    if (req.path === '/api/ps') {
      const models = [
        {
          name: 'qwen3.5:9b',
          size: 5762732522,
          size_vram: 5762732522,
          context_length: 8192,
          expires_at: '2026-10-22T21:27:22.6027414-04:00'
        }
      ]
      return json(res, 200, { models })
    }
    if (req.path === '/api/show') {
      const found = SHOW[String(req.body?.model)]
      return found
        ? json(res, 200, found)
        : json(res, 404, { error: `model '${req.body?.model}' not found` })
    }
    json(res, 404, { error: 'nope' })
  }
}

const servers: FakeOllama[] = []
async function serve(handler: FakeHandler): Promise<FakeOllama> {
  const server = await fakeOllama(handler)
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

// An address where nothing is listening, and its port.
async function nobody(): Promise<{ url: string; port: number }> {
  const gone = await fakeOllama(() => {})
  await gone.close()
  return { url: gone.url, port: Number(new URL(gone.url).port) }
}

const manager = (url: string, over: OllamaManagerOptions = {}): OllamaManager =>
  new OllamaManager({ baseURL: url, totalMemory: () => LAPTOP, ...over })

describe('Ollama running or not', () => {
  it('says it is running, with its version', async () => {
    const server = await serve(ollama())
    expect(await manager(server.url).status()).toEqual({ status: 'running', version: '0.40.8' })
  })

  it('says stopped when it is installed but not answering, and missing when it is not installed', async () => {
    const { url } = await nobody()
    const launch = { file: 'ollama app.exe', args: [] }
    expect(await manager(url, { locate: () => launch }).status()).toEqual({
      status: 'stopped',
      version: null
    })
    expect(await manager(url, { locate: () => null }).status()).toEqual({
      status: 'missing',
      version: null
    })
  })

  it('does not wait on an Ollama that hangs', async () => {
    const server = await serve(() => {})
    const started = Date.now()
    const status = await manager(server.url, { locate: () => null, statusTimeoutMs: 60 }).status()
    expect(status.status).toBe('missing')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('starting Ollama', () => {
  // A spawn that records how it was called, and whose process comes up as the test says.
  function spawner(onSpawn: () => void = () => {}): {
    calls: { file: string; args: string[]; options: SpawnOptions }[]
    child: { unrefs: number; fail: ((err: Error) => void) | null }
    spawn: NonNullable<OllamaManagerOptions['spawn']>
  } {
    const calls: { file: string; args: string[]; options: SpawnOptions }[] = []
    const child = { unrefs: 0, fail: null as ((err: Error) => void) | null }
    const spawn: NonNullable<OllamaManagerOptions['spawn']> = (file, args, options) => {
      calls.push({ file, args, options })
      onSpawn()
      return {
        on: (_event, listener) => (child.fail = listener),
        unref: () => child.unrefs++
      }
    }
    return { calls, child, spawn }
  }
  const launch = { file: 'C:\\Ollama\\ollama.exe', args: ['serve'] }

  it('leaves a running Ollama alone', async () => {
    const server = await serve(ollama())
    const { calls, spawn } = spawner()
    await manager(server.url, { spawn, locate: () => launch }).ensureRunning()
    expect(calls).toEqual([])
  })

  it('starts it hidden and detached, then waits until it answers', async () => {
    const { url, port } = await nobody()
    const { calls, child, spawn } = spawner(() => {
      // Ollama takes a moment to come up.
      setTimeout(() => void fakeOllama(ollama(), port).then((s) => servers.push(s)), 40)
    })
    const m = manager(url, { spawn, locate: () => launch, pollMs: 10, statusTimeoutMs: 200 })
    await m.ensureRunning()
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(launch.file)
    expect(calls[0].args).toEqual(['serve'])
    expect(calls[0].options).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' })
    expect(child.unrefs).toBe(1)
    expect((await m.status()).status).toBe('running')
  })

  it('starts it once however many chats ask, and says so while it starts', async () => {
    const { url } = await nobody()
    const { calls, spawn } = spawner()
    const m = manager(url, {
      spawn,
      locate: () => launch,
      pollMs: 10,
      startTimeoutMs: 150,
      statusTimeoutMs: 100
    })
    const both = Promise.allSettled([m.ensureRunning(), m.ensureRunning()])
    expect((await m.status()).status).toBe('starting')
    const [a, b] = await both
    expect(calls).toHaveLength(1)
    expect([a.status, b.status]).toEqual(['rejected', 'rejected'])
    // Once it has given up it can be tried again.
    expect((await m.status()).status).toBe('stopped')
  })

  it('gives up after its time is up, in plain words', async () => {
    const { url } = await nobody()
    const m = manager(url, {
      spawn: spawner().spawn,
      locate: () => launch,
      pollMs: 10,
      startTimeoutMs: 80,
      statusTimeoutMs: 50
    })
    await expect(m.ensureRunning()).rejects.toThrow(/didn't start within/)
  })

  it('says so when Ollama is not installed', async () => {
    const { url } = await nobody()
    await expect(manager(url, { locate: () => null }).ensureRunning()).rejects.toThrow(
      /isn't installed on this computer/
    )
  })

  it('says so when it could not be launched', async () => {
    const { url } = await nobody()
    const { child, spawn } = spawner()
    const m = manager(url, {
      spawn,
      locate: () => launch,
      pollMs: 10,
      startTimeoutMs: 2000,
      statusTimeoutMs: 50
    })
    const started = m.ensureRunning()
    await sleep(20)
    child.fail?.(new Error('spawn EACCES'))
    await expect(started).rejects.toThrow("Ollama couldn't be started: spawn EACCES")
  })

  it('finds the installed ollama first, then ollama on the PATH', () => {
    const app = join(
      'C:',
      'Users',
      'me',
      'AppData',
      'Local',
      'Programs',
      'Ollama',
      process.platform === 'win32' ? 'ollama.exe' : 'ollama'
    )
    expect(
      locateOllama(
        { LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local') },
        (file) => file === app
      )
    ).toEqual({ file: app, args: ['serve'] })

    const dir = mkdtempSync(join(tmpdir(), 'orcha-ollama-'))
    mkdirSync(dir, { recursive: true })
    const cli = join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama')
    writeFileSync(cli, '')
    chmodSync(cli, 0o755)
    expect(locateOllama({ PATH: dir }, () => false)).toEqual({ file: cli, args: ['serve'] })
    expect(locateOllama({ PATH: '' }, () => false)).toBeNull()
  })

  it('follows OLLAMA_HOST, always as 127.0.0.1 for this computer', () => {
    const at = (OLLAMA_HOST?: string): string => ollamaBaseUrl({ OLLAMA_HOST })
    expect(at(undefined)).toBe('http://127.0.0.1:11434')
    expect(at('')).toBe('http://127.0.0.1:11434')
    expect(at('127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
    expect(at('0.0.0.0')).toBe('http://127.0.0.1:11434')
    expect(at('0.0.0.0:8080')).toBe('http://127.0.0.1:8080')
    expect(at(':9999')).toBe('http://127.0.0.1:9999')
    expect(at('localhost:11500')).toBe('http://127.0.0.1:11500')
    expect(at('[::]:11434')).toBe('http://127.0.0.1:11434')
    expect(at('http://gpu-box:11434')).toBe('http://gpu-box:11434')
    expect(at('gpu-box')).toBe('http://gpu-box:11434')
    expect(at('https://gpu-box')).toBe('https://gpu-box:443')
  })
})

describe('installed models', () => {
  it('lists them with what each can do, without cloud models', async () => {
    const server = await serve(ollama())
    const models = await manager(server.url).listModels()
    expect(models.map((m) => m.name)).toEqual([
      'qwen3.5:4b',
      'qwen3.5:9b',
      'gpt-oss:20b',
      'qwen3-embedding:0.6b'
    ])
    expect(models[0]).toEqual({
      name: 'qwen3.5:4b',
      sizeBytes: 3389983735,
      family: 'qwen35',
      parameters: '4.7B',
      quantization: 'Q4_K_M',
      capabilities: THINKING_CAPS,
      think: true,
      contextMax: 262144,
      context: 32768,
      loaded: false
    })
    expect(models[1].loaded).toBe(true)
    // Levels come from what /api/show lists; the window from the model's own info.
    expect(models[2].think).toEqual(['low', 'medium', 'high'])
    expect(models[2].contextMax).toBe(131072)
    expect(models[3]).toMatchObject({ capabilities: ['embedding'], think: false })
  })

  it('asks about each model once, and again when it changes', async () => {
    const server = await serve(ollama())
    const m = manager(server.url)
    await m.listModels()
    const asked = (): string[] =>
      server.requests.filter((r) => r.path === '/api/show').map((r) => String(r.body?.model))
    expect(asked()).toHaveLength(4)

    await m.listModels()
    expect(asked()).toHaveLength(4)

    // The same name with different contents (it was pulled again).
    const changed = await serve(
      ollama({
        'GET /api/tags': (res) =>
          json(res, 200, { models: [tag('qwen3.5:4b', 3389983735, 'new digest')] })
      })
    )
    const again = manager(changed.url)
    await again.listModels()
    await again.listModels()
    expect(changed.requests.filter((r) => r.path === '/api/show')).toHaveLength(1)
  })

  it('still lists them when Ollama will not describe them', async () => {
    const server = await serve(
      ollama({ 'POST /api/show': (res) => json(res, 500, { error: 'boom' }) })
    )
    const m = manager(server.url)
    const models = await m.listModels()
    expect(models).toHaveLength(4)
    expect(models[0]).toMatchObject({
      capabilities: THINKING_CAPS,
      think: true,
      contextMax: 262144
    })
    // gpt-oss is the one family that takes levels, when Ollama doesn't say.
    expect(models[2].think).toEqual(['low', 'medium', 'high'])
    // It asks again next time.
    await m.listModels()
    expect(server.requests.filter((r) => r.path === '/api/show')).toHaveLength(8)
  })

  it('reports what is in memory, whoever loaded it', async () => {
    const server = await serve(ollama())
    expect(await manager(server.url).loaded()).toEqual([
      {
        name: 'qwen3.5:9b',
        sizeBytes: 5762732522,
        vramBytes: 5762732522,
        context: 8192,
        expiresAt: Date.parse('2026-10-22T21:27:22.602-04:00')
      }
    ])
  })

  it('says Ollama is not running when it is not', async () => {
    const { url } = await nobody()
    await expect(manager(url).listModels()).rejects.toThrow("Ollama isn't running")
  })

  it('works out how a model thinks', () => {
    expect(thinkSupport('qwen3.5:4b', THINKING_CAPS, { values: [false, true] })).toBe(true)
    expect(
      thinkSupport('gpt-oss:20b', ['thinking'], { values: ['low', 'medium', 'high'] })
    ).toEqual(['low', 'medium', 'high'])
    expect(thinkSupport('x', ['thinking'], { values: [false] })).toBe(false)
    expect(thinkSupport('llama3.2:3b', ['completion', 'tools'], undefined)).toBe(false)
    // An older Ollama says only that a model thinks.
    expect(thinkSupport('qwen3:8b', ['thinking'], undefined)).toBe(true)
    expect(thinkSupport('gpt-oss:20b', ['thinking'], undefined)).toEqual(['low', 'medium', 'high'])
  })
})

describe('loading and unloading', () => {
  it('loads a model with the context a chat would use', async () => {
    const server = await serve(
      ollama({ 'POST /api/chat': (res) => json(res, 200, { done: true, done_reason: 'load' }) })
    )
    const m = manager(server.url)
    await m.listModels()
    await m.load('qwen3.5:4b')
    const sent = server.requests.find((r) => r.path === '/api/chat')?.body
    expect(sent).toEqual({
      model: 'qwen3.5:4b',
      messages: [],
      stream: false,
      keep_alive: '5m',
      options: { num_ctx: 32768 }
    })
  })

  it('unloads a model with keep_alive 0', async () => {
    const server = await serve(
      ollama({
        'POST /api/generate': (res) => json(res, 200, { done: true, done_reason: 'unload' })
      })
    )
    await manager(server.url).unload('qwen3.5:9b')
    expect(server.requests.find((r) => r.path === '/api/generate')?.body).toEqual({
      model: 'qwen3.5:9b',
      stream: false,
      keep_alive: 0
    })
  })

  it('says a model is not downloaded when it is not', async () => {
    const server = await serve(
      ollama({
        'POST /api/generate': (res) => json(res, 404, { error: "model 'nope:1b' not found" })
      })
    )
    await expect(manager(server.url).unload('nope:1b')).rejects.toThrow(
      /"nope:1b" isn't downloaded/
    )
  })
})

describe('deleting models', () => {
  const gone = (res: Parameters<FakeHandler>[1]): void => {
    res.writeHead(200)
    res.end()
  }

  it('deletes by name', async () => {
    const server = await serve(ollama({ 'DELETE /api/delete': gone }))
    await manager(server.url).remove('qwen3.5:4b')
    const sent = server.requests.find((r) => r.method === 'DELETE')
    expect(sent?.path).toBe('/api/delete')
    expect(sent?.body).toEqual({ model: 'qwen3.5:4b' })
  })

  it('counts a model that is already gone as deleted', async () => {
    const server = await serve(
      ollama({ 'DELETE /api/delete': (res) => json(res, 404, { error: "model 'x' not found" }) })
    )
    await expect(manager(server.url).remove('x')).resolves.toBeUndefined()
  })

  it('reports any other failure', async () => {
    const server = await serve(
      ollama({ 'DELETE /api/delete': (res) => json(res, 500, { error: 'disk on fire' }) })
    )
    await expect(manager(server.url).remove('x')).rejects.toThrow('disk on fire')
  })
})

describe('downloading models', () => {
  // The lines a real pull sends, trimmed: layers download side by side, and
  // total and completed are left out while they are zero.
  const layers =
    (lines: object[]): FakeHandler =>
    (req, res) => {
      if (req.path === '/api/pull') return ndjson(res, lines)
      json(res, 404, {})
    }
  const a = (completed?: number): object => ({
    status: 'pulling aaaaaaaaaaaa',
    digest: 'sha256:aaaa',
    total: 100,
    ...(completed ? { completed } : {})
  })
  const b = (completed?: number): object => ({
    status: 'pulling bbbbbbbbbbbb',
    digest: 'sha256:bbbb',
    total: 300,
    ...(completed ? { completed } : {})
  })

  it('adds the layers up into one progress', async () => {
    const server = await serve(
      layers([
        { status: 'pulling manifest' },
        a(),
        b(),
        a(60),
        b(150),
        a(100),
        b(300),
        { status: 'verifying sha256 digest' },
        { status: 'writing manifest' },
        { status: 'success' }
      ])
    )
    const seen: ModelPull[] = []
    await manager(server.url).pull('qwen3.5:2b', (p) => seen.push(p))
    expect(seen.map((p) => [p.status, p.completed, p.total])).toEqual([
      ['pulling manifest', 0, 0],
      ['downloading', 0, 100],
      ['downloading', 0, 400],
      ['downloading', 60, 400],
      ['downloading', 210, 400],
      ['downloading', 250, 400],
      ['downloading', 400, 400],
      ['verifying sha256 digest', 400, 400],
      ['writing manifest', 400, 400],
      ['success', 400, 400]
    ])
    expect(seen.every((p) => p.name === 'qwen3.5:2b' && p.error === null)).toBe(true)
    expect(server.requests[0].body).toEqual({ model: 'qwen3.5:2b', stream: true })
  })

  it('fails on an error line even though the answer was 200', async () => {
    const server = await serve(
      layers([
        { status: 'pulling manifest' },
        { error: 'pull model manifest: file does not exist' }
      ])
    )
    const seen: ModelPull[] = []
    await expect(manager(server.url).pull('nope:1b', (p) => seen.push(p))).rejects.toThrow(
      'Ollama has no model called "nope:1b"'
    )
    // The failure is reported as progress too, for the downloads list.
    expect(seen.at(-1)).toMatchObject({
      name: 'nope:1b',
      status: 'failed',
      error: expect.stringContaining('no model called')
    })
  })

  it('puts other download failures in plain words', async () => {
    const server = await serve(
      layers([
        {
          error: 'pull model manifest: Get "https://registry.ollama.ai/v2": dial tcp: no such host'
        }
      ])
    )
    await expect(manager(server.url).pull('x', () => {})).rejects.toThrow(
      /couldn't reach its download server/
    )
  })

  it('fails when the stream ends before it finishes', async () => {
    const server = await serve(layers([{ status: 'pulling manifest' }, a(50)]))
    const seen: ModelPull[] = []
    await expect(manager(server.url).pull('x', (p) => seen.push(p))).rejects.toThrow(
      /stopped early/
    )
    expect(seen.at(-1)?.status).toBe('failed')
  })

  it('fails on an HTTP error', async () => {
    const server = await serve((_req, res) => json(res, 500, { error: 'boom' }))
    await expect(manager(server.url).pull('x', () => {})).rejects.toThrow('boom')
  })

  it('stops when told to, without calling that a failure', async () => {
    const server = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (let i = 1; i <= 100 && !res.destroyed; i++) {
        res.write(JSON.stringify(i === 1 ? a() : a(i)) + '\n')
        await sleep(5)
      }
      res.end()
    })
    const stop = new AbortController()
    const seen: ModelPull[] = []
    const pulling = manager(server.url).pull(
      'x',
      (p) => {
        seen.push(p)
        if (seen.length === 3) stop.abort()
      },
      stop.signal
    )
    await expect(pulling).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen.some((p) => p.error !== null)).toBe(false)
  })

  it('says Ollama is not running when it is not', async () => {
    const { url } = await nobody()
    const seen: ModelPull[] = []
    await expect(manager(url).pull('x', (p) => seen.push(p))).rejects.toThrow(
      "Ollama isn't running"
    )
    expect(seen).toHaveLength(1)
  })
})

describe('context size', () => {
  const qwen = (sizeBytes: number): Parameters<typeof contextSize>[0] => ({
    sizeBytes,
    kvBytesPerToken: 32768,
    contextMax: 262144
  })

  it('gives the 4B and 9B on the laptop the target', () => {
    expect(contextSize(qwen(3389983735), LAPTOP * 0.57)).toBe(32768)
    expect(contextSize(qwen(6594474711), LAPTOP * 0.57)).toBe(32768)
    expect(TARGET_CONTEXT).toBe(32768)
  })

  it('gives a model that barely fits less, as a power of two', () => {
    // 17 GB of weights leaves 0.67 GiB for context: 10,900 tokens at 64 KiB each.
    const big = { sizeBytes: 17e9, kvBytesPerToken: 64 * 1024, contextMax: 262144 }
    expect(contextSize(big, LAPTOP * 0.57)).toBe(8192)
    // One that doesn't fit at all still gets a window to work in.
    expect(contextSize({ ...big, sizeBytes: 30e9 }, LAPTOP * 0.57)).toBe(4096)
  })

  it('never goes past the model’s own limit', () => {
    const small = (contextMax: number): number =>
      contextSize({ ...qwen(1e9), contextMax }, LAPTOP * 0.57)
    expect(small(8192)).toBe(8192)
    expect(small(40960)).toBe(32768)
    expect(small(6000)).toBe(4096)
    expect(
      contextSize({ sizeBytes: 1e9, kvBytesPerToken: null, contextMax: null }, LAPTOP * 0.57)
    ).toBe(32768)
  })

  it('gives a model the same number every time, once the list is known', async () => {
    const server = await serve(ollama())
    const m = manager(server.url)
    // Before the list it only knows the target.
    expect(m.contextFor('qwen3.5:9b')).toBe(32768)
    await m.listModels()
    const first = ['qwen3.5:4b', 'qwen3.5:9b', 'gpt-oss:20b'].map(m.contextFor)
    await m.listModels()
    expect(['qwen3.5:4b', 'qwen3.5:9b', 'gpt-oss:20b'].map(m.contextFor)).toEqual(first)
    // A computer with little memory gets a smaller window for the same model.
    const tight = manager(server.url, { totalMemory: () => 14 * GIB })
    await tight.listModels()
    expect(tight.contextFor('qwen3.5:9b')).toBe(8192)
    expect(tight.contextFor('qwen3.5:4b')).toBe(32768)
  })

  it('works out KV cache per token from the model’s own description', () => {
    // Qwen3.5: 8 attention layers x 4 KV heads x (256 + 256) x 2 bytes = 32 KiB.
    expect(kvBytesPerToken(QWEN_INFO)).toBe(32 * 1024)
    // A dense model with 8 KV heads of 128: 32 layers x 8 x 256 x 2 = 128 KiB.
    expect(
      kvBytesPerToken({
        'general.architecture': 'llama',
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096
      })
    ).toBe(128 * 1024)
    expect(kvBytesPerToken(undefined)).toBeNull()
    expect(kvBytesPerToken({ 'general.architecture': 'mystery' })).toBeNull()
  })
})

describe('reading streams and failures', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  const streamOf = (...parts: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(bytes(part))
        controller.close()
      }
    })

  it('puts a line back together when it arrives in pieces', async () => {
    const lines: object[] = []
    for await (const line of readNdjson(streamOf('{"a":1}\n{"b"', ':2}\n{"c":3}'))) lines.push(line)
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('keeps a character that is split between pieces whole', async () => {
    const euro = bytes('{"x":"€"}\n') // 3 bytes for the euro sign
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro.slice(0, 7))
        controller.enqueue(euro.slice(7))
        controller.close()
      }
    })
    const lines: object[] = []
    for await (const line of readNdjson(stream)) lines.push(line)
    expect(lines).toEqual([{ x: '€' }])
  })

  it('skips blank and broken lines', async () => {
    const lines: object[] = []
    for await (const line of readNdjson(streamOf('\n{"a":1}\nnot json\n\n{"b":2}\n')))
      lines.push(line)
    expect(lines).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('puts failures in plain words', () => {
    expect(describeFailure(404, `{"error":"model 'x:1b' not found"}`, 'x:1b')).toEqual({
      code: 'not-found',
      message: `"x:1b" isn't downloaded. Download it from the local models settings, then try again.`
    })
    expect(
      describeFailure(400, `{"error":"\\"all-minilm\\" does not support chat"}`, 'all-minilm')
    ).toMatchObject({
      code: 'bad-request',
      message: expect.stringContaining("can't chat")
    })
    expect(describeFailure(503, '{"error":"server busy"}')).toMatchObject({ code: 'overloaded' })
    expect(describeFailure(401, '{"error":"unauthorized"}')).toMatchObject({ code: 'auth' })
    expect(
      describeFailure(
        500,
        '{"error":"model requires more system memory (9.0 GiB) than is available (4.1 GiB)"}',
        'big'
      )
    ).toMatchObject({ code: 'unknown', message: expect.stringContaining('enough free memory') })
    // The runner's own error arrives as JSON inside the string.
    const inner = {
      code: 400,
      message: 'request (5233 tokens) exceeds the available context size (4096 tokens)',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 5233,
      n_ctx: 4096
    }
    expect(
      describeFailure(400, JSON.stringify({ error: JSON.stringify(inner) }), 'qwen3.5:4b')
    ).toEqual({
      code: 'context-full',
      message:
        'This conversation is too long for "qwen3.5:4b" (it holds 4096 tokens). Start a new chat or shorten it.'
    })
    expect(describeFailure(500, 'plain text from a proxy')).toEqual({
      code: 'unknown',
      message: 'Ollama reported a problem: plain text from a proxy'
    })
  })
})
