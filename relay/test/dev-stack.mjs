// A complete relay on this machine for trying Orcha's guest mode at $0: the
// real Worker under `wrangler dev`, with Anthropic and Azure replaced by a fake
// upstream that answers every request with a short, well-formed reply (and a
// realistic usage block, so metering and budgets behave exactly as live).
//
//   node test/dev-stack.mjs            prints an invite link, runs until Ctrl+C
//
// Or import { startDevStack } to drive it from a test (the Mac smoke test does).
//
// Markers in the latest user message change the reply:
//   ORCHA_SLOW  streams for ~15 s, long enough for Orcha to see the session working
//   ORCHA_ASK   ends on a question with numbered options, so the session reads as blocked
//   ORCHA_MD    a reply using every kind of markdown chat renders (table, code, maths)
//   ORCHA_THINK streams some thinking (a reasoning summary for GPT) before the reply
//
// Requests the fake upstream receives are appended to .wrangler/dev-upstream.log.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_PORT = 9901
const RELAY_PORT = 8788
const RELAY = `http://127.0.0.1:${RELAY_PORT}`
const ADMIN = 'oa_dev_admin_token'
const LOG = join(relayDir, '.wrangler', 'dev-upstream.log')
const REPLY = 'Hello from the fake upstream. Nothing was billed for real.'
const SLOW_REPLY = Array.from({ length: 25 }, (_, i) => `step${i + 1}`).join(' ') + ' done.'
const ASK_REPLY = 'I can do this two ways.\n\n1. Alpha: the quick one\n2. Beta: the thorough one\n\nWhich one should I use?'
const MD_REPLY = [
  '## A quick tour',
  '',
  'Here is **bold**, *italic*, `inline code` and a [link](https://example.com).',
  '',
  '| Model | Speed | Cost |',
  '| --- | --- | --- |',
  '| Haiku | fast | low |',
  '| Opus | careful | high |',
  '',
  '```ts',
  'export function add(a: number, b: number): number {',
  '  // the sum',
  "  return a + b // 'ok'",
  '}',
  '```',
  '',
  'Euler: $e^{i\\pi} + 1 = 0$, and on its own line:',
  '',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '> A quote to finish.',
  '',
  '- [x] done',
  '- [ ] not yet'
].join('\n')
const THINKING = 'The user wants a short answer. I will keep it brief and friendly.'

const sse = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

// Text of the newest user turn, for both API shapes.
function lastUserText(parsed) {
  const turns = parsed.messages ?? (Array.isArray(parsed.input) ? parsed.input : [])
  const last = [...turns].reverse().find((m) => m.role === 'user')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return (last.content ?? []).map((c) => c.text ?? '').join('\n')
}

function replyFor(parsed) {
  const text = lastUserText(parsed)
  const thinking = text.includes('ORCHA_THINK') ? THINKING : null
  if (text.includes('ORCHA_SLOW')) return { reply: SLOW_REPLY, delay: 600, thinking }
  if (text.includes('ORCHA_ASK')) return { reply: ASK_REPLY, delay: 60, thinking }
  if (text.includes('ORCHA_MD')) return { reply: MD_REPLY, delay: 15, thinking }
  return { reply: REPLY, delay: 60, thinking }
}

const upstream = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  let parsed = {}
  try {
    parsed = JSON.parse(body)
  } catch {
    // not JSON
  }
  appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${req.url} model=${parsed.model ?? '-'} bytes=${body.length}\n`)
  const { reply, delay, thinking } = replyFor(parsed)

  if (req.url.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ input_tokens: 42 }))
  }
  if (req.url.startsWith('/v1/messages')) {
    const usage = { input_tokens: 1200, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0, output_tokens: 1 }
    const model = parsed.model ?? 'claude-sonnet-5'
    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { ...usage, output_tokens: 20 }
        })
      )
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage }
    })
    let index = 0
    if (thinking) {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      for (const word of thinking.split(' ')) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: word + ' ' } })
        await new Promise((r) => setTimeout(r, 80))
      }
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fake' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index })
      index++
    }
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const word of reply.split(' ')) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word + ' ' } })
      await new Promise((r) => setTimeout(r, delay))
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    sse(res, 'message_stop', { type: 'message_stop' })
    return res.end()
  }
  if (req.url.startsWith('/openai/v1/responses')) {
    const model = parsed.model ?? 'gpt-6-sol'
    const item = {
      type: 'message',
      id: 'msg_fake',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: reply, annotations: [] }]
    }
    const base = { id: 'resp_fake', object: 'response', created_at: Math.floor(Date.now() / 1000), model }
    const usage = {
      input_tokens: 30000,
      input_tokens_details: { cached_tokens: 25000, cache_write_tokens: 0 },
      output_tokens: 400,
      output_tokens_details: { reasoning_tokens: 300 },
      total_tokens: 30400
    }
    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ...base, status: 'completed', output: [item], usage }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let seq = 0
    sse(res, 'response.created', { type: 'response.created', sequence_number: seq++, response: { ...base, status: 'in_progress', output: [], usage: null } })
    for (const word of thinking ? thinking.split(' ') : []) {
      sse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', sequence_number: seq++, item_id: 'rs_fake', output_index: 0, summary_index: 0, delta: word + ' ' })
      await new Promise((r) => setTimeout(r, 80))
    }
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    for (const word of reply.split(' ')) {
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_fake', output_index: 0, content_index: 0, delta: word + ' ' })
      await new Promise((r) => setTimeout(r, delay))
    }
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item })
    sse(res, 'response.completed', {
      type: 'response.completed',
      sequence_number: seq++,
      response: {
        ...base,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 30000,
          input_tokens_details: { cached_tokens: 25000, cache_write_tokens: 0 },
          output_tokens: 400,
          output_tokens_details: { reasoning_tokens: 300 },
          total_tokens: 30400
        }
      }
    })
    return res.end()
  }
  res.writeHead(404).end()
})

// Starts the fake upstream and the real Worker, creates a guest with the given
// budgets, and returns everything a test needs plus stop().
export async function startDevStack({ caps = { claude: 200, sol: 50, astra: 100 } } = {}) {
  mkdirSync(join(relayDir, '.wrangler'), { recursive: true })
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))
  writeFileSync(
    join(relayDir, '.dev.vars'),
    [
      `ADMIN_TOKEN=${ADMIN}`,
      'ANTHROPIC_API_KEY=sk-dev-fake',
      'AZURE_API_KEY=az-dev-fake',
      `AZURE_ENDPOINT=http://127.0.0.1:${UPSTREAM_PORT}`,
      `ANTHROPIC_UPSTREAM=http://127.0.0.1:${UPSTREAM_PORT}`
    ].join('\n')
  )
  const state = join(relayDir, '.wrangler', 'dev-state')
  rmSync(state, { recursive: true, force: true })
  const windows = process.platform === 'win32'
  // npx is a .cmd on Windows (needs a shell); elsewhere it gets its own
  // process group so stop() can take workerd down with it.
  const wrangler = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', state],
    { cwd: relayDir, shell: windows, detached: !windows, windowsHide: true }
  )
  wrangler.stdout.on('data', (d) => appendFileSync(LOG, `[wrangler] ${d}`))
  wrangler.stderr.on('data', (d) => appendFileSync(LOG, `[wrangler] ${d}`))

  const stop = () => {
    upstream.close()
    if (windows) {
      spawn('taskkill', ['/pid', String(wrangler.pid), '/t', '/f'], { windowsHide: true })
    } else {
      try {
        process.kill(-wrangler.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    rmSync(join(relayDir, '.dev.vars'), { force: true })
  }

  for (let i = 0; ; i++) {
    const up = await fetch(`${RELAY}/health`).then((r) => r.ok).catch(() => false)
    if (up) break
    if (i > 180) {
      stop()
      throw new Error('wrangler dev never came up (see .wrangler/dev-upstream.log)')
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const created = await fetch(`${RELAY}/admin/guests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test friend', hostName: 'Div', caps })
  }).then((r) => r.json())

  return {
    relay: RELAY,
    admin: ADMIN,
    invite: created.inviteUrl,
    code: created.invite,
    guestId: created.guest.id,
    logPath: LOG,
    stop
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stack = await startDevStack()
  console.log(`RELAY ${stack.relay}`)
  console.log(`ADMIN ${stack.admin}`)
  console.log(`INVITE ${stack.invite}`)
  console.log(`GUEST ${stack.guestId}`)
  const stop = () => {
    stack.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
