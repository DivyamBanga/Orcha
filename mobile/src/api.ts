import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ChatBlock, FleetPayload, NextStep, Pairing } from './types'

const PAIRING_KEY = 'orcha:pairing'

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await AsyncStorage.getItem(PAIRING_KEY)
    return raw ? (JSON.parse(raw) as Pairing) : null
  } catch {
    return null
  }
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(pairing))
}

export async function clearPairing(): Promise<void> {
  await AsyncStorage.removeItem(PAIRING_KEY)
}

function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

async function fetchJson<T>(
  base: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  timeoutMs = 8000
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: withTimeout(timeoutMs)
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const parsed = (await res.json()) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      // keep the status message
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

// Try the last-good URL first; on network failure walk the other candidates
// (Tailscale address first — the desktop puts it first) and remember whichever
// answers. Auth/HTTP errors are real answers and are NOT retried elsewhere.
export class Api {
  constructor(private pairing: Pairing) {}

  get activeUrl(): string {
    return this.pairing.activeUrl
  }

  get token(): string {
    return this.pairing.token
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    timeoutMs?: number
  ): Promise<T> {
    const candidates = [
      this.pairing.activeUrl,
      ...this.pairing.urls.filter((u) => u !== this.pairing.activeUrl)
    ]
    let lastError: unknown = new Error('unreachable')
    for (const base of candidates) {
      try {
        const result = await fetchJson<T>(base, this.pairing.token, path, init, timeoutMs)
        if (base !== this.pairing.activeUrl) {
          this.pairing = { ...this.pairing, activeUrl: base }
          void savePairing(this.pairing)
        }
        return result
      } catch (err) {
        lastError = err
        // A server answer (even an error status) means we reached Orcha —
        // don't hunt other addresses for it.
        if (err instanceof Error && err.message !== 'Aborted' && !/network|abort/i.test(err.message))
          throw err
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PC unreachable')
  }

  fleet(): Promise<FleetPayload> {
    return this.request<FleetPayload>('/v1/fleet')
  }

  chat(sessionId: string): Promise<{ blocks: ChatBlock[] }> {
    return this.request<{ blocks: ChatBlock[] }>(`/v1/session/${sessionId}/chat?limit=120`)
  }

  answerOption(sessionId: string, option: number): Promise<void> {
    return this.request(`/v1/session/${sessionId}/answer`, { method: 'POST', body: { option } })
  }

  answerText(sessionId: string, text: string): Promise<void> {
    return this.request(
      `/v1/session/${sessionId}/answer`,
      { method: 'POST', body: { text } },
      40_000 // dispatch waits for a cold TUI to boot
    )
  }

  interrupt(sessionId: string): Promise<void> {
    return this.request(`/v1/session/${sessionId}/interrupt`, { method: 'POST', body: {} })
  }

  dispatch(projectId: string, prompt: string, sessionId?: string): Promise<{ sessionId: string }> {
    return this.request(
      '/v1/dispatch',
      { method: 'POST', body: { projectId, prompt, sessionId } },
      40_000
    )
  }

  regenNextSteps(projectId: string): Promise<{ steps: NextStep[] }> {
    return this.request(`/v1/project/${projectId}/next-steps`, { method: 'POST', body: {} }, 60_000)
  }

  registerDevice(pushToken: string): Promise<void> {
    return this.request('/v1/device', { method: 'POST', body: { pushToken } })
  }

  termUrl(sessionId: string): string {
    return `${this.pairing.activeUrl}/v1/term/${sessionId}?token=${this.pairing.token}`
  }

  eventsUrl(): string {
    return `${this.pairing.activeUrl.replace(/^http/, 'ws')}/v1/events?token=${this.pairing.token}`
  }
}

// Probe candidates until one answers; used by pairing.
export async function probePairing(urls: string[], token: string): Promise<Pairing | null> {
  for (const base of urls) {
    try {
      await fetchJson(base, token, '/v1/fleet', {}, 4000)
      return { urls, token, activeUrl: base }
    } catch {
      // try the next candidate
    }
  }
  return null
}
