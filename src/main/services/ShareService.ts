import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { IPC } from '../../shared/ipc'
import * as db from '../db'
import type { PtyManager } from './PtyManager'

type SendFn = (channel: string, payload: unknown) => void

const CLOUDFLARED_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

interface Share {
  token: string
  name: string
  viewers: Set<WebSocket>
}

// Live read-only view of a session terminal, shareable as a plain https link.
// A local ws server streams the pty; a cloudflared quick tunnel (free, no
// account) makes it reachable from anywhere. Viewers need only a browser.
export class ShareService {
  private server: Server | null = null
  private wss = new WebSocketServer({ noServer: true })
  private port = 0
  private shares = new Map<string, Share>() // workspaceId -> share
  private byToken = new Map<string, string>() // token -> workspaceId
  private tunnel: { proc: ChildProcess; url: string } | null = null

  constructor(
    private send: SendFn,
    private ptyManager: PtyManager
  ) {
    // Mirror live pty traffic to any attached viewers.
    ptyManager.onData = (id, data) => this.broadcast(id, { t: 'd', d: data })
    ptyManager.onResize = (id, cols, rows) => this.broadcast(id, { t: 'resize', cols, rows })
    ptyManager.onExit = (id) => this.broadcast(id, { t: 'end' })
  }

  urlFor(workspaceId: string): string | null {
    const share = this.shares.get(workspaceId)
    return share && this.tunnel ? `${this.tunnel.url}/s/${share.token}` : null
  }

  async start(workspaceId: string): Promise<{ url: string }> {
    const existing = this.urlFor(workspaceId)
    if (existing) return { url: existing }

    const workspace = db.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown session: ${workspaceId}`)
    if (!this.ptyManager.has(workspaceId)) await this.ptyManager.create(workspaceId, 120, 30)
    // A session restored hidden (never shown) boots at a near-zero fit size;
    // give viewers a real screen. The host refits on next show and wins.
    const size = this.ptyManager.size(workspaceId)
    if (size && size.cols < 40) this.ptyManager.resize(workspaceId, 120, 30)

    await this.ensureServer()
    const url = await this.ensureTunnel(workspaceId)

    // A share left over from a dead tunnel gets a fresh token.
    const prior = this.shares.get(workspaceId)
    if (prior) this.byToken.delete(prior.token)
    const token = randomBytes(16).toString('hex')
    this.shares.set(workspaceId, { token, name: workspace.name, viewers: new Set() })
    this.byToken.set(token, workspaceId)
    const shareUrl = `${url}/s/${token}`
    this.send(IPC.EvShareStatus, { workspaceId, phase: 'ready', url: shareUrl })
    return { url: shareUrl }
  }

  stop(workspaceId: string): void {
    const share = this.shares.get(workspaceId)
    if (!share) return
    for (const ws of share.viewers) ws.close()
    this.shares.delete(workspaceId)
    this.byToken.delete(share.token)
    this.send(IPC.EvShareStatus, { workspaceId, phase: 'stopped' })
    if (this.shares.size === 0) this.teardown()
  }

  stopAll(): void {
    for (const id of [...this.shares.keys()]) this.stop(id)
  }

  private broadcast(workspaceId: string, msg: object): void {
    const share = this.shares.get(workspaceId)
    if (!share || share.viewers.size === 0) return
    const raw = JSON.stringify(msg)
    for (const ws of share.viewers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
    }
  }

  private teardown(): void {
    this.tunnel?.proc.kill()
    this.tunnel = null
    this.server?.close()
    this.server = null
  }

  private ensureServer(): Promise<void> {
    if (this.server) return Promise.resolve()
    const server = createServer((req, res) => this.handleHttp(req, res))
    server.on('upgrade', (req, socket, head) => {
      const token = req.url?.match(/^\/ws\/([a-f0-9]{32})$/)?.[1]
      const workspaceId = token ? this.byToken.get(token) : undefined
      if (!workspaceId) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, workspaceId))
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port
        resolve()
      })
    })
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''
    const asset = (rel: string, type: string): void => {
      try {
        const body = readFileSync(join(app.getAppPath(), 'node_modules', rel))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' })
        res.end(body)
      } catch {
        res.writeHead(404).end()
      }
    }
    if (url === '/xterm.js')
      return asset(join('@xterm', 'xterm', 'lib', 'xterm.js'), 'text/javascript')
    if (url === '/xterm.css') return asset(join('@xterm', 'xterm', 'css', 'xterm.css'), 'text/css')
    const token = url.match(/^\/s\/([a-f0-9]{32})$/)?.[1]
    const workspaceId = token ? this.byToken.get(token) : undefined
    const share = workspaceId ? this.shares.get(workspaceId) : undefined
    if (!token || !share) {
      res
        .writeHead(404, { 'content-type': 'text/plain' })
        .end('This share link is no longer active.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(viewerHtml(token, share.name))
  }

  private attach(ws: WebSocket, workspaceId: string): void {
    const share = this.shares.get(workspaceId)
    if (!share) {
      ws.close()
      return
    }
    share.viewers.add(ws)
    ws.on('close', () => share.viewers.delete(ws))
    // Read-only: viewer input is ignored entirely.
    const size = this.ptyManager.size(workspaceId) ?? { cols: 120, rows: 30 }
    ws.send(JSON.stringify({ t: 'init', name: share.name, cols: size.cols, rows: size.rows }))
    const replay = this.ptyManager.buffer(workspaceId)
    if (replay) ws.send(JSON.stringify({ t: 'd', d: replay }))
    // ConPTY only sends diffs; force a full repaint so the viewer starts from
    // the true current screen instead of a stale scrollback stitch.
    this.ptyManager.forceRepaint(workspaceId)
  }

  // --- cloudflared quick tunnel ---------------------------------------------

  private async ensureTunnel(workspaceId: string): Promise<string> {
    if (this.tunnel) return this.tunnel.url
    const bin = await this.findCloudflared(workspaceId)
    this.send(IPC.EvShareStatus, { workspaceId, phase: 'tunnel' })
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate'])
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Tunnel took too long to start. Check your network and try again.'))
      }, 45_000)
      const scan = (chunk: Buffer): void => {
        out = (out + chunk.toString()).slice(-8192)
        const m = out.match(TUNNEL_URL)
        if (m) {
          clearTimeout(timer)
          resolve(m[0])
        }
      }
      proc.stdout.on('data', scan)
      proc.stderr.on('data', scan)
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('Tunnel process exited before a URL was assigned.'))
      })
    })
    proc.on('exit', () => {
      if (this.tunnel?.proc === proc) this.tunnel = null
    })
    this.tunnel = { proc, url }
    return url
  }

  // cloudflared from PATH if present, else a copy downloaded to ~/.orcha/bin
  // (one time, ~60 MB) so sharing needs zero manual setup.
  private async findCloudflared(workspaceId: string): Promise<string> {
    if (spawnSync('cloudflared', ['--version']).status === 0) return 'cloudflared'
    const local = join(homedir(), '.orcha', 'bin', 'cloudflared.exe')
    if (existsSync(local)) return local
    this.send(IPC.EvShareStatus, { workspaceId, phase: 'downloading' })
    const res = await fetch(CLOUDFLARED_URL)
    if (!res.ok) throw new Error(`Couldn't download cloudflared (HTTP ${res.status})`)
    mkdirSync(dirname(local), { recursive: true })
    writeFileSync(local, Buffer.from(await res.arrayBuffer()))
    return local
  }
}

function viewerHtml(token: string, name: string): string {
  const boot = JSON.stringify({ token, name })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(name)} · live · orcha</title>
<link rel="stylesheet" href="/xterm.css" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100dvh; display: flex; flex-direction: column;
         background: #0b0b0d; color: #d4d4d8;
         font: 13px 'Cascadia Code', Consolas, monospace; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
           border-bottom: 1px solid #27272a; flex-shrink: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399;
         animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .name { color: #fafafa; font-weight: 600; }
  .tag { color: #71717a; font-size: 11px; }
  .right { margin-left: auto; color: #52525b; font-size: 11px; }
  main { flex: 1; min-height: 0; padding: 8px; }
  #term { height: 100%; }
  #overlay { position: fixed; inset: 0; display: none; align-items: center;
             justify-content: center; background: rgba(11,11,13,0.85);
             color: #a1a1aa; font-size: 14px; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="name">${escapeHtml(name)}</span>
  <span class="tag">live &middot; read-only</span>
  <span class="right">shared from orcha</span>
</header>
<main><div id="term"></div></main>
<div id="overlay"></div>
<script src="/xterm.js"></script>
<script>
  const boot = ${boot};
  const term = new Terminal({
    cols: 120, rows: 30, disableStdin: true, scrollback: 5000,
    fontSize: 13, fontFamily: "'Cascadia Code', Consolas, monospace",
    theme: { background: '#0b0b0d', foreground: '#d4d4d8', cursor: '#d4d4d8' }
  });
  term.open(document.getElementById('term'));
  const overlay = document.getElementById('overlay');
  const dot = document.getElementById('dot');

  // Viewers can't resize the host pty, so scale the font to fit its columns.
  function fitFont() {
    const width = document.getElementById('term').clientWidth;
    const fs = Math.max(7, Math.min(17, Math.floor(width / (term.cols * 0.62))));
    term.options.fontSize = fs;
  }
  addEventListener('resize', fitFont);

  let ended = false;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws/' + boot.token);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'init') { term.resize(msg.cols, msg.rows); fitFont(); }
      else if (msg.t === 'd') term.write(msg.d);
      else if (msg.t === 'resize') { term.resize(msg.cols, msg.rows); fitFont(); }
      else if (msg.t === 'end') {
        ended = true;
        overlay.textContent = 'session ended';
        overlay.style.display = 'flex';
        dot.style.background = '#71717a';
        dot.style.animation = 'none';
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
