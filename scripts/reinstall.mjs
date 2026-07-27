// One step from source to installed app: build, then run the installer that
// was just produced. The NSIS package is a one-click installer, so /S upgrades
// the existing install and its shortcuts in place — nothing to uninstall first,
// and a running Orcha is closed and relaunched for you.
//
// Day to day: `npm run dev` for hot reload while working on the code,
// `npm run reinstall` when you want those changes in the installed app.

import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import { join } from 'path'

// npm.cmd directly rather than shell: true, which Node deprecated for arg
// passing (DEP0190) because the args are concatenated rather than escaped.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['run', 'build:win'], { stdio: 'inherit' })

const setup = readdirSync('dist').find((f) => /setup\.exe$/i.test(f))
if (!setup) throw new Error('Build finished but no *-setup.exe landed in dist/')

console.log(`\nInstalling ${setup} …`)
execFileSync(join('dist', setup), ['/S'], { stdio: 'inherit' })
console.log('Orcha updated.')
