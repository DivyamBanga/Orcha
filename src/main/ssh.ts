import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SshTarget {
  host: string
  user: string
  port: number | null // null = default 22
}

// Connection args ssh needs to reach the target. `batch` is for the one-shot
// preflight checks below: it disables interactive prompts (so a bad host
// fails fast instead of hanging) and auto-accepts a first-time host key like
// most tooling does (still fails loudly if a known key changed) — which also
// pre-populates known_hosts so the later interactive pty won't hit a
// host-key prompt on first connect. The live session pty never uses batch
// mode, so the user can answer prompts (password, unexpected key changes)
// directly in the terminal, same as running ssh by hand.
export function sshArgs(target: SshTarget, opts: { batch: boolean }): string[] {
  const args: string[] = []
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (opts.batch) {
    args.push(
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=8'
    )
  }
  args.push(`${target.user}@${target.host}`)
  return args
}

// POSIX-shell-quotes a string for embedding in a remote command.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Fails fast with a clear error on a bad host/path instead of silently
// registering a project that will never boot.
export async function verifyRemotePath(target: SshTarget, path: string): Promise<void> {
  try {
    await execFileAsync('ssh', [...sshArgs(target, { batch: true }), `test -d ${shQuote(path)}`])
  } catch (err) {
    throw new Error(
      `Could not verify ${path} on ${target.host}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// Mirrors claudeSessions.hasSessionHistory, but probes the *remote* host's
// ~/.claude/projects/<encoded-path> via one batch-mode ssh call, using the
// same non-alphanumeric-to-'-' encoding Claude Code itself uses.
export async function remoteHasSessionHistory(target: SshTarget, path: string): Promise<boolean> {
  const encoded = path.replace(/[^a-zA-Z0-9]/g, '-')
  try {
    await execFileAsync('ssh', [
      ...sshArgs(target, { batch: true }),
      `ls ~/.claude/projects/${encoded}/*.jsonl >/dev/null 2>&1`
    ])
    return true
  } catch {
    return false
  }
}
