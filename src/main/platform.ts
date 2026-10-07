import { app } from 'electron'
import { spawn } from 'child_process'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { homedir, userInfo } from 'os'
import { dirname, join } from 'path'
import { inspect } from 'util'
import { mergePath, parseShellEnv, SHELL_ENV_SENTINEL, utf8Locale } from './platform-core'

export const isMac = process.platform === 'darwin'
export const isWin = process.platform === 'win32'

// Where Claude Code's and Codex's own installers put their binaries on a Mac.
export const LOCAL_BIN = join(homedir(), '.local', 'bin')

export function loginShell(): string {
  try {
    const shell = userInfo().shell
    if (shell) return shell
  } catch {
    // no passwd entry
  }
  return process.env.SHELL || '/bin/zsh'
}

// An app opened from Finder or the Dock gets launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) and no LANG, so Homebrew, ~/.local/bin and
// nvm tools are invisible and git/claude run without UTF-8. Ask the user's
// login shell once, at startup. Only PATH and the locale come back: the shell
// may also export API keys or provider switches, and those must never leak
// into the sessions Orcha starts (they would bypass the guest relay).
export async function resolveShellEnv(): Promise<void> {
  if (!isMac) return
  const found = await new Promise<ReturnType<typeof parseShellEnv>>((resolve) => {
    let out = ''
    const child = spawn(
      loginShell(),
      ['-ilc', `printf '%s\\0%s\\0%s\\0%s\\0' ${SHELL_ENV_SENTINEL} "$PATH" "$LANG" "$LC_ALL"`],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    // rc files can hang (an update prompt waiting for input); never wait long.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve(parseShellEnv(out))
    }, 5000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseShellEnv(out))
    })
  })

  process.env.PATH = mergePath([
    LOCAL_BIN,
    found?.path ?? process.env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ])
  if (!process.env.LANG) process.env.LANG = found?.lang || utf8Locale(app.getSystemLocale())
  if (!process.env.LC_ALL && found?.lcAll) process.env.LC_ALL = found.lcAll
}

// main.log in the OS's log folder (~/Library/Logs/Orcha on a Mac), so a
// problem on a friend's machine can be read back without touching it. Kept
// small: it starts over once it passes 2 MB.
export function startLogFile(): void {
  const file = join(app.getPath('logs'), 'main.log')
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (statSync(file).size > 2_000_000) writeFileSync(file, '')
  } catch {
    // no log yet
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        const line = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')
        appendFileSync(file, `${new Date().toISOString()} ${level} ${line}\n`)
      } catch {
        // logging must never break the app
      }
    }
  }
}

export function logFilePath(): string {
  return join(app.getPath('logs'), 'main.log')
}

// The Agent SDK finds its bundled Claude binary relative to its own file, which
// in a packaged app is a path inside app.asar — and nothing can be spawned from
// in there. The binary itself is unpacked next to the archive, so point the
// SDK at that copy. Undefined in dev, where the SDK's own lookup is fine.
export function claudeSdkBinary(): string | undefined {
  if (!app.isPackaged) return undefined
  try {
    const require = createRequire(__filename)
    const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${isWin ? '.exe' : ''}`
    return require.resolve(name).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
  } catch {
    return undefined
  }
}
