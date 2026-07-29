// Bakes the phone pairing into mobile/pairing.json so an APK built on this
// machine auto-connects on first launch (QR stays as the fallback).
// Reads-or-mints the mobile:token in the REAL Orcha db — MobileService only
// generates a token when the row is absent, so pre-seeding here keeps the
// desktop and the baked APK in agreement.
//
// The repo's better-sqlite3 is compiled for Electron's ABI, so run this under
// the Electron binary as node:
//   $env:ELECTRON_RUN_AS_NODE='1'; & node_modules\electron\dist\electron.exe scripts\bake-pairing.cjs
const { randomBytes } = require('crypto')
const { networkInterfaces } = require('os')
const { join } = require('path')
const { writeFileSync } = require('fs')
const Database = require('better-sqlite3')

const dbPath = join(process.env.APPDATA, 'orcha', 'orcha.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)')

let token = db.prepare("SELECT value FROM app_state WHERE key = 'mobile:token'").get()?.value
if (!token) {
  token = randomBytes(16).toString('hex')
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run('mobile:token', token, token)
  console.log('minted a new pairing token')
} else {
  console.log('reusing the existing pairing token')
}
db.close()

// Same address ordering as MobileService.info(): Tailscale (100.64/10) first.
const tailscale = []
const other = []
for (const addrs of Object.values(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    if (addr.family !== 'IPv4' || addr.internal) continue
    const octets = addr.address.split('.').map(Number)
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) tailscale.push(addr.address)
    else other.push(addr.address)
  }
}
const urls = [...tailscale, ...other].map((ip) => `http://${ip}:4680`)
const out = join(__dirname, '..', 'mobile', 'pairing.json')
writeFileSync(out, JSON.stringify({ v: 1, urls, token }, null, 2))
console.log('baked', urls.length, 'address(es) into mobile/pairing.json')
