// Production check for the one path local `wrangler dev` can't exercise: a
// client hanging up mid-reply (Esc in Claude Code or Codex). Makes a throwaway
// guest on your deployed relay, streams a long Haiku reply, hangs up after
// ~1.5s, and reports what was billed — a small amount means generation was
// cancelled; the full reply's cost (~$0.008) would mean it wasn't. Then deletes
// the guest. Costs about a tenth of a cent.
//
//   node test/live-abort.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const { url, adminToken } = JSON.parse(readFileSync(`${homedir()}/.orcha/relay-admin.json`, 'utf8'))
const admin = (path, body) =>
  fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  }).then((r) => r.json())

const created = await admin('/admin/guests', {
  name: 'Hang-up check',
  hostName: 'relay test',
  caps: { claude: 0.05, sol: 0, astra: 0 }
})
try {
  const code = created.inviteUrl.split('/join/')[1]
  const { token } = await fetch(`${url}/v1/redeem`, {
    method: 'POST',
    body: JSON.stringify({ code })
  }).then((r) => r.json())
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01'
  }
  const spent = async () =>
    (await fetch(`${url}/v1/me/balance?since=0`, { headers }).then((r) => r.json())).guest.pools[0]
      .spent

  const controller = new AbortController()
  const res = await fetch(`${url}/anthropic/v1/messages`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      stream: true,
      messages: [{ role: 'user', content: 'Write a long, detailed essay (1200+ words) about lighthouses.' }]
    })
  })
  const reader = res.body.getReader()
  const t0 = Date.now()
  while (Date.now() - t0 < 1500) {
    const { done } = await reader.read()
    if (done) break
  }
  controller.abort()

  let billed = 0
  for (let i = 0; i < 20 && billed === 0; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    billed = await spent()
  }
  const verdict = billed > 0 && billed < 0.004 ? 'PASS: generation was cancelled' : 'CHECK: looks like the whole reply was billed'
  console.log(`hung up after ~1.5s; billed $${billed.toFixed(6)} — ${verdict}`)
} finally {
  await admin(`/admin/guests/${created.guest.id}/remove`, {})
}
