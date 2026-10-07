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
//   ORCHA_FILES replies with what the message carried ("Received: image image/webp, …")
//   ORCHA_SYSTEM replies with the system prompt it was sent
//   ORCHA_CITE  searches the web, then answers citing two of the results
//   ORCHA_REMEMBER / ORCHA_FORGET  call the memory tool (save "Likes green tea.",
//               or remove the first memory in the system prompt); the reply
//               after the tool runs says what was sent back
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

// What the newest user turn carried besides its words, for ORCHA_FILES:
// "image image/webp, document paper.pdf, file notes.md" (either API's shape).
function attachedParts(parsed) {
  const turns = parsed.messages ?? (Array.isArray(parsed.input) ? parsed.input : [])
  const last = [...turns].reverse().find((m) => m.role === 'user')
  if (!last || !Array.isArray(last.content)) return 'nothing'
  const parts = []
  for (const c of last.content) {
    if (c.type === 'image') parts.push(`image ${c.source?.media_type}`)
    else if (c.type === 'input_image') parts.push(`image ${/^data:([^;]+)/.exec(c.image_url ?? '')?.[1]}`)
    else if (c.type === 'document') parts.push(`document ${c.title}`)
    else if (c.type === 'input_file') parts.push(`document ${c.filename}`)
    const file = /^<file name="([^"]+)">/.exec(c.text ?? '')
    if (file) parts.push(`file ${file[1]}`)
  }
  return parts.join(', ') || 'nothing'
}

// The system prompt as sent, for ORCHA_SYSTEM (either API's shape).
function systemPrompt(parsed) {
  if (Array.isArray(parsed.system)) return parsed.system.map((b) => b.text).join('\n')
  if (typeof parsed.system === 'string') return parsed.system
  const dev = (Array.isArray(parsed.input) ? parsed.input : []).find((m) => m.role === 'developer')
  return typeof dev?.content === 'string' ? dev.content : 'no system prompt'
}

// After a memory tool call: what came back, so a test can check the loop sent
// the right things (the call, its result, and for GPT its reasoning).
function toolFollowUp(parsed) {
  if (Array.isArray(parsed.messages)) {
    const [prev, last] = parsed.messages.slice(-2)
    const result = Array.isArray(last?.content) && last.content.find((c) => c.type === 'tool_result')
    if (!result) return null
    const call = Array.isArray(prev?.content) && prev.content.some((c) => c.type === 'tool_use')
    return `Got it. The tool said "${result.content}"${call ? ', after my call' : ''}.`
  }
  if (Array.isArray(parsed.input)) {
    const out = [...parsed.input].reverse().find((i) => i.type === 'function_call_output')
    if (!out) return null
    const sent = parsed.input.filter((i) => i.type).map((i) => i.type).join(', ')
    const encrypted = parsed.include?.includes('reasoning.encrypted_content') ? 'with' : 'without'
    return `Got it. The tool said "${out.output}". Sent back: ${sent}, ${encrypted} encrypted reasoning.`
  }
  return null
}

// ORCHA_REMEMBER / ORCHA_FORGET: the memory tool call the model makes.
function toolCallFor(parsed, text) {
  if (text.includes('ORCHA_REMEMBER')) return { action: 'remember', text: 'Likes green tea.' }
  if (text.includes('ORCHA_FORGET')) {
    const id = Number(/\[(\d+)\]/.exec(systemPrompt(parsed))?.[1])
    return { action: 'forget', id }
  }
  return null
}

function replyFor(parsed) {
  const followUp = toolFollowUp(parsed)
  if (followUp) return { reply: followUp, delay: 10, thinking: null }
  const text = lastUserText(parsed)
  const toolCall = toolCallFor(parsed, text)
  if (toolCall) return { reply: 'Noting that.', delay: 10, thinking: null, toolCall }
  const thinking = text.includes('ORCHA_THINK') ? THINKING : null
  if (text.includes('ORCHA_FILES')) return { reply: `Received: ${attachedParts(parsed)}.`, delay: 30, thinking }
  if (text.includes('ORCHA_SYSTEM')) return { reply: systemPrompt(parsed), delay: 5, thinking }
  if (text.includes('ORCHA_SLOW')) return { reply: SLOW_REPLY, delay: 600, thinking }
  if (text.includes('ORCHA_ASK')) return { reply: ASK_REPLY, delay: 60, thinking }
  if (text.includes('ORCHA_MD')) return { reply: MD_REPLY, delay: 15, thinking }
  if (text.includes('ORCHA_CITE')) return { reply: CITED.map((c) => c.text).join(''), delay: 20, thinking, cite: true }
  if (text.includes('ORCHA_ARTIFACT')) {
    const kind = Object.keys(ARTIFACTS).find((k) => text.includes(`ORCHA_ARTIFACT ${k}`)) ?? 'html'
    return { reply: `Here it is.\n\n${ARTIFACTS[kind]}\n\nOpen it beside the chat.`, delay: 8, thinking }
  }
  return { reply: REPLY, delay: 60, thinking }
}

// ORCHA_ARTIFACT <kind>: a reply carrying an artifact of that kind ("v2"
// rewrites the html one; "broken" throws when it runs).
const ARTIFACTS = {
  html: '<artifact identifier="hello-page" type="text/html" title="Hello page">\n<!doctype html>\n<html><body style="font-family:sans-serif"><h1>Hello from an artifact</h1><p id="p">version 1</p></body></html>\n</artifact>',
  v2: '<artifact identifier="hello-page" type="text/html" title="Hello page">\n<!doctype html>\n<html><body style="font-family:sans-serif"><h1>Hello again</h1><p id="p">version 2</p></body></html>\n</artifact>',
  react: [
    '<artifact identifier="sales-chart" type="application/vnd.react" title="Sales chart">',
    "import { useState } from 'react'",
    "import { LineChart, Line, XAxis, YAxis } from 'recharts'",
    "import { TrendingUp } from 'lucide-react'",
    'const data = [{ m: "Jan", v: 4 }, { m: "Feb", v: 7 }, { m: "Mar", v: 5 }, { m: "Apr", v: 9 }]',
    'export default function Sales() {',
    '  const [n, setN] = useState(0)',
    '  return (',
    '    <div className="p-6">',
    '      <h2 className="flex items-center gap-2 text-xl font-semibold"><TrendingUp size={20} /> Sales</h2>',
    '      <LineChart width={360} height={180} data={data}><XAxis dataKey="m" /><YAxis /><Line dataKey="v" stroke="#2563eb" /></LineChart>',
    '      <button className="mt-3 rounded bg-blue-600 px-3 py-1 text-white" onClick={() => setN(n + 1)}>Clicked {n}</button>',
    '    </div>',
    '  )',
    '}',
    '</artifact>'
  ].join('\n'),
  mermaid: '<artifact identifier="flow" type="application/vnd.mermaid" title="Flow">\ngraph TD\n  A[Ask] --> B[Answer]\n  B --> C[Artifact]\n</artifact>',
  svg: '<artifact identifier="dot" type="image/svg+xml" title="Dot">\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="48" fill="tomato"/></svg>\n</artifact>',
  broken: '<artifact identifier="oops" type="application/vnd.react" title="Broken app">\nexport default function Oops() {\n  throw new Error("Boom from the artifact")\n}\n</artifact>'
}

// ORCHA_CITE: a web search, then two sentences each citing a result.
const RESULTS = [
  { url: 'https://en.wikipedia.org/wiki/Paris', title: 'Paris - Wikipedia' },
  { url: 'https://www.britannica.com/place/Paris', title: 'Paris | History, Map & Facts | Britannica' }
]
const CITED = [
  { text: 'Paris is the capital of France.', source: 0 },
  { text: ' It is known for the Eiffel Tower.', source: 1 }
]

// Claude's shape: server_tool_use, web_search_tool_result, then text blocks
// carrying citations.
function citeAnthropic(res, first) {
  let index = first
  sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: 'srvtoolu_fake', name: 'web_search', input: {} } })
  sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"query":"capital of France"}' } })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  index++
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_fake',
      content: RESULTS.map((r) => ({ type: 'web_search_result', ...r, encrypted_content: 'x', page_age: null }))
    }
  })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  for (const c of CITED) {
    index++
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: [] } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: c.text } })
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', ...RESULTS[c.source], cited_text: c.text, encrypted_index: 'x' } }
    })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  }
}

// GPT's shape: web_search_call events, the text, then url_citation annotations
// with character ranges.
function citeResponses(res, nextSeq) {
  const events = []
  let at = 0
  for (const c of CITED) {
    events.push({
      type: 'response.output_text.annotation.added',
      item_id: 'msg_fake',
      output_index: 1,
      content_index: 0,
      annotation: { type: 'url_citation', ...RESULTS[c.source], start_index: at, end_index: at + c.text.length }
    })
    at += c.text.length
  }
  for (const e of events) sse(res, e.type, { ...e, sequence_number: nextSeq() })
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
  const { reply, delay, thinking, cite, toolCall } = replyFor(parsed)

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
    if (cite) {
      citeAnthropic(res, index)
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const word of reply.split(' ')) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word + ' ' } })
        await new Promise((r) => setTimeout(r, delay))
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    }
    if (toolCall) {
      index++
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_fake', name: 'memory', input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    }
    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20, ...(cite ? { server_tool_use: { web_search_requests: 1 } } : {}) }
    })
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
    if (cite) {
      for (const t of ['added', 'in_progress', 'searching', 'completed']) {
        const type = t === 'added' ? 'response.output_item.added' : `response.web_search_call.${t}`
        sse(res, type, { type, sequence_number: seq++, output_index: 0, item_id: 'ws_fake', item: { type: 'web_search_call', id: 'ws_fake', status: 'in_progress' } })
      }
    }
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    // A citing reply arrives as its two sentences (no extra spaces between
    // words), so the annotation ranges line up.
    for (const piece of cite ? CITED.map((c) => c.text) : reply.split(' ').map((w) => w + ' ')) {
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: 'msg_fake', output_index: 0, content_index: 0, delta: piece })
      await new Promise((r) => setTimeout(r, delay))
    }
    if (cite) citeResponses(res, () => seq++)
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item })
    if (toolCall) {
      const reasoning = { type: 'reasoning', id: 'rs_fake', summary: [], encrypted_content: 'enc-fake' }
      const call = { type: 'function_call', id: 'fc_fake', call_id: 'call_fake', name: 'memory', arguments: JSON.stringify(toolCall), status: 'completed' }
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 1, item: reasoning })
      sse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', sequence_number: seq++, item_id: 'fc_fake', output_index: 2, arguments: call.arguments })
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 2, item: call })
    }
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
