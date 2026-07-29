import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { networkInterfaces } from 'os'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as db from '../db'
import { fetchPlanUsage } from '../planUsage'
import {
  lastActivityAgeSeconds,
  pendingAsk,
  readChatDigest,
  readRecentActivity
} from '../claudeSessions'
import { generateNextSteps } from './NextSteps'
import type { PtyManager } from './PtyManager'
import type { ActivityMonitor, ActivityState, PingKind } from './ActivityMonitor'
import type { ChatBlock, MobileInfo, NextStep, PendingAsk } from '../../shared/types'

// The phone companion's server: a token-authed HTTP+WS API on a fixed port,
// reached over Tailscale (or the LAN). Everything the phone shows comes from
// state Orcha already owns — the activity state machine, the transcript
// parsers, and dispatchPrompt — this service is only transport and push.
const BASE_PORT = 4680
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

const TOKEN_KEY = 'mobile:token'
const PUSH_KEY = 'mobile:pushToken'
// Don't regenerate suggestions for a project more often than this; several
// sessions finishing back-to-back should produce one fresh set, not three.
const NEXT_STEPS_MIN_MS = 30_000

const nextKey = (projectId: string): string => `mobile:next:${projectId}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FleetSession {
  id: string
  name: string
  kind: string
  state: ActivityState
  ask: PendingAsk | null
  askAt: number | null
  lastLine: string | null
  lastActivityAgoS: number | null
  terminalOpen: boolean
}

interface FleetProject {
  id: string
  name: string
  ssh: boolean
  sessions: FleetSession[]
  nextSteps: NextStep[]
  nextStepsAt: number | null
}

export interface FleetPayload {
  projects: FleetProject[]
  usage: { pct: number; resetsAt: number | null } | null
  at: number
}

export class MobileService {
  private server: Server | null = null
  private wss = new WebSocketServer({ noServer: true })
  private port = 0
  private token = ''
  // Sessions the ActivityMonitor classified as blocked, until they resume or
  // an answer is sent. The fleet only shows an answer card for these — a
  // merely-idle session ending its last message with "?" is not blocked.
  private blocked = new Map<string, { body: string; at: number }>()
  private events = new Set<WebSocket>()
  private termViewers = new Map<string, Set<WebSocket>>()
  private nextStepsInflight = new Set<string>()

  constructor(
    private ptyManager: PtyManager,
    private activityMonitor: ActivityMonitor
  ) {
    ptyManager.tapData((id, data) => this.termBroadcast(id, { t: 'd', d: data }))
    ptyManager.tapResize((id, cols, rows) => this.termBroadcast(id, { t: 'resize', cols, rows }))
    ptyManager.tapExit((id) => this.termBroadcast(id, { t: 'end' }))
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    const existing = db.appState.get(TOKEN_KEY)
    if (existing) {
      this.token = existing
    } else {
      this.token = randomBytes(16).toString('hex')
      db.appState.set(TOKEN_KEY, this.token)
    }
    for (let port = BASE_PORT; port < BASE_PORT + 10; port++) {
      try {
        await this.listen(port)
        this.port = port
        console.log('[mobile] listening on', port)
        return
      } catch {
        // port taken; try the next one
      }
    }
    console.log('[mobile] no free port near', BASE_PORT, '— phone companion disabled')
  }

  stop(): void {
    for (const ws of this.events) ws.close()
    for (const set of this.termViewers.values()) for (const ws of set) ws.close()
    this.server?.close()
    this.server = null
  }

  private listen(port: number): Promise<void> {
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        console.log('[mobile] request failed:', err instanceof Error ? err.message : err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      })
    })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.searchParams.get('token') !== this.token) {
        socket.destroy()
        return
      }
      if (url.pathname === '/v1/events') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.events.add(ws)
          ws.on('close', () => this.events.delete(ws))
        })
        return
      }
      const term = url.pathname.match(/^\/v1\/term-ws\/([A-Za-z0-9-]+)$/)?.[1]
      if (term && db.workspaces.get(term)) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attachTermViewer(ws, term))
        return
      }
      socket.destroy()
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      // All interfaces: the Tailscale address is the intended path, the token
      // is the gate. Nothing here is reachable from the internet unless the
      // user exposes it themselves.
      server.listen(port, '0.0.0.0', () => {
        this.server = server
        resolve()
      })
    })
  }

  info(): MobileInfo {
    const tailscale: string[] = []
    const other: string[] = []
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        // Tailscale hands out CGNAT addresses in 100.64.0.0/10.
        const octets = addr.address.split('.').map(Number)
        if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) tailscale.push(addr.address)
        else other.push(addr.address)
      }
    }
    return {
      port: this.port,
      token: this.token,
      urls: [...tailscale, ...other].map((ip) => `http://${ip}:${this.port}`),
      pushReady: Boolean(db.appState.get(PUSH_KEY))
    }
  }

  // --- pings from the ActivityMonitor ---------------------------------------

  // Same classification and confirmation gates as the desktop toasts. The
  // phone gets blocked + finished (the two the user chose); exited stays
  // desktop-only. Focused at the PC = no push, matching the desktop rule.
  handlePing(workspaceId: string, kind: PingKind, body: string, focused: boolean): void {
    if (kind === 'blocked') {
      this.blocked.set(workspaceId, { body, at: Date.now() })
    } else {
      this.blocked.delete(workspaceId)
    }
    if (kind === 'finished') {
      const workspace = db.workspaces.get(workspaceId)
      if (workspace) this.autoNextSteps(workspace.projectId)
    }
    if (!focused && (kind === 'blocked' || kind === 'finished')) {
      void this.sendPush(workspaceId, kind, body)
    }
    this.eventBroadcast({ t: 'ping', sessionId: workspaceId, kind })
  }

  handleState(workspaceId: string, state: ActivityState): void {
    if (state === 'working') this.blocked.delete(workspaceId)
    this.eventBroadcast({ t: 'state', sessionId: workspaceId, state })
  }

  private label(workspaceId: string): string {
    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) return 'Claude session'
    const project = db.projects.get(workspace.projectId)?.name
    const session = workspace.kind === 'main' ? 'main' : workspace.name
    return project ? `${project} · ${session}` : workspace.name
  }

  private async sendPush(workspaceId: string, kind: PingKind, body: string): Promise<void> {
    const to = db.appState.get(PUSH_KEY)
    if (!to) return
    const label = this.label(workspaceId)
    const title = kind === 'blocked' ? `${label} needs your answer` : `${label} is done`
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to,
          title,
          body,
          data: { sessionId: workspaceId, kind },
          sound: kind === 'blocked' ? 'default' : null,
          channelId: kind,
          categoryId: kind === 'blocked' ? 'blocked' : undefined,
          priority: 'high'
        }),
        signal: AbortSignal.timeout(10_000)
      })
      console.log('[mobile push]', kind, '|', title, '|', body)
    } catch {
      // Offline is fine — the app catches up from the fleet when opened.
    }
  }

  // --- next steps ------------------------------------------------------------

  private storedNextSteps(projectId: string): { steps: NextStep[]; at: number } | null {
    const raw = db.appState.get(nextKey(projectId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as { steps: NextStep[]; at: number }
    } catch {
      return null
    }
  }

  private autoNextSteps(projectId: string): void {
    const stored = this.storedNextSteps(projectId)
    if (stored && Date.now() - stored.at < NEXT_STEPS_MIN_MS) return
    void this.regenNextSteps(projectId)
  }

  private async regenNextSteps(projectId: string): Promise<NextStep[]> {
    if (this.nextStepsInflight.has(projectId)) {
      return this.storedNextSteps(projectId)?.steps ?? []
    }
    const project = db.projects.get(projectId)
    if (!project) return []
    this.nextStepsInflight.add(projectId)
    try {
      const steps = await generateNextSteps(project)
      if (steps.length > 0) {
        db.appState.set(nextKey(projectId), JSON.stringify({ steps, at: Date.now() }))
        this.eventBroadcast({ t: 'fleet' })
      }
      return steps
    } catch (err) {
      console.log('[mobile] next-steps failed:', err instanceof Error ? err.message : err)
      return []
    } finally {
      this.nextStepsInflight.delete(projectId)
    }
  }

  // --- fleet -----------------------------------------------------------------

  private async fleet(): Promise<FleetPayload> {
    const plan = await fetchPlanUsage(false).catch(() => null)
    const five = plan?.limits.find((l) => l.key === 'five_hour') ?? null
    const workspaces = db.workspaces.listActive()
    const projects: FleetProject[] = db.projects.list().map((p) => {
      const sessions = workspaces
        .filter((w) => w.projectId === p.id)
        .map((w): FleetSession => {
          const state = this.activityMonitor.current(w.id)
          const mark = this.blocked.get(w.id)
          // Re-verify a remembered block against the transcript: the user may
          // have answered from the desk. SSH sessions have no local transcript,
          // so the screen-scraped body from the ping is the card there.
          let ask: PendingAsk | null = null
          if (mark && state === 'waiting') {
            ask = pendingAsk(w.worktreePath) ?? { question: mark.body, options: [] }
          }
          const age = lastActivityAgeSeconds(w.worktreePath)
          return {
            id: w.id,
            name: w.kind === 'main' ? 'main' : w.name,
            kind: w.kind,
            state,
            ask,
            askAt: mark?.at ?? null,
            lastLine: readRecentActivity(w.worktreePath, 1)[0] ?? null,
            lastActivityAgoS: age === null ? null : Math.round(age),
            terminalOpen: this.ptyManager.has(w.id)
          }
        })
      const stored = this.storedNextSteps(p.id)
      return {
        id: p.id,
        name: p.name,
        ssh: Boolean(p.sshHost),
        sessions,
        nextSteps: stored?.steps ?? [],
        nextStepsAt: stored?.at ?? null
      }
    })
    return {
      projects,
      usage: five ? { pct: Math.round(five.utilization), resetsAt: five.resetsAt } : null,
      at: Date.now()
    }
  }

  // --- http ------------------------------------------------------------------

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization
    if (header === `Bearer ${this.token}`) return true
    return url.searchParams.get('token') === this.token
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    // xterm assets for the terminal peek page — no secrets in them.
    if (path === '/xterm.js') return this.asset(res, join('@xterm', 'xterm', 'lib', 'xterm.js'), 'text/javascript')
    if (path === '/xterm.css') return this.asset(res, join('@xterm', 'xterm', 'css', 'xterm.css'), 'text/css')

    if (!this.authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'GET' && path === '/v1/fleet') {
      return this.json(res, await this.fleet())
    }

    const chat = path.match(/^\/v1\/session\/([A-Za-z0-9-]+)\/chat$/)?.[1]
    if (req.method === 'GET' && chat) {
      const workspace = db.workspaces.get(chat)
      if (!workspace) return this.json(res, { error: 'unknown session' }, 404)
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 80)
      const blocks: ChatBlock[] = readChatDigest(workspace.worktreePath, limit)
      return this.json(res, { blocks })
    }

    const term = path.match(/^\/v1\/term\/([A-Za-z0-9-]+)$/)?.[1]
    if (req.method === 'GET' && term) {
      const workspace = db.workspaces.get(term)
      if (!workspace) return this.json(res, { error: 'unknown session' }, 404)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(termHtml(term, this.token, this.label(term)))
      return
    }

    if (req.method !== 'POST') return this.json(res, { error: 'not found' }, 404)
    const body = await this.readBody(req)

    const answer = path.match(/^\/v1\/session\/([A-Za-z0-9-]+)\/answer$/)?.[1]
    if (answer) {
      const workspace = db.workspaces.get(answer)
      if (!workspace) return this.json(res, { error: 'unknown session' }, 404)
      if (typeof body.option === 'number' && body.option >= 1 && body.option <= 9) {
        // The TUI's option picker selects by digit; the trailing Enter
        // confirms. On a screen without a picker this just types a digit
        // into the composer — same as answering from the desk would.
        this.ptyManager.write(answer, String(body.option))
        await sleep(250)
        this.ptyManager.write(answer, '\r')
      } else if (typeof body.text === 'string' && body.text.trim()) {
        await this.ptyManager.dispatchPrompt(answer, body.text.trim())
      } else {
        return this.json(res, { error: 'need option (1-9) or text' }, 400)
      }
      this.blocked.delete(answer)
      this.eventBroadcast({ t: 'fleet' })
      return this.json(res, { ok: true })
    }

    const interrupt = path.match(/^\/v1\/session\/([A-Za-z0-9-]+)\/interrupt$/)?.[1]
    if (interrupt) {
      if (!db.workspaces.get(interrupt)) return this.json(res, { error: 'unknown session' }, 404)
      this.ptyManager.write(interrupt, '\x1b')
      return this.json(res, { ok: true })
    }

    if (path === '/v1/dispatch') {
      const projectId = typeof body.projectId === 'string' ? body.projectId : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (!projectId || !prompt) return this.json(res, { error: 'need projectId and prompt' }, 400)
      const sessions = db.workspaces.listActive().filter((w) => w.projectId === projectId)
      const target =
        (typeof body.sessionId === 'string' && sessions.find((w) => w.id === body.sessionId)) ||
        sessions.find((w) => w.kind === 'main') ||
        sessions[0]
      if (!target) return this.json(res, { error: 'project has no open sessions' }, 404)
      await this.ptyManager.dispatchPrompt(target.id, prompt)
      this.eventBroadcast({ t: 'fleet' })
      return this.json(res, { ok: true, sessionId: target.id })
    }

    const regen = path.match(/^\/v1\/project\/([A-Za-z0-9-]+)\/next-steps$/)?.[1]
    if (regen) {
      const steps = await this.regenNextSteps(regen)
      return this.json(res, { steps })
    }

    if (path === '/v1/device') {
      const pushToken = typeof body.pushToken === 'string' ? body.pushToken.trim() : ''
      if (!pushToken) return this.json(res, { error: 'need pushToken' }, 400)
      db.appState.set(PUSH_KEY, pushToken)
      console.log('[mobile] push token registered')
      return this.json(res, { ok: true })
    }

    return this.json(res, { error: 'not found' }, 404)
  }

  private json(res: ServerResponse, payload: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  private asset(res: ServerResponse, rel: string, type: string): void {
    try {
      const body = readFileSync(join(app.getAppPath(), 'node_modules', rel))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString()
        if (raw.length > 1_000_000) {
          reject(new Error('body too large'))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (!raw) return resolve({})
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          resolve({})
        }
      })
      req.on('error', reject)
    })
  }

  // --- websockets ------------------------------------------------------------

  private eventBroadcast(msg: object): void {
    if (this.events.size === 0) return
    const raw = JSON.stringify(msg)
    for (const ws of this.events) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
    }
  }

  private termBroadcast(workspaceId: string, msg: object): void {
    const viewers = this.termViewers.get(workspaceId)
    if (!viewers || viewers.size === 0) return
    const raw = JSON.stringify(msg)
    for (const ws of viewers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
    }
  }

  private attachTermViewer(ws: WebSocket, workspaceId: string): void {
    let viewers = this.termViewers.get(workspaceId)
    if (!viewers) {
      viewers = new Set()
      this.termViewers.set(workspaceId, viewers)
    }
    viewers.add(ws)
    ws.on('close', () => viewers.delete(ws))
    void (async () => {
      if (!this.ptyManager.has(workspaceId)) {
        await this.ptyManager.create(workspaceId, 120, 30).catch(() => {})
      }
      const size = this.ptyManager.size(workspaceId) ?? { cols: 120, rows: 30 }
      ws.send(JSON.stringify({ t: 'init', cols: size.cols, rows: size.rows }))
      const replay = this.ptyManager.buffer(workspaceId)
      if (replay) ws.send(JSON.stringify({ t: 'd', d: replay }))
      // ConPTY only sends diffs; force a repaint so the phone starts from the
      // true current screen.
      this.ptyManager.forceRepaint(workspaceId)
    })()
  }
}

// Read-only terminal peek for the phone's WebView — same wire protocol as the
// live-share viewer, served over the tailnet with the pairing token.
function termHtml(workspaceId: string, token: string, name: string): string {
  const boot = JSON.stringify({ workspaceId, token })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(name)} · orcha</title>
<link rel="stylesheet" href="/xterm.css" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100dvh; display: flex; flex-direction: column;
         background: #0b0b0d; color: #d4d4d8;
         font: 12px 'Cascadia Code', Consolas, monospace; }
  main { flex: 1; min-height: 0; padding: 6px; }
  #term { height: 100%; }
  #overlay { position: fixed; inset: 0; display: none; align-items: center;
             justify-content: center; background: rgba(11,11,13,0.85);
             color: #a1a1aa; font-size: 13px; }
</style>
</head>
<body>
<main><div id="term"></div></main>
<div id="overlay"></div>
<script src="/xterm.js"></script>
<script>
  const boot = ${boot};
  const term = new Terminal({
    cols: 120, rows: 30, disableStdin: true, scrollback: 5000,
    fontSize: 11, fontFamily: "'Cascadia Code', Consolas, monospace",
    theme: { background: '#0b0b0d', foreground: '#d4d4d8', cursor: '#d4d4d8' }
  });
  term.open(document.getElementById('term'));
  const overlay = document.getElementById('overlay');

  function fitFont() {
    const width = document.getElementById('term').clientWidth;
    const fs = Math.max(5, Math.min(15, Math.floor(width / (term.cols * 0.62))));
    term.options.fontSize = fs;
  }
  addEventListener('resize', fitFont);

  let ended = false;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/v1/term-ws/' + boot.workspaceId + '?token=' + boot.token);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'init') { term.resize(msg.cols, msg.rows); fitFont(); }
      else if (msg.t === 'd') term.write(msg.d);
      else if (msg.t === 'resize') { term.resize(msg.cols, msg.rows); fitFont(); }
      else if (msg.t === 'end') {
        ended = true;
        overlay.textContent = 'session ended';
        overlay.style.display = 'flex';
      }
    };
    ws.onopen = () => { overlay.style.display = 'none'; };
    ws.onclose = () => {
      if (ended) return;
      overlay.textContent = 'connection lost — retrying…';
      overlay.style.display = 'flex';
      setTimeout(connect, 2500);
    };
  }
  connect();
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
