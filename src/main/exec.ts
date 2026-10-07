import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'

const execFileRaw = promisify(execFile)

// Electron's main process owns no console, so Windows hands every child
// console app (git, gh, ssh, scp, codex) a brand new one — a window that
// visibly pops open and vanishes. git status alone polls every 30s for each
// open session, so without windowsHide the screen flickers steadily during
// ordinary use. Everything in main goes through here so a new call site
// cannot quietly reintroduce it.
export async function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  if (file === 'git' && !(await gitReady())) {
    throw new Error("Git isn't installed yet. Install Apple's developer tools from Orcha's setup.")
  }
  // encoding is pinned so the overload resolves to the string-returning one
  // rather than the Buffer union; utf8 is already the default, so callers see
  // no change in behaviour.
  return execFileRaw(file, args, { ...options, encoding: 'utf8', windowsHide: true })
}

// On a Mac without Apple's Command Line Tools, /usr/bin/git is a stub that
// pops Apple's "install developer tools" dialog every time anything runs it —
// a 30-second git status poll would keep throwing it in the user's face. So
// git only runs once `xcode-select -p` reports the tools are installed. Only a
// yes is cached, so tools installed later (in or outside Orcha) are picked up.
let gitReadyCache = false

export async function gitReady(): Promise<boolean> {
  if (process.platform !== 'darwin' || gitReadyCache) return true
  try {
    await execFileRaw('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' })
    gitReadyCache = true
  } catch {
    // not installed (yet)
  }
  return gitReadyCache
}
