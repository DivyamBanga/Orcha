// One-command local APK build: bake pairing → expo prebuild → gradle →
// mobile/Orcha.apk (and installs onto the phone if one is plugged in).
// Run from mobile/:  node scripts/build-apk.mjs
// Needs: a JDK (17+) and the Android SDK at %LOCALAPPDATA%\Android\Sdk —
// both already present on this machine. No Expo account, no cloud.
import { spawnSync } from 'child_process'
import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(mobile, '..')
const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')

function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME
  const adoptium = 'C:\\Program Files\\Eclipse Adoptium'
  if (existsSync(adoptium)) {
    const jdk = readdirSync(adoptium).find((d) => d.startsWith('jdk-'))
    if (jdk) return join(adoptium, jdk)
  }
  return null
}

function run(name, command, args, opts = {}) {
  console.log(`\n── ${name}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts
  })
  if (result.status !== 0) {
    console.error(`${name} failed (exit ${result.status})`)
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(sdk)) {
  console.error(`Android SDK not found at ${sdk} — install Android Studio or set ANDROID_HOME.`)
  process.exit(1)
}
const javaHome = findJavaHome()
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ...(javaHome ? { JAVA_HOME: javaHome } : {}),
  CI: '1'
}

// 1. Bake the pairing (token from the real Orcha db + this PC's addresses)
//    so the APK auto-connects. Non-fatal: without it you pair by QR.
const electron = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
if (existsSync(electron)) {
  const bake = spawnSync(electron, [join(repo, 'scripts', 'bake-pairing.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (bake.status !== 0) console.warn('pairing bake failed — the app will ask for a QR scan')
} else {
  console.warn('electron not found (run npm install in the repo root) — skipping pairing bake')
}

if (!existsSync(join(mobile, 'google-services.json'))) {
  console.log('note: no google-services.json — building without push notifications')
}

// 2. Generate the native android project (safe to re-run; regenerates).
run('expo prebuild', 'npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
  cwd: mobile,
  env
})

// 3. Point gradle at the SDK (backslashes must be escaped in .properties).
writeFileSync(
  join(mobile, 'android', 'local.properties'),
  `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`
)

// 4. Build the release APK (first run downloads gradle + deps; takes a while).
run('gradle assembleRelease', join(mobile, 'android', 'gradlew.bat'), ['assembleRelease'], {
  cwd: join(mobile, 'android'),
  env
})

// 5. Collect the APK; install it if a phone is plugged in with USB debugging.
const apk = join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const out = join(mobile, 'Orcha.apk')
copyFileSync(apk, out)
console.log(`\nAPK ready: ${out}`)

const adb = join(sdk, 'platform-tools', 'adb.exe')
if (existsSync(adb)) {
  const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' })
  const attached = (devices.stdout ?? '')
    .split('\n')
    .slice(1)
    .some((l) => l.trim().endsWith('device'))
  if (attached) {
    console.log('phone detected — installing…')
    spawnSync(adb, ['install', '-r', out], { stdio: 'inherit' })
  } else {
    console.log('no phone attached — copy Orcha.apk to the phone and tap it, or plug in and rerun.')
  }
}
