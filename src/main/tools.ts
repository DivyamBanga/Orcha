import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { execFileAsync } from './exec'
import { MIN_CODEX_VERSION, OFFICIAL_CODEX_EXE, codexExecutable } from './codex'
import type { ToolName, ToolState, ToolsStatus } from '../shared/types'

// The command-line tools a guest's Orcha drives — Claude Code, Codex and git —
// found or installed with one click each. Every installer here is the
// vendor's own and needs no admin rights, so there's never a UAC prompt.

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const PORTABLE_GIT_DIR = join(LOCALAPPDATA, 'Programs', 'Git')

// Where those installers put things. A tool installed while Orcha is running
// lands on the user PATH in the registry, which this process never re-reads,
// so these are merged in directly.
const TOOL_DIRS = [
  join(homedir(), '.local', 'bin'), // Claude Code's native installer
  dirname(OFFICIAL_CODEX_EXE), // Codex's official installer
  join(PORTABLE_GIT_DIR, 'cmd') // PortableGit
]

// Rebuilds PATH from the registry (machine + user, as a fresh login would see
// it) plus the installer folders, so new tools work without restarting Orcha.
export async function refreshPath(): Promise<void> {
  let registry: string[] = []
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    ])
    registry = stdout.trim().split(';')
  } catch {
    // keep what we have
  }
  const seen = new Set<string>()
  const merged: string[] = []
  for (const dir of [...registry, ...(process.env.PATH ?? '').split(';'), ...TOOL_DIRS]) {
    const clean = dir.trim()
    if (!clean || seen.has(clean.toLowerCase())) continue
    if (TOOL_DIRS.includes(clean) && !existsSync(clean)) continue
    seen.add(clean.toLowerCase())
    merged.push(clean)
  }
  process.env.PATH = merged.join(';')
}

// Runs `<command> --version` through PowerShell, which resolves .exe, .cmd
// and .ps1 shims alike (npm installs Codex and older Claude Code as .cmd).
async function versionOf(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', `& '${command.replace(/'/g, "''")}' --version`],
      { timeout: 20_000 }
    )
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch {
    return null
  }
}

function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

export async function toolsStatus(): Promise<ToolsStatus> {
  const [claude, codex, git] = await Promise.all([
    versionOf('claude'),
    versionOf(codexExecutable()),
    versionOf('git')
  ])
  const state = (version: string | null, min?: string): ToolState => ({
    installed: version !== null,
    version,
    ready: version !== null && (!min || atLeast(version, min))
  })
  return { claude: state(claude), codex: state(codex, MIN_CODEX_VERSION), git: state(git) }
}

// ---- installers -------------------------------------------------------------------

async function runPowerShell(script: string, env: Record<string, string> = {}): Promise<void> {
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 10 * 60_000, env: { ...process.env, ...env } }
  )
}

// Git for Windows as PortableGit: a self-extracting archive unpacked into the
// user's own AppData. The regular installer (and winget's) raises a UAC
// prompt for anyone in the Administrators group; this never does.
async function installPortableGit(onProgress: (message: string) => void): Promise<void> {
  onProgress('Finding the latest Git for Windows…')
  const release = (await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000)
  }).then((r) => r.json())) as { assets?: { name: string; browser_download_url: string }[] }
  const asset = release.assets?.find((a) => /^PortableGit-.*-64-bit\.7z\.exe$/.test(a.name))
  if (!asset) throw new Error("Couldn't find the Git for Windows download.")

  onProgress('Downloading Git…')
  const archive = join(tmpdir(), asset.name)
  const response = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (!response.ok || !response.body) throw new Error(`Git download failed (${response.status}).`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive))

  onProgress('Unpacking Git…')
  mkdirSync(PORTABLE_GIT_DIR, { recursive: true })
  await execFileAsync(archive, [`-o${PORTABLE_GIT_DIR}`, '-y'], { timeout: 10 * 60_000 })
  rmSync(archive, { force: true })

  // Put git on the user's PATH for every terminal, not just Orcha's.
  const cmdDir = join(PORTABLE_GIT_DIR, 'cmd')
  await runPowerShell(
    `$p = [Environment]::GetEnvironmentVariable('Path','User'); ` +
      `if (($p -split ';') -notcontains '${cmdDir}') { ` +
      `[Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';')) + ';${cmdDir}').TrimStart(';'), 'User') }`
  )
}

export async function installTool(
  name: ToolName,
  onProgress: (message: string) => void
): Promise<void> {
  if (name === 'claude') {
    onProgress('Installing Claude Code…')
    await runPowerShell('irm https://claude.ai/install.ps1 | iex')
  } else if (name === 'codex') {
    onProgress('Installing Codex…')
    await runPowerShell('irm https://chatgpt.com/codex/install.ps1 | iex', {
      CODEX_NON_INTERACTIVE: '1'
    })
  } else {
    await installPortableGit(onProgress)
  }
  await refreshPath()
  onProgress('Done')
}
