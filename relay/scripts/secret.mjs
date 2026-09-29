// Stores one relay secret in Cloudflare, reading the value from the clipboard
// so a provider key never has to be typed, echoed, or written to disk:
//
//   copy the key in your browser, then:  npm run secret ANTHROPIC_API_KEY
//
// The value is piped straight into `wrangler secret put` over stdin and never
// printed — only its length and first four characters, to confirm the right
// thing was on the clipboard.
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAMES = ['ANTHROPIC_API_KEY', 'AZURE_API_KEY', 'AZURE_ENDPOINT']
const name = process.argv[2]
if (!NAMES.includes(name)) {
  console.error(`Usage: npm run secret <${NAMES.join(' | ')}>`)
  process.exit(1)
}

const value = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
  encoding: 'utf8',
  windowsHide: true
}).trim()

const checks = {
  ANTHROPIC_API_KEY: (v) => /^sk-ant-api\d{2}-[\w-]{20,}$/.test(v),
  AZURE_API_KEY: (v) => /^[A-Za-z0-9]{32,100}$/.test(v),
  AZURE_ENDPOINT: (v) => /^https:\/\/[a-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)\/?$/.test(v)
}
if (!checks[name](value)) {
  const hint =
    name === 'AZURE_ENDPOINT'
      ? 'an https://<resource>.openai.azure.com URL'
      : name === 'ANTHROPIC_API_KEY'
        ? 'an sk-ant-api… key'
        : 'an Azure key (letters and digits)'
  console.error(`The clipboard doesn't look like ${hint}. Copy it again and re-run.`)
  process.exit(1)
}

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
  cwd: relayDir,
  input: name === 'AZURE_ENDPOINT' ? value.replace(/\/+$/, '') : value,
  encoding: 'utf8',
  shell: true,
  windowsHide: true
})
if (result.status !== 0) {
  console.error(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}
const shown = name === 'AZURE_ENDPOINT' ? value : `${value.slice(0, 4)}… (${value.length} chars)`
console.log(`Saved ${name} = ${shown}`)
