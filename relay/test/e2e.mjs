// End-to-end check of the whole relay at $0: runs the real Worker under
// `wrangler dev` (local workerd + a local SQLite Durable Object) with both
// providers pointed at a fake upstream on this machine. Exercises invites,
// streaming passthrough, metering, the ledger, budget blocking, top-up,
// revoke, and interrupted replies.
//
//   node test/e2e.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_PORT = 9901
const RELAY_PORT = 8788
const RELAY = `http://127.0.0.1:${RELAY_PORT}`
const ADMIN = 'oa_e2e_admin_token'
const seen = [] // requests the fake upstream received

const sseEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

// Sonnet 5 reply: 1000 input + 50000 cache read + 2000 1h cache write + 500 out
// = 0.002 + 0.01 + 0.008 + 0.005 = $0.025
const ANTHROPIC_COST = 0.025
// Sol reply: 20000 input of which 15000 cached, 1000 out
// = 5000*2e-6 + 15000*0.2e-6 + 1000*10e-6 = 0.01 + 0.003 + 0.01 = $0.023
const SOL_COST = 0.023

const upstream = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  seen.push({ url: req.url, headers: req.headers, body })
  if (req.url === '/v1/messages/count_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ input_tokens: 42 }))
  }
  if (req.url.startsWith('/v1/messages')) {
    assert.equal(req.headers['x-api-key'], 'sk-test-anthropic')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 50000,
            cache_creation_input_tokens: 2000,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
            output_tokens: 1
          }
        }
      })
    )
    const slow = body.includes('SLOW')
    for (let i = 0; i < (slow ? 200 : 20); i++) {
      res.write(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'chunk of reply text ' }
        })
      )
      if (slow) await new Promise((r) => setTimeout(r, 50))
      if (res.destroyed) return
    }
    res.write(sseEvent('message_delta', { type: 'message_delta', usage: { output_tokens: 500 } }))
    res.write(sseEvent('message_stop', { type: 'message_stop' }))
    return res.end()
  }
  if (req.url === '/openai/v1/responses') {
    assert.equal(req.headers['api-key'], 'az-test-key')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseEvent('response.created', { type: 'response.created', response: { usage: null } }))
    res.write(sseEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hi' }))
    res.write(
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          model: 'gpt-6-sol',
          output: [],
          usage: {
            input_tokens: 20000,
            input_tokens_details: { cached_tokens: 15000 },
            output_tokens: 1000
          }
        }
      })
    )
    return res.end()
  }
  res.writeHead(404).end()
})

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`)
const call = (path, opts = {}) => fetch(`${RELAY}${path}`, opts)
const admin = (path, body) =>
  call(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let wrangler
try {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))
  writeFileSync(
    join(relayDir, '.dev.vars'),
    [
      `ADMIN_TOKEN=${ADMIN}`,
      'ANTHROPIC_API_KEY=sk-test-anthropic',
      'AZURE_API_KEY=az-test-key',
      `AZURE_ENDPOINT=http://127.0.0.1:${UPSTREAM_PORT}`,
      `ANTHROPIC_UPSTREAM=http://127.0.0.1:${UPSTREAM_PORT}`
    ].join('\n')
  )
  const state = join(relayDir, '.wrangler', 'e2e-state')
  rmSync(state, { recursive: true, force: true })
  wrangler = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', state],
    { cwd: relayDir, shell: true, windowsHide: true }
  )
  let log = ''
  wrangler.stdout.on('data', (d) => (log += d))
  wrangler.stderr.on('data', (d) => (log += d))
  for (let i = 0; ; i++) {
    const up = await call('/health').then((r) => r.ok).catch(() => false)
    if (up) break
    if (i > 120) throw new Error('wrangler dev never came up:\n' + log)
    await sleep(500)
  }
  console.log('relay up')

  // --- invite + pairing ------------------------------------------------------
  const created = await admin('/admin/guests', {
    name: 'Test friend',
    hostName: 'Div',
    caps: { claude: 0.06, sol: 1, astra: 0 }
  })
  assert.match(created.invite, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/)
  assert.equal(created.inviteUrl, `${RELAY}/join/${created.invite}`)
  const landing = await call(`/join/${created.invite}`).then((r) => r.text())
  assert.ok(landing.includes('Div invited you') && landing.includes('releases/latest'), 'landing page')
  const redeemed = await call('/v1/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: created.invite.toLowerCase() })
  }).then((r) => r.json())
  assert.ok(redeemed.token?.startsWith('og_'), JSON.stringify(redeemed))
  const again = await call('/v1/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: created.invite })
  }).then((r) => r.json())
  assert.match(again.error, /already used/)
  const usedLanding = await call(`/join/${created.invite}`).then((r) => r.text())
  assert.ok(usedLanding.includes('already been used'), 'used invite landing page')
  console.log('invite link page shown, redeemed once, second use refused')

  const guestHeaders = {
    authorization: `Bearer ${redeemed.token}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-orcha-project': 'demo-app',
    'x-orcha-session': 'tab-1'
  }
  const message = (text = 'hi') =>
    call('/anthropic/v1/messages?beta=true', {
      method: 'POST',
      headers: guestHeaders,
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: text }] })
    })
  const balance = () =>
    call(`/v1/me/balance?since=${Date.now() - 86_400_000}`, { headers: guestHeaders }).then((r) => r.json())
  const spent = async (pool) => (await balance()).guest.pools.find((p) => p.pool === pool).spent

  // --- metered Claude request -----------------------------------------------
  const first = await message()
  assert.equal(first.status, 200)
  const text = await first.text()
  assert.ok(text.includes('message_stop'), 'stream passed through intact')
  const upstreamReq = seen.find((s) => s.url.startsWith('/v1/messages?'))
  assert.equal(upstreamReq.headers.authorization, undefined, 'guest token not forwarded')
  assert.equal(upstreamReq.headers['x-orcha-project'], undefined, 'attribution not forwarded')
  assert.equal(upstreamReq.headers['anthropic-version'], '2023-06-01')
  await sleep(300)
  close(await spent('claude'), ANTHROPIC_COST, 'claude spend after one reply')
  console.log(`claude reply metered at $${ANTHROPIC_COST}`)

  const count = await call('/anthropic/v1/messages/count_tokens', {
    method: 'POST',
    headers: guestHeaders,
    body: '{}'
  }).then((r) => r.json())
  assert.equal(count.input_tokens, 42)
  close(await spent('claude'), ANTHROPIC_COST, 'count_tokens is free')

  // --- budget exhaustion ------------------------------------------------------
  await (await message()).text() // 0.05 spent, cap 0.06
  await (await message()).text() // 0.075 — the tiny overshoot on the last allowed request
  await sleep(4500) // let the isolate's auth cache expire
  const blocked = await message()
  assert.equal(blocked.status, 403)
  const blockedBody = await blocked.json()
  assert.match(blockedBody.error.message, /Claude budget \(\$0\.06\) is used up\. Ask Div/)
  assert.equal(blocked.headers.get('x-should-retry'), 'false')
  console.log('blocked at the cap:', blockedBody.error.message)

  // --- top-up and revoke ------------------------------------------------------
  const guestId = created.guest.id
  await admin(`/admin/guests/${guestId}/topup`, { pool: 'claude', amount: 1 })
  assert.equal((await message()).status, 200)
  await admin(`/admin/guests/${guestId}/revoke`, {})
  const revoked = await message()
  assert.equal(revoked.status, 403)
  assert.match((await revoked.json()).error.message, /turned off/)
  await admin(`/admin/guests/${guestId}/restore`, {})
  assert.equal((await message()).status, 200)
  console.log('top-up re-opens, revoke closes, restore re-opens')

  // --- Codex / Azure ------------------------------------------------------------
  const solBefore = await spent('sol')
  const responses = await call('/openai/v1/responses', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ model: 'gpt-6-sol', stream: true, input: 'hi' })
  })
  assert.equal(responses.status, 200)
  await responses.text()
  await sleep(300)
  close((await spent('sol')) - solBefore, SOL_COST, 'sol spend')
  const astra = await call('/openai/v1/responses', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ model: 'gpt-6-astra', input: 'hi' })
  })
  assert.equal(astra.status, 429)
  assert.match((await astra.json()).error.message, /no GPT-6 Astra budget/)
  const wrongModel = await call('/openai/v1/responses', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi' })
  })
  assert.equal(wrongModel.status, 400)
  console.log('sol metered, astra blocked without budget, unknown model refused')

  // --- interrupted reply ----------------------------------------------------------
  const beforeAbort = await spent('claude')
  const controller = new AbortController()
  const slow = await call('/anthropic/v1/messages', {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [{ role: 'user', content: 'SLOW' }] }),
    signal: controller.signal
  })
  const reader = slow.body.getReader()
  await reader.read()
  await sleep(600)
  controller.abort()
  await sleep(1500)
  const abortedCost = (await spent('claude')) - beforeAbort
  // Input is exact (0.020); a partial, estimated output on top.
  assert.ok(abortedCost > 0.02 && abortedCost < 0.025, `aborted reply cost ${abortedCost}`)
  console.log(`interrupted reply billed $${abortedCost.toFixed(4)} (exact input + estimated partial output)`)

  // --- insights ------------------------------------------------------------------
  const bal = await balance()
  assert.ok(bal.sessions.some((s) => s.session === 'tab-1' && s.cost > 0))
  const usage = await call(`/v1/me/usage?since=${Date.now() - 86_400_000}`, { headers: guestHeaders }).then((r) =>
    r.json()
  )
  assert.ok(usage.projects.some((p) => p.project === 'demo-app'))
  assert.ok(usage.models.some((m) => m.model === 'claude-sonnet-5'))
  const list = await admin('/admin/guests')
  assert.equal(list[0].paired, true)
  const unpaired = await call('/v1/me/balance', { headers: { authorization: 'Bearer og_nope' } })
  assert.equal(unpaired.status, 401)
  const notAdmin = await call('/admin/guests', { headers: { authorization: `Bearer ${redeemed.token}` } })
  assert.equal(notAdmin.status, 401)
  console.log('balance/usage/admin views consistent; bad tokens refused')
  console.log('\nE2E PASSED')
} finally {
  upstream.close()
  if (wrangler) {
    // npx under a shell: kill the whole tree or workerd outlives the test.
    spawn('taskkill', ['/pid', String(wrangler.pid), '/t', '/f'], { windowsHide: true })
  }
  rmSync(join(relayDir, '.dev.vars'), { force: true })
}
