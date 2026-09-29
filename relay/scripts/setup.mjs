// One-shot relay setup, safe to re-run: deploys the Worker, makes sure it has
// an admin token, and saves {url, adminToken} to ~/.orcha/relay-admin.json —
// the file Orcha's Settings → Guests panel reads to manage guests. Then it
// reports which provider keys are still missing (set those with
// `npm run secret <NAME>`, which reads the value from the clipboard).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const adminFile = join(homedir(), '.orcha', 'relay-admin.json')
const PROVIDER_SECRETS = ['ANTHROPIC_API_KEY', 'AZURE_API_KEY', 'AZURE_ENDPOINT']

function wrangler(args, input) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: relayDir,
    input,
    encoding: 'utf8',
    shell: true,
    windowsHide: true
  })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const who = wrangler(['whoami'])
if (!who.ok || /not authenticated/i.test(who.out)) {
  console.error('Not logged in to Cloudflare. Run `npx wrangler login` first.')
  process.exit(1)
}

console.log('Deploying the relay…')
const deploy = wrangler(['deploy'])
if (!deploy.ok) {
  console.error(deploy.out)
  process.exit(1)
}
const url = deploy.out.match(/https:\/\/orcha-relay\.[a-z0-9-]+\.workers\.dev/)?.[0]
if (!url) {
  console.error('Deployed, but could not find the workers.dev URL in the output:\n' + deploy.out)
  process.exit(1)
}
console.log(`Relay is live at ${url}`)

let saved = existsSync(adminFile) ? JSON.parse(readFileSync(adminFile, 'utf8')) : null
const listed = wrangler(['secret', 'list', '--format', 'json'])
const names = listed.ok ? JSON.parse(listed.out.slice(listed.out.indexOf('['))).map((s) => s.name) : []

if (!saved?.adminToken || !names.includes('ADMIN_TOKEN')) {
  const adminToken = saved?.adminToken ?? `oa_${randomBytes(32).toString('base64url')}`
  const put = wrangler(['secret', 'put', 'ADMIN_TOKEN'], adminToken)
  if (!put.ok) {
    console.error(put.out)
    process.exit(1)
  }
  saved = { url, adminToken }
  console.log('Admin token created.')
}
saved.url = url
mkdirSync(dirname(adminFile), { recursive: true })
writeFileSync(adminFile, JSON.stringify(saved, null, 2))
console.log(`Saved relay admin config to ${adminFile}`)

const missing = PROVIDER_SECRETS.filter((n) => !names.includes(n))
if (missing.length > 0) {
  console.log('\nStill needed (copy each value, then run the command):')
  for (const n of missing) console.log(`  npm run secret ${n}`)
} else {
  console.log('All provider keys are set.')
}

const health = await fetch(`${url}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }))
console.log('Health:', JSON.stringify(health))
