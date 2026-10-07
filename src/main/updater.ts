import { app, shell } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  accessSync,
  constants,
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { IPC } from '../shared/ipc'
import { execFileAsync } from './exec'
import { compareVersions, isTranslocated } from './platform-core'
import { isMac, isWin } from './platform'
import type { UpdateState } from '../shared/types'

type SendFn = (channel: string, payload: unknown) => void

const RELEASES = 'https://github.com/DivyamBanga/Orcha/releases'
const CHECK_EVERY_MS = 6 * 60 * 60_000

// One-click updates from GitHub Releases. Orcha's Mac build isn't signed with
// a paid Apple ID, so Squirrel-style auto-update (which checks the new app's
// signature against the old one's) can't work. Instead: download the new
// version, check it against the release's SHA256SUMS, and swap it in. A file
// Orcha downloads itself carries no quarantine flag, so macOS doesn't make the
// person approve every update the way it did the first download.
export class Updater {
  private state: UpdateState = { phase: 'idle', version: null, error: null }
  private feed: string

  // True while a session is mid-turn; installing restarts Orcha, which would
  // cut it off.
  busy: () => boolean = () => false

  constructor(private send: SendFn) {
    // A local feed for the CI smoke test, honoured only in smoke runs.
    const flag = process.argv.find((a) => a.startsWith('--orcha-update-feed='))
    this.feed =
      flag && process.argv.includes('--orcha-smoke')
        ? flag.slice('--orcha-update-feed='.length)
        : RELEASES
  }

  start(): void {
    if (!app.isPackaged && !process.argv.includes('--orcha-smoke')) return
    setTimeout(() => this.check().catch(() => {}), 10_000)
    setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS)
  }

  status(): UpdateState {
    return this.state
  }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    this.send(IPC.EvUpdate, this.state)
  }

  // releases/latest redirects to releases/tag/vX.Y.Z; following the redirect
  // costs no GitHub API quota (which is 60 an hour per IP, shared on campus
  // and office networks).
  async check(): Promise<UpdateState> {
    if (this.state.phase === 'downloading') return this.state
    const response = await fetch(`${this.feed}/latest`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000)
    })
    const version = response.url.match(/\/tag\/v?(\d+\.\d+\.\d+)$/)?.[1]
    if (version && compareVersions(version, app.getVersion()) > 0) {
      this.set({ phase: 'available', version, error: null })
    }
    return this.state
  }

  async install(): Promise<void> {
    const version = this.state.version
    if (this.state.phase !== 'available' || !version) return
    if (this.busy()) {
      throw new Error('A session is still working. Update once it has finished.')
    }
    this.set({ phase: 'downloading', error: null })
    try {
      if (isMac) await this.installMac(version)
      else if (isWin) await this.installWindows(version)
    } catch (err) {
      this.set({ phase: 'available', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  private async download(version: string, file: string, to: string): Promise<void> {
    const base = `${this.feed}/download/v${version}`
    const sums = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(30_000) })
    if (!sums.ok) throw new Error(`Couldn't fetch the update's checksums (${sums.status}).`)
    const expected = (await sums.text())
      .split('\n')
      .map((line) => line.trim().split(/\s+\*?/))
      .find(([, name]) => name === file)?.[0]
    if (!expected) throw new Error(`The release has no checksum for ${file}.`)

    const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
    mkdirSync(dirname(to), { recursive: true })
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(to))
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(to)) hash.update(chunk as Buffer)
    if (hash.digest('hex') !== expected.toLowerCase()) {
      rmSync(to, { force: true })
      throw new Error('The download was damaged. Try the update again.')
    }
  }

  private async installMac(version: string): Promise<void> {
    // /Applications/Orcha.app/Contents/MacOS/Orcha → /Applications/Orcha.app
    const bundle = resolve(app.getPath('exe'), '..', '..', '..')
    const parent = dirname(bundle)
    let writable = !isTranslocated(bundle)
    try {
      accessSync(parent, constants.W_OK)
      accessSync(bundle, constants.W_OK)
    } catch {
      writable = false
    }

    if (!writable) {
      // Can't replace the app from here (a standard account, or Orcha opened
      // straight from the download): hand over the disk image instead.
      const dmg = join(app.getPath('downloads'), `Orcha-${version}.dmg`)
      await this.download(version, 'Orcha-mac-arm64.dmg', dmg)
      await shell.openPath(dmg)
      this.set({ phase: 'manual' })
      return
    }

    // Unpack next to the running app (same disk, so the final swap is a
    // rename), and check the result before touching anything.
    const zip = join(tmpdir(), `Orcha-${version}.zip`)
    await this.download(version, 'Orcha-mac-arm64.zip', zip)
    const staging = join(parent, '.Orcha-update')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging)
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zip, staging])
    rmSync(zip, { force: true })
    const staged = join(staging, 'Orcha.app')
    const { stdout } = await execFileAsync('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      join(staged, 'Contents', 'Info.plist')
    ])
    if (stdout.trim() !== version) throw new Error('The downloaded app is the wrong version.')
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])

    // The swap waits until this process has exited, so no part of the old app
    // is still running (Electron starts helper processes by path later on).
    // If the second move fails, the old app is put back.
    const script = join(tmpdir(), 'orcha-update.sh')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'pid="$1"; app="$2"; new="$3"; staging="$4"',
        'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
        'rm -rf "$app.old"',
        'if mv "$app" "$app.old"; then',
        '  if mv "$new" "$app"; then rm -rf "$app.old"; else mv "$app.old" "$app"; fi',
        'fi',
        'rm -rf "$staging"',
        'open "$app"'
      ].join('\n')
    )
    spawn('/bin/sh', [script, String(process.pid), bundle, staged, staging], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    this.set({ phase: 'restarting' })
    app.quit()
  }

  // The NSIS installer is one-click and per-user, so a silent run upgrades in
  // place; --force-run reopens Orcha afterwards.
  private async installWindows(version: string): Promise<void> {
    const file = `orcha-${version}-setup.exe`
    const setup = join(tmpdir(), file)
    await this.download(version, file, setup)
    spawn(setup, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    this.set({ phase: 'restarting' })
    app.quit()
  }
}
