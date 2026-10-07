import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useStore, useIsGuest } from '../store'
import { chatModels, defaultModel, NEW_CHAT, useChatStore } from '../chatStore'
import { levelColors, poolLevel, usd } from '../money'
import Modal from './Modal'
import GuestsPanel from './GuestsPanel'
import { Check as CheckIcon, Circle, Close } from './Icon'
import type { CodexStatus, MobileInfo } from '../../../shared/types'

function Check({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={ok ? 'text-zinc-200' : 'text-zinc-600'}>
        {ok ? <CheckIcon size={14} /> : <Circle size={14} />}
      </span>
      <span className={ok ? 'text-zinc-300' : 'text-zinc-500'}>{label}</span>
    </span>
  )
}

type Section =
  'Profile' | 'Appearance' | 'Defaults' | 'Data' | 'Credits' | 'Guests' | 'Integrations'

function SettingsModal(): React.JSX.Element {
  const show = useStore((s) => s.showSettings)
  const setShow = useStore((s) => s.setShowSettings)
  const isGuest = useIsGuest()
  const [section, setSection] = useState<Section>('Profile')
  const onClose = (): void => setShow(false)
  const sections: Section[] = isGuest
    ? ['Profile', 'Appearance', 'Defaults', 'Data', 'Credits']
    : ['Profile', 'Appearance', 'Defaults', 'Data', 'Guests', 'Integrations']

  return (
    <Modal open={show} onClose={onClose} width={780} bare>
      <div className="flex h-[min(620px,82vh)]">
        <nav className="flex w-48 shrink-0 flex-col gap-px border-r border-edge bg-surface-0/40 p-3">
          <div className="px-2.5 pb-3 pt-1 text-[15px] font-semibold tracking-tight text-zinc-50">
            Settings
          </div>
          {sections.map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              data-active={section === s}
              className="settings-nav"
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto px-7 py-6">
          <button
            onClick={onClose}
            className="btn btn-ghost btn-icon absolute right-3 top-3 text-zinc-500"
            title="Close"
          >
            <Close size={14} />
          </button>
          {section === 'Profile' && <ProfileSection />}
          {section === 'Appearance' && <AppearanceSection />}
          {section === 'Defaults' && <DefaultsSection />}
          {section === 'Data' && <DataSection />}
          {section === 'Credits' && <GuestSettings onClose={onClose} />}
          {section === 'Guests' && <GuestsPanel />}
          {section === 'Integrations' && <HostSettings />}
        </div>
      </div>
    </Modal>
  )
}

function Heading({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="mb-5">
      <div className="text-[15px] font-semibold tracking-tight text-zinc-50">{title}</div>
      {hint && <div className="mt-1 text-[12.5px] text-zinc-500">{hint}</div>}
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-edge py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-zinc-200">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Switch({
  on,
  onChange
}: {
  on: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      data-on={on}
      onClick={() => onChange(!on)}
      className="switch"
    />
  )
}

// A text setting saved as you type (a beat after you stop) and when you leave
// the field, so closing Settings never loses it.
function TextSetting({
  field,
  label,
  hint,
  rows
}: {
  field: 'name' | 'about' | 'style'
  label: string
  hint?: string
  rows?: number
}): React.JSX.Element {
  const saved = useStore((s) => s.settings?.[field] ?? '')
  const save = useStore((s) => s.saveSettings)
  const [value, setValue] = useState(saved)
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
    if (value === saved) return
    const timer = setTimeout(() => save({ [field]: value }), 500)
    return () => clearTimeout(timer)
  }, [value, saved, field, save])
  // Leaving the section (or Settings) mid-typing still saves.
  useEffect(
    () => () => {
      if (latest.current !== useStore.getState().settings?.[field]) {
        useStore.getState().saveSettings({ [field]: latest.current })
      }
    },
    [field]
  )
  return (
    <label className="mb-5 block">
      <span className="field-label">{label}</span>
      {rows ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => setValue(e.target.value)}
          className="input h-auto resize-none py-2 leading-relaxed"
        />
      ) : (
        <input value={value} onChange={(e) => setValue(e.target.value)} className="input" />
      )}
      {hint && <span className="mt-1.5 block text-[12px] text-zinc-500">{hint}</span>}
    </label>
  )
}

function ProfileSection(): React.JSX.Element | null {
  const loaded = useStore((s) => s.settings !== null)
  if (!loaded) return null
  return (
    <>
      <Heading title="Profile" hint="Chats you start from now on know this." />
      <TextSetting field="name" label="What should Orcha call you?" />
      <TextSetting
        field="about"
        label="What should it know about you?"
        hint="Your work, what you're learning, anything that helps it help you."
        rows={4}
      />
      <TextSetting
        field="style"
        label="How should it respond?"
        hint="For example: short answers, plain words, explain code like I'm new to it."
        rows={4}
      />
    </>
  )
}

function AppearanceSection(): React.JSX.Element {
  const textSize = useStore((s) => s.settings?.textSize ?? 'default')
  const save = useStore((s) => s.saveSettings)
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')
  useEffect(() => {
    window.orcha.ui
      .getState('theme')
      .then((t) => setTheme(t === 'light' || t === 'dark' ? t : 'system'))
      .catch(() => {})
  }, [])
  const pickTheme = (t: 'system' | 'light' | 'dark'): void => {
    setTheme(t)
    window.orcha.settings.setTheme(t).catch(() => {})
  }
  return (
    <>
      <Heading title="Appearance" />
      <Row label="Theme" hint="System follows your computer's light or dark setting.">
        <div className="segmented w-64">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} data-active={theme === t} onClick={() => pickTheme(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Chat text" hint="The size of messages in chats.">
        <div className="segmented w-64">
          {(['small', 'default', 'large'] as const).map((size) => (
            <button
              key={size}
              data-active={textSize === size}
              onClick={() => save({ textSize: size })}
            >
              {size[0].toUpperCase() + size.slice(1)}
            </button>
          ))}
        </div>
      </Row>
    </>
  )
}

function DefaultsSection(): React.JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const catalog = useStore((s) => s.catalog)
  const identity = useStore((s) => s.identity)
  const save = useStore((s) => s.saveSettings)
  if (!settings) return null
  const models = chatModels(catalog, identity).filter((m) => !m.blocked)
  const current = settings.model ?? defaultModel(catalog, identity) ?? ''
  return (
    <>
      <Heading
        title="Defaults"
        hint="Where a new chat starts. You can change any of it in the chat."
      />
      <Row label="Model" hint="What new chats use.">
        <select
          value={current}
          onChange={(e) => save({ model: e.target.value })}
          className="input w-56"
        >
          {(['anthropic', 'azure'] as const).map((provider) => {
            const group = models.filter((m) => m.provider === provider)
            if (group.length === 0) return null
            return (
              <optgroup key={provider} label={provider === 'anthropic' ? 'Claude' : 'GPT'}>
                {group.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
      </Row>
      <Row label="Think" hint="Take time to reason before answering. Slower, and uses more credit.">
        <Switch
          on={settings.thinking}
          onChange={(on) => {
            save({ thinking: on })
            useChatStore.setState({ thinking: on })
          }}
        />
      </Row>
      <Row label="Search the web" hint="Look things up when it helps.">
        <Switch
          on={settings.webSearch}
          onChange={(on) => {
            save({ webSearch: on })
            useChatStore.setState({ webSearch: on })
          }}
        />
      </Row>
    </>
  )
}

function DataSection(): React.JSX.Element {
  const [exported, setExported] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const exportAll = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.orcha.chat.exportAll()
      if (result) {
        setExported(
          `Saved ${result.count} chat${result.count === 1 ? '' : 's'} to ${result.folder}`
        )
      }
    } finally {
      setBusy(false)
    }
  }
  const deleteAll = async (): Promise<void> => {
    if (!confirm('Delete every chat and everything attached to them? This can’t be undone.')) return
    await window.orcha.chat.removeAll()
    useChatStore.setState({ details: {}, live: {}, running: {}, chats: [] })
    const s = useStore.getState()
    if (s.activeId?.startsWith('chat:')) s.setActive(NEW_CHAT)
  }
  return (
    <>
      <Heading title="Data" hint="Your chats live on this computer." />
      <Row
        label="Export chats"
        hint={exported ?? 'Every chat as a Markdown file, in a folder you choose.'}
      >
        <button onClick={exportAll} disabled={busy} className="btn btn-secondary">
          Export…
        </button>
      </Row>
      <Row label="Delete all chats" hint="Removes every chat and the files attached to them.">
        <button onClick={deleteAll} className="btn btn-danger">
          Delete all
        </button>
      </Row>
    </>
  )
}

// A guest's settings are about the credits they're using.
function GuestSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const balance = useStore((s) => s.guestBalance)
  const guest = useStore((s) => s.guest)
  const openCredits = useStore((s) => s.setShowCredits)
  const [leaving, setLeaving] = useState(false)
  const [copied, setCopied] = useState(false)

  // Something to paste to the host when Orcha misbehaves on this computer.
  const copyDiagnostics = async (): Promise<void> => {
    await window.orcha.clipboard.copy(await window.orcha.app.diagnostics())
    setCopied(true)
  }

  const leave = async (): Promise<void> => {
    if (
      !confirm(
        `Stop using ${guest?.hostName ?? 'your host'}'s credits on this computer? You'd need a new invite link to come back.`
      )
    ) {
      return
    }
    setLeaving(true)
    await window.orcha.guest.leave()
    window.location.reload()
  }

  return (
    <section className="mb-5">
      <Heading title="Credits" />
      <div className="card p-3.5">
        <div className="mb-3 text-[12.5px] text-zinc-400">
          Shared with you by <span className="text-zinc-200">{guest?.hostName}</span>
        </div>
        <div className="flex flex-col gap-2">
          {(balance?.pools ?? []).map((p) => {
            const level = poolLevel(p)
            return (
              <div key={p.pool} className="tnum flex items-baseline justify-between text-[12.5px]">
                <span className="text-zinc-400">{p.label}</span>
                <span className={level === 'ok' ? 'text-zinc-200' : levelColors(level).text}>
                  {usd(Math.max(p.cap - p.spent, 0))} left
                  <span className="text-zinc-600"> of {usd(p.cap)}</span>
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-3.5 flex gap-1.5 border-t border-edge pt-3">
          <button
            onClick={() => {
              onClose()
              openCredits(true)
            }}
            className="btn btn-secondary btn-sm"
          >
            Usage details
          </button>
          <button
            onClick={leave}
            disabled={leaving}
            className="btn btn-ghost btn-sm ml-auto text-zinc-500"
          >
            Unpair this computer
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-zinc-500">
        Something not working?
        <button onClick={copyDiagnostics} className="btn btn-ghost btn-sm -ml-1.5 text-zinc-400">
          {copied ? `Copied, send it to ${guest?.hostName ?? 'your host'}` : 'Copy diagnostics'}
        </button>
      </div>
    </section>
  )
}

function HostSettings(): React.JSX.Element {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mobile, setMobile] = useState<MobileInfo | null>(null)
  const [pairQr, setPairQr] = useState<string | null>(null)

  const refresh = (): void => {
    window.orcha.codex.status().then(setStatus)
    window.orcha.mobile.info().then(setMobile)
  }

  useEffect(() => {
    refresh()
  }, [])

  // The QR only ever renders behind the `mobile.urls.length > 0` gate below,
  // so a stale data URL from a previous open can never show.
  useEffect(() => {
    if (!mobile || mobile.urls.length === 0) return
    let alive = true
    const payload = JSON.stringify({ v: 1, urls: mobile.urls, token: mobile.token })
    QRCode.toDataURL(payload, { margin: 1, width: 176 })
      .then((data) => alive && setPairQr(data))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mobile])

  const handleSetup = async (): Promise<void> => {
    setWorking(true)
    setError(null)
    try {
      await window.orcha.codex.setup()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <>
      <Heading title="Integrations" />
      <section className="mb-5">
        <div className="eyebrow mb-2.5">Phone</div>
        <div className="card p-3.5">
          {mobile && mobile.urls.length > 0 ? (
            <div className="flex items-start gap-3.5">
              {pairQr && (
                <div className="shrink-0 rounded-lg bg-white p-1.5">
                  <img src={pairQr} alt="Pairing QR code" className="block h-32 w-32" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Check
                  ok={mobile.pushReady}
                  label={mobile.pushReady ? 'Phone paired' : 'No phone paired yet'}
                />
                <div className="mt-2 text-[12px] leading-relaxed text-zinc-500">
                  Scan from the Orcha app on your phone. Both devices need Tailscale signed in to
                  the same account.
                </div>
                <div className="mt-2 truncate font-mono text-[10.5px] text-zinc-600">
                  {mobile.urls[0]}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[12px] leading-relaxed text-zinc-500">
              {mobile === null
                ? 'Starting the companion server…'
                : "Companion server isn't running (no reachable address). Check that this machine has a network connection, then reopen Settings."}
            </div>
          )}
        </div>
      </section>

      <section className="mb-5">
        <div className="eyebrow mb-2.5">Codex plugin</div>
        <div className="card p-3.5">
          <div className="flex flex-col gap-2">
            <Check ok={status?.pluginInstalled ?? false} label="Claude Code plugin installed" />
            <Check ok={status?.cliInstalled ?? false} label="Codex CLI installed" />
            <Check ok={status?.authenticated ?? false} label="Codex CLI authenticated" />
          </div>

          {status && !status.cliInstalled && (
            <div className="mt-3 rounded-md bg-surface-0 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-500">
              Install and sign in to the Codex CLI first, from any terminal:
              <br />
              npm install -g @openai/codex
              <br />
              codex login --with-api-key
            </div>
          )}

          {error && <div className="mt-3 text-[12px] text-red-400">{error}</div>}

          <button
            onClick={handleSetup}
            disabled={working || (status?.pluginInstalled ?? false)}
            className="btn btn-secondary mt-3 w-full"
          >
            {working
              ? 'Setting up…'
              : status?.pluginInstalled
                ? 'Plugin installed'
                : 'Set up Codex plugin'}
          </button>
          <div className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-600">
            Adds OpenAI&apos;s official Claude Code plugin so any session can call out to Codex via{' '}
            <code className="font-mono">/codex:review</code>,{' '}
            <code className="font-mono">/codex:rescue</code>, etc. Applies to every Claude Code
            session on this machine, not just Orcha&apos;s.
          </div>
        </div>
      </section>
    </>
  )
}

export default SettingsModal
