// electron-builder afterSign hook (Mac builds only).
//
// Orcha's Mac build isn't signed with a paid Apple ID. Left alone, the bundle
// keeps Electron's own ad-hoc signature, whose seal breaks once the app is
// renamed and its files are added — and macOS reports a broken seal as
// "Orcha is damaged and can't be opened" with no way past it. Re-signing the
// finished bundle ad-hoc gives it a valid seal, so macOS treats it as an app
// from an unidentified developer and offers "Open Anyway".
const { execFileSync } = require('child_process')
const { chmodSync, existsSync } = require('fs')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // node-pty starts every terminal through spawn-helper; npm can drop its
  // executable bit, and then no terminal opens. Fixed before signing, since
  // the signature covers it.
  const pty = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  for (const helper of [
    join(pty, 'build', 'Release', 'spawn-helper'),
    join(pty, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(pty, 'prebuilds', 'darwin-x64', 'spawn-helper')
  ]) {
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    stdio: 'inherit'
  })
}
