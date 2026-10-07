import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { execFileAsync, gitReady } from './exec'
import { MIN_CODEX_VERSION, OFFICIAL_CODEX_EXE, codexExecutable } from './codex'
import { compareVersions, mergePath, xcodeInstallOutcome } from './platform-core'
import { isMac, LOCAL_BIN } from './platform'
import type { ToolName, ToolState, ToolsStatus } from '../shared/types'

// The command-line tools a guest's Orcha drives — Claude Code, Codex and git —
// found or installed with one click each. Every installer here is the
// vendor's own and needs no admin rights, so there's never a UAC prompt. (On a
// Mac, git comes from Apple's developer tools, whose own installer may ask.)

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
// On a Mac the login shell's PATH was already merged in at startup; only the
// folder both installers use needs to be there.
export async function refreshPath(): Promise<void> {
  if (isMac) {
    process.env.PATH = mergePath([LOCAL_BIN, process.env.PATH])
    return
  }
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
// and .ps1 shims alike (npm installs Codex and older Claude Code as .cmd). A
// Mac has no shims to resolve, so the command runs directly (git included:
// execFileAsync refuses it, rather than popping Apple's installer, until
// Apple's developer tools are in).
async function versionOf(command: string): Promise<string | null> {
  try {
    const { stdout } = isMac
      ? await execFileAsync(command, ['--version'], { timeout: 20_000 })
      : await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-Command', `& '${command.replace(/'/g, "''")}' --version`],
          { timeout: 20_000 }
        )
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  } catch {
    return null
  }
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
    ready: version !== null && (!min || compareVersions(version, min) >= 0)
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

// The vendors' own shell installers, which put each tool in ~/.local/bin.
async function runInstallScript(url: string, env: Record<string, string> = {}): Promise<void> {
  await execFileAsync('/bin/bash', ['-c', `curl -fsSL ${url} | bash`], {
    timeout: 10 * 60_000,
    env: { ...process.env, ...env }
  })
}

// Git on a Mac comes with Apple's Command Line Tools. Their installer is a
// system dialog (Install → Agree, then a download of several minutes), so
// this opens it and waits for the tools to show up.
async function installAppleDeveloperTools(onProgress: (message: string) => void): Promise<void> {
  if (await gitReady()) return
  let output = ''
  try {
    const result = await execFileAsync('/usr/bin/xcode-select', ['--install'])
    output = result.stdout + result.stderr
  } catch (err) {
    output = String((err as { stderr?: string }).stderr ?? err)
  }
  const outcome = xcodeInstallOutcome(output)
  if (outcome === 'error') throw new Error(`Apple's installer didn't start: ${output.trim()}`)
  onProgress("Apple's installer is open: click Install, then Agree. It takes 5–20 minutes.")
  const deadline = Date.now() + 60 * 60_000
  while (!(await gitReady())) {
    if (Date.now() > deadline) throw new Error("Apple's developer tools didn't finish installing.")
    await new Promise((r) => setTimeout(r, 5000))
  }
}

export async function installTool(
  name: ToolName,
  onProgress: (message: string) => void
): Promise<void> {
  if (isMac) {
    if (name === 'claude') {
      onProgress('Installing Claude Code…')
      await runInstallScript('https://claude.ai/install.sh')
    } else if (name === 'codex') {
      onProgress('Installing Codex…')
      await runInstallScript('https://chatgpt.com/codex/install.sh', {
        CODEX_NON_INTERACTIVE: '1'
      })
    } else {
      await installAppleDeveloperTools(onProgress)
    }
    await refreshPath()
    onProgress('Done')
    return
  }
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
