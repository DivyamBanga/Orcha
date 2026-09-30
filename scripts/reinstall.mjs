// One step from source to installed app: build, then run the installer that
// was just produced. The NSIS package is a one-click installer, so /S upgrades
// the existing install and its shortcuts in place — nothing to uninstall first,
// and a running Orcha is closed and relaunched for you.
//
// Day to day: `npm run dev` for hot reload while working on the code,
// `npm run reinstall` when you want those changes in the installed app.

import { execFileSync, execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// execSync, not execFileSync: npm on Windows is a .cmd shim, which Node 24
// refuses to spawn without a shell, and passing args alongside shell: true is
// deprecated (DEP0190). A plain command line through the shell is neither.
execSync('npm run build:win', { stdio: 'inherit' })

// Installers from earlier versions stay in dist/, so pick this version's by
// name rather than the first *-setup.exe (which sorts to the oldest).
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const setup = `${name}-${version}-setup.exe`
if (!existsSync(join('dist', setup))) throw new Error(`Build finished but dist/${setup} is missing`)

console.log(`\nInstalling ${setup} …`)
execFileSync(join('dist', setup), ['/S'], { stdio: 'inherit' })
console.log('Orcha updated.')
