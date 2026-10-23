import { useEffect, useState } from 'react'
import { useStore } from '../store'
import TerminalView from './TerminalView'
import { Check, Circle, Mark } from './Icon'

function StatusDot({ ok }: { ok: boolean }): React.JSX.Element {
  return (
    <span className={`shrink-0 ${ok ? 'text-zinc-200' : 'text-zinc-600'}`}>
      {ok ? <Check size={15} /> : <Circle size={15} />}
    </span>
  )
}

function Brand(): React.JSX.Element {
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <Mark size={20} className="text-zinc-100" />
      <span className="font-mono text-xl font-semibold tracking-tight text-zinc-100">orcha</span>
    </div>
  )
}

// First run: connect your own GitHub and Claude accounts.
function Onboarding({ onDone }: { onDone: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="boot-item w-full max-w-[440px]">
        <Brand />
        <OwnAccounts onDone={onDone} />
      </div>
    </div>
  )
}

// Your own GitHub and Claude logins, with the login flows running in an
// embedded terminal.
function OwnAccounts({ onDone }: { onDone: () => void }): React.JSX.Element {
  const setup = useStore((s) => s.setup)
  const checkSetup = useStore((s) => s.checkSetup)
  const [showTerminal, setShowTerminal] = useState(false)

  // Re-check every few seconds so the rows tick over as logins complete.
  useEffect(() => {
    const interval = setInterval(checkSetup, 4000)
    return () => clearInterval(interval)
  }, [checkSetup])

  const runInTerminal = (command: string): void => {
    setShowTerminal(true)
    // Terminal may need a moment to spawn before it can take input.
    setTimeout(() => window.orcha.pty.input('setup', `${command}\r`), 1500)
  }

  const rows = [
    {
      ok: setup?.gh ?? false,
      label: 'GitHub',
      detail: 'Repos, commits, pushes, PRs',
      cmd: 'gh auth login'
    },
    {
      ok: setup?.claude ?? false,
      label: 'Claude Code',
      detail: 'Powers every session',
      cmd: 'claude'
    }
  ]

  return (
    <>
      <h1 className="text-[22px] font-semibold tracking-tight text-zinc-50">
        Connect your accounts
      </h1>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-500">
        Sign-ins run right here in a terminal.
      </p>
      <div className="card mt-6 divide-y divide-edge">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 px-4 py-3">
            <StatusDot ok={r.ok} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-200">{r.label}</div>
              <div className="text-[12px] text-zinc-500">{r.detail}</div>
            </div>
            {!r.ok && (
              <button onClick={() => runInTerminal(r.cmd)} className="btn btn-secondary btn-sm">
                Connect
              </button>
            )}
          </div>
        ))}
      </div>
      {showTerminal && (
        <div className="card mt-4 h-64 overflow-hidden">
          <TerminalView workspaceId="setup" visible />
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <button
          onClick={onDone}
          disabled={!(setup?.gh && setup?.claude)}
          className="btn btn-primary px-4"
        >
          Continue
        </button>
      </div>
    </>
  )
}

export default Onboarding
