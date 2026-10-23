import { useCallback, useEffect, useState } from 'react'
import { IPC } from '../../../shared/ipc'
import { specFor } from '../../../shared/models'
import { Check as CheckIcon, Circle, Close } from './Icon'
import type {
  ApiKey,
  AzureConnection,
  AzureDeployment,
  Connections,
  Health,
  LocalModel,
  ModelPull,
  OllamaState
} from '../../../shared/ai'

// Settings → Models & keys: where chats get their models. The Max plan comes
// from Claude Code's sign-in; API keys and Azure are pasted here (and kept by
// Windows' keychain, so only a hint ever shows); Ollama runs on this computer.

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

// A connection's health, in a few plain words.
const HEALTH: Record<Health, string> = {
  ok: 'Working',
  unchecked: 'Not checked yet',
  checking: 'Checking…',
  invalid: 'Refused',
  unreachable: "Couldn't reach it",
  'no-credit': 'Out of credit',
  'rate-limited': 'Rate limited'
}

const KIND: Record<AzureDeployment['kind'], string> = {
  chat: 'Chat',
  image: 'Images',
  embedding: 'Embeddings',
  transcription: 'Dictation',
  other: 'Other'
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`

// The connections, kept current: anything that changes them (here, a chat
// that finds a key out of credit, a download's progress) says so.
function useConnections(): Connections | null {
  const [state, setState] = useState<Connections | null>(null)
  useEffect(() => {
    const load = (): void => {
      window.orcha.connections
        .get()
        .then(setState)
        .catch(() => {})
    }
    load()
    // Ollama may have started or stopped since Settings last looked.
    window.orcha.connections.ollama.refresh().catch(() => {})
    return window.orcha.on(IPC.EvModelsChanged, load)
  }, [])
  return state
}

// One action at a time per card, with its error shown under it.
function useAction(): {
  busy: boolean
  error: string | null
  act: (fn: () => Promise<unknown>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, act }
}

function Status({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span className={ok ? 'text-zinc-200' : 'text-zinc-600'}>
        {ok ? <CheckIcon size={14} /> : <Circle size={14} />}
      </span>
      <span className={ok ? 'text-zinc-300' : 'text-zinc-500'}>{label}</span>
    </span>
  )
}

function Card({
  title,
  hint,
  children
}: {
  title: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-5">
      <div className="eyebrow mb-1">{title}</div>
      <div className="mb-2.5 text-[12px] text-zinc-500">{hint}</div>
      <div className="card p-3.5">{children}</div>
    </section>
  )
}

// ---- the Max plan ----

function PlanCard({ plan }: { plan: Connections['plan'] }): React.JSX.Element {
  return (
    <Card
      title="Claude · Max plan"
      hint="Chats on your Claude plan go through Claude Code on this computer. They count toward the plan's limits, not money."
    >
      {plan.signedIn ? (
        <Status
          ok
          label={`Signed in${plan.plan ? ` (${plan.plan[0].toUpperCase()}${plan.plan.slice(1)})` : ''}`}
        />
      ) : (
        <>
          <Status ok={false} label="Claude Code isn't signed in" />
          <div className="mt-2 text-[12px] text-zinc-500">
            Open a Claude tab and type /login, then come back.
          </div>
        </>
      )}
    </Card>
  )
}

// ---- Anthropic API keys ----

function KeyRow({ apiKey }: { apiKey: ApiKey }): React.JSX.Element {
  const { busy, error, act } = useAction()
  const check = useAction()
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const keys = window.orcha.connections
  const rename = (label: string): void => {
    setRenaming(false)
    if (label.trim() && label.trim() !== apiKey.label)
      void act(() => keys.renameKey(apiKey.id, label))
  }
  return (
    <div className="border-b border-edge py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        {renaming ? (
          <input
            autoFocus
            defaultValue={apiKey.label}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(e.currentTarget.value)
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="input h-7 w-40"
            aria-label="Key name"
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className="text-left text-[13px] text-zinc-200"
            title="Rename"
          >
            {apiKey.label}
          </button>
        )}
        <span className="font-mono text-[11px] text-zinc-500">{apiKey.hint}</span>
        {apiKey.isDefault && (
          <span className="rounded-[4px] border border-edge px-1 text-[10.5px] text-zinc-400">
            default
          </span>
        )}
        <span
          className={`ml-auto text-[12px] ${apiKey.health === 'ok' || apiKey.health === 'unchecked' ? 'text-zinc-500' : 'text-wait'}`}
          title={apiKey.detail ?? undefined}
        >
          {HEALTH[apiKey.health]}
        </span>
      </div>
      {apiKey.detail && apiKey.health !== 'ok' && (
        <div className="mt-1 text-[12px] text-zinc-500">{apiKey.detail}</div>
      )}
      <div className="mt-2 flex gap-1.5">
        {!apiKey.isDefault && (
          <button
            onClick={() => act(() => keys.setDefaultKey(apiKey.id))}
            disabled={busy}
            className="btn btn-ghost btn-sm"
            title="Chats on an API key use this one unless they say otherwise"
          >
            Make default
          </button>
        )}
        <button
          onClick={() => check.act(() => keys.checkKey(apiKey.id))}
          disabled={check.busy}
          className="btn btn-ghost btn-sm"
        >
          {check.busy ? 'Checking…' : 'Check'}
        </button>
        {removing ? (
          <>
            <button
              onClick={() => act(() => keys.removeKey(apiKey.id))}
              className="btn btn-danger btn-sm ml-auto"
            >
              Remove key
            </button>
            <button onClick={() => setRemoving(false)} className="btn btn-ghost btn-sm">
              Keep
            </button>
          </>
        ) : (
          <button
            onClick={() => setRemoving(true)}
            className="btn btn-ghost btn-sm ml-auto text-zinc-500"
          >
            Remove
          </button>
        )}
      </div>
      {(error ?? check.error) && (
        <div className="mt-2 text-[12px] text-red-400">{error ?? check.error}</div>
      )}
    </div>
  )
}

function AddKeyForm({ first }: { first: boolean }): React.JSX.Element {
  const { busy, error, act } = useAction()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const add = async (): Promise<void> => {
    if (!key.trim()) return
    if (await act(() => window.orcha.connections.addKey(label.trim() || 'Personal', key))) {
      setLabel('')
      setKey('')
    }
  }
  return (
    <div className={first ? '' : 'mt-3 border-t border-edge pt-3'}>
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name (Personal)"
          className="input w-36"
          aria-label="Key name"
        />
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="sk-ant-…"
          className="input flex-1 font-mono text-[12px]"
          aria-label="Anthropic API key"
          autoComplete="off"
          spellCheck={false}
        />
        <button onClick={add} disabled={busy || !key.trim()} className="btn btn-primary shrink-0">
          {busy ? 'Checking…' : 'Add key'}
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-red-400">{error}</div>}
    </div>
  )
}

function KeysCard({ keys }: { keys: ApiKey[] }): React.JSX.Element {
  return (
    <Card
      title="Claude · API keys"
      hint="Keys from console.anthropic.com. Each is checked before it's kept; the default pays unless a chat picks another."
    >
      {keys.map((k) => (
        <KeyRow key={k.id} apiKey={k} />
      ))}
      <AddKeyForm first={keys.length === 0} />
    </Card>
  )
}

// ---- Azure AI Foundry ----

function ConnectAzure(): React.JSX.Element {
  const { busy, error, act } = useAction()
  const [endpoint, setEndpoint] = useState('')
  const [key, setKey] = useState('')
  const connect = (): void => {
    if (endpoint.trim() && key.trim()) {
      void act(() => window.orcha.connections.setAzure(endpoint, key))
    }
  }
  return (
    <>
      <input
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        placeholder="https://<name>.openai.azure.com"
        className="input mb-2 font-mono text-[12px]"
        aria-label="Azure endpoint"
        spellCheck={false}
      />
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect()}
          placeholder="Key"
          className="input flex-1 font-mono text-[12px]"
          aria-label="Azure key"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          onClick={connect}
          disabled={busy || !endpoint.trim() || !key.trim()}
          className="btn btn-primary shrink-0"
        >
          {busy ? 'Finding deployments…' : 'Connect'}
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-red-400">{error}</div>}
    </>
  )
}

function DeploymentRow({ deployment }: { deployment: AzureDeployment }): React.JSX.Element {
  const azure = window.orcha.connections
  const label = deployment.model ? (specFor(deployment.model)?.label ?? deployment.model) : null
  return (
    <div className="group flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-[12px] text-zinc-200">{deployment.name}</span>
        {label && label !== deployment.name && (
          <span className="ml-2 text-[12px] text-zinc-500">{label}</span>
        )}
      </span>
      <span className="text-[11.5px] text-zinc-500">{KIND[deployment.kind]}</span>
      {deployment.source === 'manual' && (
        <button
          onClick={() => azure.removeDeployment(deployment.name).catch(() => {})}
          className="btn btn-ghost btn-icon h-6 w-6 text-zinc-500 opacity-0 group-hover:opacity-100"
          title="Remove"
        >
          <Close size={12} />
        </button>
      )}
      {deployment.kind === 'chat' && (
        <button
          role="switch"
          aria-checked={deployment.enabled}
          aria-label={`Offer ${deployment.name} in chats`}
          data-on={deployment.enabled}
          onClick={() =>
            azure.setDeployment(deployment.name, { enabled: !deployment.enabled }).catch(() => {})
          }
          className="switch"
          title={deployment.enabled ? 'Offered in chats' : 'Hidden from chats'}
        />
      )}
    </div>
  )
}

function AzureCard({ azure }: { azure: AzureConnection | null }): React.JSX.Element {
  const { busy, error, act } = useAction()
  const probe = useAction()
  const [manual, setManual] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const conn = window.orcha.connections
  const addManual = (): void => {
    const name = manual.trim()
    if (name) void act(() => conn.setDeployment(name, {})).then((ok) => ok && setManual(''))
  }
  return (
    <Card
      title="Azure AI Foundry"
      hint="GPT and image models on your Azure resource, with its endpoint and key. Orcha finds the deployments by their usual names; add any it misses."
    >
      {azure ? (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">
              {azure.endpoint}
            </span>
            <span className="font-mono text-[11px] text-zinc-500">{azure.hint}</span>
            <span
              className={`text-[12px] ${azure.health === 'ok' || azure.health === 'unchecked' ? 'text-zinc-500' : 'text-wait'}`}
            >
              {HEALTH[azure.health]}
            </span>
          </div>
          {azure.detail && azure.health !== 'ok' && (
            <div className="mt-1 text-[12px] text-zinc-500">{azure.detail}</div>
          )}
          <div className="mt-3 border-t border-edge pt-2">
            {azure.deployments.length === 0 && (
              <div className="py-2 text-[12.5px] text-zinc-500">
                No deployments found. Add one by its name below.
              </div>
            )}
            {azure.deployments.map((d) => (
              <DeploymentRow key={d.name} deployment={d} />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addManual()}
              placeholder="Another deployment's name"
              className="input flex-1 font-mono text-[12px]"
              aria-label="Deployment name"
              spellCheck={false}
            />
            <button
              onClick={addManual}
              disabled={busy || !manual.trim()}
              className="btn btn-secondary"
            >
              Add
            </button>
          </div>
          <div className="mt-3 flex gap-1.5 border-t border-edge pt-3">
            <button
              onClick={() => probe.act(() => conn.reprobeAzure())}
              disabled={probe.busy}
              className="btn btn-ghost btn-sm"
            >
              {probe.busy ? 'Looking…' : 'Find deployments again'}
            </button>
            {disconnecting ? (
              <>
                <button
                  onClick={() => act(() => conn.removeAzure())}
                  className="btn btn-danger btn-sm ml-auto"
                >
                  Disconnect
                </button>
                <button onClick={() => setDisconnecting(false)} className="btn btn-ghost btn-sm">
                  Keep
                </button>
              </>
            ) : (
              <button
                onClick={() => setDisconnecting(true)}
                className="btn btn-ghost btn-sm ml-auto text-zinc-500"
              >
                Disconnect
              </button>
            )}
          </div>
          {(error ?? probe.error) && (
            <div className="mt-2 text-[12px] text-red-400">{error ?? probe.error}</div>
          )}
        </>
      ) : (
        <ConnectAzure />
      )}
    </Card>
  )
}

// ---- Ollama ----

function LocalModelRow({ model }: { model: LocalModel }): React.JSX.Element {
  const { busy, error, act } = useAction()
  const [removing, setRemoving] = useState(false)
  const ollama = window.orcha.connections.ollama
  return (
    <div className="border-b border-edge py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">
          {model.name}
        </span>
        <span className="tnum text-[11.5px] text-zinc-500">
          {[model.parameters, gb(model.sizeBytes)].filter(Boolean).join(' · ')}
        </span>
        {model.loaded && (
          <button
            onClick={() => act(() => ollama.unload(model.name))}
            disabled={busy}
            className="btn btn-ghost btn-sm"
            title="Free the memory it's using now"
          >
            Unload
          </button>
        )}
        {removing ? (
          <>
            <button
              onClick={() => act(() => ollama.remove(model.name))}
              className="btn btn-danger btn-sm"
            >
              Delete
            </button>
            <button onClick={() => setRemoving(false)} className="btn btn-ghost btn-sm">
              Keep
            </button>
          </>
        ) : (
          <button onClick={() => setRemoving(true)} className="btn btn-ghost btn-sm text-zinc-500">
            Delete
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-[12px] text-red-400">{error}</div>}
    </div>
  )
}

function PullRow({ pull }: { pull: ModelPull }): React.JSX.Element {
  const pct = pull.total > 0 ? Math.min((pull.completed / pull.total) * 100, 100) : 0
  return (
    <div className="py-2">
      <div className="tnum flex items-baseline justify-between text-[12px]">
        <span className="font-mono text-zinc-300">{pull.name}</span>
        <span className="flex items-center gap-2 text-zinc-500">
          {pull.error
            ? 'Failed'
            : pull.total > 0
              ? `${gb(pull.completed)} of ${gb(pull.total)}`
              : pull.status}
          <button
            onClick={() => window.orcha.connections.ollama.cancelPull(pull.name).catch(() => {})}
            className="btn btn-ghost btn-sm h-5 px-1.5 text-[11px]"
          >
            {pull.error ? 'Dismiss' : 'Cancel'}
          </button>
        </span>
      </div>
      {pull.error ? (
        <div className="mt-1 text-[12px] text-red-400">{pull.error}</div>
      ) : (
        <div className="meter mt-1.5 h-1">
          <div className="meter-fill bg-zinc-300" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function OllamaCard({ ollama }: { ollama: OllamaState }): React.JSX.Element {
  const { busy, error, act } = useAction()
  const [name, setName] = useState('')
  const local = window.orcha.connections.ollama
  const pull = (): void => {
    const model = name.trim()
    if (model) void act(() => local.pull(model)).then((ok) => ok && setName(''))
  }
  return (
    <Card
      title="On this computer · Ollama"
      hint="Local models run free and offline. Orcha starts Ollama when a chat needs it and sizes each model's memory to fit."
    >
      <div className="flex items-center gap-2">
        {ollama.status === 'running' ? (
          <Status ok label={`Running${ollama.version ? ` · ${ollama.version}` : ''}`} />
        ) : ollama.status === 'starting' ? (
          <Status ok={false} label="Starting…" />
        ) : ollama.status === 'stopped' ? (
          <>
            <Status ok={false} label="Not running" />
            <button
              onClick={() => act(() => local.start())}
              disabled={busy}
              className="btn btn-secondary btn-sm ml-auto"
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          </>
        ) : (
          <>
            <Status ok={false} label="Not installed" />
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm ml-auto"
            >
              Get Ollama
            </a>
          </>
        )}
      </div>
      {ollama.status === 'running' && (
        <>
          <div className="mt-3 border-t border-edge pt-1">
            {ollama.models.length === 0 && (
              <div className="py-2 text-[12.5px] text-zinc-500">No models yet.</div>
            )}
            {ollama.models.map((m) => (
              <LocalModelRow key={m.name} model={m} />
            ))}
            {ollama.pulls.map((p) => (
              <PullRow key={p.name} pull={p} />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && pull()}
              placeholder="A model from ollama.com/library, like qwen3.5:9b"
              className="input flex-1 font-mono text-[12px]"
              aria-label="Model to download"
              spellCheck={false}
            />
            <button onClick={pull} disabled={busy || !name.trim()} className="btn btn-secondary">
              Download
            </button>
          </div>
        </>
      )}
      {error && <div className="mt-2 text-[12px] text-red-400">{error}</div>}
    </Card>
  )
}

function ModelsPanel(): React.JSX.Element | null {
  const state = useConnections()
  if (!state) return null
  return (
    <>
      <div className="mb-5">
        <div className="text-[15px] font-semibold tracking-tight text-zinc-50">
          Models &amp; keys
        </div>
        <div className="mt-1 text-[12.5px] text-zinc-500">
          Every model chats can use, and what pays for it.
        </div>
      </div>
      <PlanCard plan={state.plan} />
      <KeysCard keys={state.keys} />
      <AzureCard azure={state.azure} />
      <OllamaCard ollama={state.ollama} />
    </>
  )
}

export default ModelsPanel
