import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'

const execFileRaw = promisify(execFile)

// Electron's main process owns no console, so Windows hands every child
// console app (git, gh, ssh, scp, codex) a brand new one — a window that
// visibly pops open and vanishes. git status alone polls every 30s for each
// open session, so without windowsHide the screen flickers steadily during
// ordinary use. Everything in main goes through here so a new call site
// cannot quietly reintroduce it.
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // encoding is pinned so the overload resolves to the string-returning one
  // rather than the Buffer union; utf8 is already the default, so callers see
  // no change in behaviour.
  return execFileRaw(file, args, { ...options, encoding: 'utf8', windowsHide: true })
}
