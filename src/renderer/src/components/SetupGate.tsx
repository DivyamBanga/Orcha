import { useEffect, useState } from 'react'
import { useStore } from '../store'
import TerminalView from './TerminalView'

function Check({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={`font-mono text-[13px] ${ok ? 'text-accent' : 'text-zinc-600'}`}>
        {ok ? '✓' : '○'}
      </span>
      <span className={ok ? 'text-zinc-300' : 'text-zinc-500'}>{label}</span>
    </span>
  )
}

// First-run gate: both GitHub and Claude Code must be connected. Login flows
// run in the embedded terminal below.
function SetupGate(): React.JSX.Element {
  const setup = useStore((s) => s.setup)
  const checkSetup = useStore((s) => s.checkSetup)
  const [showTerminal, setShowTerminal] = useState(false)

  // Re-check every few seconds so the gate clears itself as logins complete.
  useEffect(() => {
    const interval = setInterval(checkSetup, 4000)
    return () => clearInterval(interval)
  }, [checkSetup])

  const runInTerminal = (command: string): void => {
    setShowTerminal(true)
    // Terminal may need a moment to spawn before it can take input.
    setTimeout(() => window.orcha.pty.input('setup', `${command}\r`), 1500)
  }

  return (
    <div className="console-bg flex h-full flex-1 flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="font-mono text-2xl font-semibold tracking-tight text-zinc-100">orcha</div>
        <div className="mt-1 text-zinc-500">Connect your accounts to get started</div>
      </div>

      <div className="flex w-full max-w-xl flex-col gap-3">
        <div className="flex items-center justify-between rounded-lg border border-edge bg-surface-1 px-4 py-3">
          <Check ok={setup?.gh ?? false} label="GitHub — repos, commits, pushes, PRs" />
          {!setup?.gh && (
            <button
              onClick={() => runInTerminal('gh auth login')}
              className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30"
            >
              Connect GitHub
            </button>
          )}
        </div>
        <div className="flex items-center justify-between rounded-lg border border-edge bg-surface-1 px-4 py-3">
          <Check ok={setup?.claude ?? false} label="Claude Code — powers every session" />
          {!setup?.claude && (
            <button
              onClick={() => runInTerminal('claude')}
              className="rounded-md border border-accent-dim bg-accent-dim/15 px-3 py-1.5 font-medium text-accent hover:bg-accent-dim/30"
            >
              Connect Claude
            </button>
          )}
        </div>
      </div>

      {showTerminal && (
        <div className="h-72 w-full max-w-3xl overflow-hidden rounded-lg border border-edge">
          <TerminalView workspaceId="setup" visible />
        </div>
      )}

      <button
        onClick={checkSetup}
        className="font-mono text-[12px] text-zinc-600 hover:text-zinc-400"
      >
        re-check connections
      </button>
    </div>
  )
}

export default SetupGate
