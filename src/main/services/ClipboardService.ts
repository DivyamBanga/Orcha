import { execFileAsync } from '../exec'
import { clipboard, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import * as db from '../db'
import { sshArgs, shQuote, type SshTarget } from '../ssh'
import type { ClipEntry, PasteTarget } from '../../shared/types'

const HISTORY_LIMIT = 12
const PREVIEW_CHARS = 240
const CLIP_DIR = join(tmpdir(), 'orcha-clips')
const REMOTE_CLIP_DIR = '/tmp/orcha-clips'
// Text above this pastes as a file reference instead of as keystrokes. The
// TUI ingests a bracketed paste at roughly 15 KB/s over ConPTY (measured), so
// past ~50 KB an inline paste means seconds of waiting; a file lands
// instantly and Claude reads exactly the same content.
const INLINE_LIMIT = 50_000
// A file copied in Explorer (or Finder) arrives as a list of file:// URLs.
const FILE_LIST = 'text/uri-list'

// A history entry plus the payload the renderer never needs to see.
interface StoredClip extends ClipEntry {
  text: string | null
  path: string | null
}

// Everything clipboard-shaped for the session terminals: what a paste should
// turn into, and a rolling history of recent clips for the Ctrl+Shift+V
// overlay. Reads go through Electron's clipboard rather than the renderer's
// navigator.clipboard (no permission/focus failure modes) and never through
// the Claude TUI's own clipboard shortcut, which shells out to PowerShell.
export class ClipboardService {
  private history: StoredClip[] = []
  private signature: string | null = null
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private seq = 0

  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), 1200)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  entries(): ClipEntry[] {
    return this.history.map((c) => ({
      id: c.id,
      kind: c.kind,
      preview: c.preview,
      lines: c.lines,
      chars: c.chars,
      thumb: c.thumb
    }))
  }

  async copy(text: string): Promise<void> {
    await clipboard.writeText(text)
    // A Mac runs no background poll (see start's caller), so the history
    // learns from Orcha's own copies instead.
    if (process.platform === 'darwin') this.record(this.textClip(text))
  }

  // The Mac paste path: an image or long text that arrived in a paste event,
  // saved as a file for the session to reference.
  async saveBlob(workspaceId: string, data: Uint8Array, extension: string): Promise<string> {
    return this.pathFor(workspaceId, this.save(extension, Buffer.from(data)))
  }

  // What Ctrl+V should insert into `workspaceId`'s terminal. Text pastes as
  // text; an image or a file copied in Explorer becomes a path to reference.
  async paste(workspaceId: string): Promise<PasteTarget> {
    const file = await this.clipboardFilePath()
    if (file) return { kind: 'path', path: await this.pathFor(workspaceId, file) }

    const text = await clipboard.readText()
    if (text) return this.textTarget(workspaceId, text)

    const png = await this.readImage()
    if (png) return { kind: 'path', path: await this.pathFor(workspaceId, this.save('png', png)) }
    return { kind: 'empty' }
  }

  // Same, for an older entry picked out of the history overlay.
  async use(workspaceId: string, id: string): Promise<PasteTarget> {
    const clip = this.history.find((c) => c.id === id)
    if (!clip) return { kind: 'empty' }
    if (clip.text !== null) return this.textTarget(workspaceId, clip.text)
    if (clip.path) return { kind: 'path', path: await this.pathFor(workspaceId, clip.path) }
    return { kind: 'empty' }
  }

  private async textTarget(workspaceId: string, text: string): Promise<PasteTarget> {
    if (text.length <= INLINE_LIMIT) return { kind: 'text', text }
    return { kind: 'path', path: await this.pathFor(workspaceId, this.save('txt', text)) }
  }

  // Turns a path on this machine into one the session can actually open. For
  // a remote (SSH) session that means copying the file over first — otherwise
  // the reference would point at a file the server has never seen.
  async pathFor(workspaceId: string, localPath: string): Promise<string> {
    const workspace = db.workspaces.get(workspaceId)
    const project = workspace ? db.projects.get(workspace.projectId) : undefined
    if (!project?.sshHost) return localPath

    const target: SshTarget = {
      host: project.sshHost,
      user: project.sshUser!,
      port: project.sshPort
    }
    const remotePath = `${REMOTE_CLIP_DIR}/${basename(localPath)}`
    await execFileAsync('ssh', [
      ...sshArgs(target, { batch: true }),
      `mkdir -p ${shQuote(REMOTE_CLIP_DIR)}`
    ])
    const scpOpts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']
    if (target.port && target.port !== 22) scpOpts.push('-P', String(target.port))
    await execFileAsync('scp', [
      ...scpOpts,
      localPath,
      `${target.user}@${target.host}:${shQuote(remotePath)}`
    ])
    return remotePath
  }

  // There is no clipboard-change event, so poll a cheap signature (whether
  // there's an image, plus the text) rather than decoding the clipboard every
  // tick. Two images copied back to back share a signature, so only the
  // first joins the history — the live clipboard still pastes the newer one,
  // and the history only exists for older clips.
  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const [text, image] = await Promise.all([clipboard.readText(), clipboard.has('image/png')])
      const signature = `${image}\u0000${text}`
      if (signature === this.signature) return
      this.signature = signature
      this.record(text.trim() ? this.textClip(text) : image ? await this.imageClip() : null)
    } catch {
      // the clipboard was busy (another app holds it); try again next tick
    } finally {
      this.polling = false
    }
  }

  private record(clip: StoredClip | null): void {
    if (!clip) return
    const duplicate = (c: StoredClip): boolean =>
      clip.text !== null ? c.text === clip.text : c.path === clip.path
    this.history = [clip, ...this.history.filter((c) => !duplicate(c))].slice(0, HISTORY_LIMIT)
  }

  private textClip(text: string): StoredClip | null {
    if (!text.trim()) return null
    return {
      id: `clip-${++this.seq}`,
      kind: 'text',
      preview: text.trim().slice(0, PREVIEW_CHARS),
      lines: text.split('\n').length,
      chars: text.length,
      thumb: null,
      text,
      path: null
    }
  }

  private async imageClip(): Promise<StoredClip | null> {
    const png = await this.readImage()
    if (!png) return null
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    return {
      id: `clip-${++this.seq}`,
      kind: 'image',
      preview: `${width}×${height} image`,
      lines: 0,
      chars: 0,
      thumb: image.resize({ height: 40 }).toDataURL(),
      text: null,
      path: this.save('png', png)
    }
  }

  // The clipboard's image as PNG bytes, converting other image types.
  private async readImage(): Promise<Buffer | null> {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t === 'image/png') ?? item.types.find(isImage)
      if (!type) continue
      const bytes = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer())
      if (type === 'image/png') return bytes
      const image = nativeImage.createFromBuffer(bytes)
      if (!image.isEmpty()) return image.toPNG()
    }
    return null
  }

  private save(extension: string, data: Buffer | string): string {
    mkdirSync(CLIP_DIR, { recursive: true })
    const path = join(CLIP_DIR, `paste-${Date.now()}-${++this.seq}.${extension}`)
    writeFileSync(path, data)
    return path
  }

  // The first copied file, if what's on the clipboard is files. A copied web
  // link can also be a uri-list, so only file:// URLs count.
  private async clipboardFilePath(): Promise<string | null> {
    try {
      if (!(await clipboard.has(FILE_LIST))) return null
      for (const item of await clipboard.read()) {
        if (!item.types.includes(FILE_LIST)) continue
        const list = await ((await item.getType(FILE_LIST)) as Blob).text()
        const url = list.split(/\r?\n/).find((line) => line.startsWith('file:'))
        if (!url) return null
        const path = fileURLToPath(url)
        return existsSync(path) ? path : null
      }
      return null
    } catch {
      return null
    }
  }
}

const isImage = (type: string): boolean => type.startsWith('image/')
