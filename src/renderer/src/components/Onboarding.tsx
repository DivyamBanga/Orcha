import { useCallback, useEffect, useState } from 'react'
import { IPC } from '../../../shared/ipc'
import { useStore } from '../store'
import TerminalView from './TerminalView'
import { Check, Circle, Mark } from './Icon'
import type { ToolName } from '../../../shared/types'

type Step = 'welcome' | 'own' | 'tools'

const isMac = window.orcha.platform === 'darwin'

// On a Mac, git comes with Apple's developer tools, whose installer is a
// system dialog that takes a while — so it goes first, while you're watching.
const TOOLS: { name: ToolName; label: string; detail: string }[] = isMac
  ? [
      {
        name: 'git',
        label: 'Apple developer tools',
        detail: "Includes Git. Apple's installer opens; it takes a few minutes"
      },
      { name: 'claude', label: 'Claude Code', detail: 'Runs your Claude sessions' },
      { name: 'codex', label: 'Codex', detail: 'Runs your GPT-6 sessions' }
    ]
  : [
      { name: 'claude', label: 'Claude Code', detail: 'Runs your Claude sessions' },
      { name: 'codex', label: 'Codex', detail: 'Runs your GPT-6 sessions' },
      { name: 'git', label: 'Git', detail: 'Tracks your project changes' }
    ]

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

// First run. Someone with an invite pastes it and gets set up on their host's
// credits; anyone else connects their own GitHub and Claude accounts, which is
// the original setup flow.
function Onboarding({ onDone }: { onDone: () => void }): React.JSX.Element {
  const guest = useStore((s) => s.guest)
  const [step, setStep] = useState<Step>(guest?.paired ? 'tools' : 'welcome')

  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="boot-item w-full max-w-[440px]">
        <Brand />
        {step === 'welcome' && (
          <Welcome onJoined={() => setStep('tools')} onOwn={() => setStep('own')} />
        )}
        {step === 'tools' && <Tools onDone={onDone} />}
        {step === 'own' && <OwnAccounts onBack={() => setStep('welcome')} onDone={onDone} />}
      </div>
    </div>
  )
}

function Welcome({
  onJoined,
  onOwn
}: {
  onJoined: () => void
  onOwn: () => void
}): React.JSX.Element {
  const loadGuest = useStore((s) => s.loadGuest)
  const [link, setLink] = useState('')
  const [foundLink, setFoundLink] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prefilled = foundLink !== null && link === foundLink

  // Someone who just copied their invite link shouldn't have to paste it. A
  // Mac never reads the clipboard on its own; there the invite page's "Open in
  // Orcha" button hands the link over instead (shown here, joined on click).
  useEffect(() => {
    let alive = true
    const found = (invite: string | null): void => {
      if (!alive || !invite) return
      setFoundLink(invite)
      setLink((current) => (isMac ? invite : current || invite))
    }
    const fromLink = (): void => {
      window.orcha.guest
        .pendingInvite()
        .then(found)
        .catch(() => {})
    }
    if (isMac) {
      fromLink()
      const off = window.orcha.on(IPC.EvInviteLink, fromLink)
      return () => {
        alive = false
        off()
      }
    }
    const check = (): void => {
      window.orcha.guest
        .clipboardInvite()
        .then(found)
        .catch(() => {})
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [])

  const join = async (): Promise<void> => {
    if (!link.trim()) return
    setJoining(true)
    setError(null)
    try {
      await window.orcha.guest.redeem(link.trim())
      await loadGuest()
      await useStore.getState().loadIdentity()
      onJoined()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err)
      )
    } finally {
      setJoining(false)
    }
  }

  return (
    <>
      <h1 className="text-[22px] font-semibold tracking-tight text-zinc-50">Welcome to Orcha</h1>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-500">
        Run Claude Code and Codex side by side, one tab per project.
      </p>

      <div className="card mt-7 p-4">
        <label className="field-label" htmlFor="invite">
          Have an invite link?
        </label>
        <div className="flex gap-2">
          <input
            id="invite"
            autoFocus
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()}
            placeholder="https://…/join/XXXXX-XXXXX-XXXXX-XXXXX"
            className="input font-mono text-[12px]"
          />
          <button
            onClick={join}
            disabled={joining || !link.trim()}
            className="btn btn-primary h-8 px-4"
          >
            {joining ? <span className="busy-ring" /> : 'Join'}
          </button>
        </div>
        {error ? (
          <div className="mt-2.5 text-[12px] leading-relaxed text-red-400">{error}</div>
        ) : prefilled ? (
          <div className="fade-late mt-2.5 text-[12px] text-zinc-500">
            {isMac
              ? `From your invite page (${new URL(link).host}). Click Join to accept.`
              : 'Found on your clipboard.'}
          </div>
        ) : null}
      </div>

      <button onClick={onOwn} className="btn btn-ghost mt-4 -ml-2.5 text-zinc-500">
        Use my own Claude account instead →
      </button>
    </>
  )
}

function Tools({ onDone }: { onDone: () => void }): React.JSX.Element {
  const guest = useStore((s) => s.guest)
  const tools = useStore((s) => s.tools)
  const checkTools = useStore((s) => s.checkTools)
  const [installing, setInstalling] = useState<ToolName | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    checkTools().catch(() => {})
    return window.orcha.on(IPC.EvToolsProgress, (payload) => {
      setProgress((payload as { message: string }).message)
    })
  }, [checkTools])

  const install = useCallback(
    async (name: ToolName): Promise<void> => {
      setInstalling(name)
      setError(null)
      setProgress(null)
      try {
        await window.orcha.tools.install(name)
      } catch (err) {
        const label = TOOLS.find((t) => t.name === name)?.label ?? name
        setError(`${label} didn't install. Check your connection and try again.`)
        console.log('[tools]', err)
      } finally {
        setInstalling(null)
        setProgress(null)
        await checkTools().catch(() => null)
      }
    },
    [checkTools]
  )

  const missing = TOOLS.filter((t) => tools && !tools[t.name].ready)
  const installAll = async (): Promise<void> => {
    for (const t of missing) await install(t.name)
  }
  const allReady = tools !== null && missing.length === 0

  return (
    <>
      <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-edge bg-surface-1 px-3 py-1 text-[12px] text-zinc-400">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
        Joined {guest?.hostName ?? 'your host'}&apos;s credits
      </div>
      <h1 className="text-[22px] font-semibold tracking-tight text-zinc-50">One last check</h1>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-zinc-500">
        {isMac
          ? 'Orcha drives these tools on your computer. Anything missing installs with one click.'
          : 'Orcha drives these tools on your computer. Anything missing installs with one click, no admin needed.'}
      </p>

      <div className="card mt-6 divide-y divide-edge">
        {TOOLS.map((t) => {
          const state = tools?.[t.name]
          const outdated = state?.installed && !state.ready
          return (
            <div key={t.name} className="flex items-center gap-3 px-4 py-3">
              {tools === null ? (
                <span className="busy-ring" />
              ) : (
                <StatusDot ok={state?.ready ?? false} />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-zinc-200">{t.label}</div>
                <div className="truncate text-[12px] text-zinc-500">
                  {installing === t.name
                    ? (progress ?? 'Starting…')
                    : state?.ready
                      ? `Version ${state.version}`
                      : outdated
                        ? `Version ${state.version} is too old`
                        : t.detail}
                </div>
              </div>
              {tools !== null && !state?.ready && (
                <button
                  onClick={() => install(t.name)}
                  disabled={installing !== null}
                  className="btn btn-secondary btn-sm"
                >
                  {installing === t.name ? (
                    <span className="busy-ring" />
                  ) : outdated ? (
                    'Update'
                  ) : (
                    'Install'
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {error && <div className="mt-3 text-[12px] text-red-400">{error}</div>}

      <p className="mt-4 text-[12px] leading-relaxed text-zinc-500">
        Sessions run in full-auto mode: Claude and Codex edit files and run commands in the project
        folders you open without asking first. Open folders you&apos;re happy for them to change.
      </p>

      <div className="mt-6 flex items-center justify-between">
        {missing.length > 1 && !installing ? (
          <button onClick={installAll} className="btn btn-ghost -ml-2.5">
            Install everything
          </button>
        ) : (
          <span />
        )}
        <button onClick={onDone} disabled={!allReady} className="btn btn-primary px-4">
          Start using Orcha
        </button>
      </div>
    </>
  )
}

// The original setup: your own GitHub and Claude logins, with the login flows
// running in an embedded terminal.
function OwnAccounts({
  onBack,
  onDone
}: {
  onBack: () => void
  onDone: () => void
}): React.JSX.Element {
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
      <div className="mt-6 flex items-center justify-between">
        <button onClick={onBack} className="btn btn-ghost -ml-2.5">
          ← Back
        </button>
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
