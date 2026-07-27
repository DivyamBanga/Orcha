// One step from source to installed app: build, then run the installer that
// was just produced. The NSIS package is a one-click installer, so /S upgrades
// the existing install and its shortcuts in place — nothing to uninstall first,
// and a running Orcha is closed and relaunched for you.
//
// Day to day: `npm run dev` for hot reload while working on the code,
// `npm run reinstall` when you want those changes in the installed app.

import { execFileSync, execSync } from 'child_process'
import { readdirSync } from 'fs'
import { join } from 'path'

// execSync, not execFileSync: npm on Windows is a .cmd shim, which Node 24
// refuses to spawn without a shell, and passing args alongside shell: true is
// deprecated (DEP0190). A plain command line through the shell is neither.
execSync('npm run build:win', { stdio: 'inherit' })

const setup = readdirSync('dist').find((f) => /setup\.exe$/i.test(f))
if (!setup) throw new Error('Build finished but no *-setup.exe landed in dist/')

console.log(`\nInstalling ${setup} …`)
execFileSync(join('dist', setup), ['/S'], { stdio: 'inherit' })
console.log('Orcha updated.')
