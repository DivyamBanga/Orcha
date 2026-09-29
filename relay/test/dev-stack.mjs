// A complete relay on this machine for trying Orcha's guest mode at $0: the
// real Worker under `wrangler dev`, with Anthropic and Azure replaced by a fake
// upstream that answers every request with a short, well-formed reply (and a
// realistic usage block, so metering and budgets behave exactly as live).
//
//   node test/dev-stack.mjs            prints an invite link, runs until Ctrl+C
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

const sse = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

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
          content: [{ type: 'text', text: REPLY }],
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
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const word of REPLY.split(' ')) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word + ' ' } })
      await new Promise((r) => setTimeout(r, 60))
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
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
      content: [{ type: 'output_text', text: REPLY, annotations: [] }]
    }
    const base = { id: 'resp_fake', object: 'response', created_at: Math.floor(Date.now() / 1000), model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let seq = 0
    sse(res, 'response.created', { type: 'response.created', sequence_number: seq++, response: { ...base, status: 'in_progress', output: [], usage: null } })
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    for (const word of REPLY.split(' ')) {
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_fake', output_index: 0, content_index: 0, delta: word + ' ' })
      await new Promise((r) => setTimeout(r, 60))
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
const wrangler = spawn(
  'npx',
  ['wrangler', 'dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', state],
  { cwd: relayDir, shell: true, windowsHide: true }
)
wrangler.stderr.on('data', (d) => appendFileSync(LOG, `[wrangler] ${d}`))
for (let i = 0; ; i++) {
  const up = await fetch(`${RELAY}/health`).then((r) => r.ok).catch(() => false)
  if (up) break
  if (i > 120) throw new Error('wrangler dev never came up')
  await new Promise((r) => setTimeout(r, 500))
}

const created = await fetch(`${RELAY}/admin/guests`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Test friend', hostName: 'Div', caps: { claude: 200, sol: 50, astra: 100 } })
}).then((r) => r.json())
console.log(`RELAY ${RELAY}`)
console.log(`ADMIN ${ADMIN}`)
console.log(`INVITE ${created.inviteUrl}`)
console.log(`GUEST ${created.guest.id}`)

const stop = () => {
  upstream.close()
  spawn('taskkill', ['/pid', String(wrangler.pid), '/t', '/f'], { windowsHide: true })
  rmSync(join(relayDir, '.dev.vars'), { force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
