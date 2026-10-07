import { execFileAsync } from '../exec'
import { clipboard, type NativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
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
  private seq = 0

  start(): void {
    this.poll()
    this.timer = setInterval(() => this.poll(), 1200)
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

  copy(text: string): void {
    clipboard.writeText(text)
    // A Mac runs no background poll (see start's caller), so the history
    // learns from Orcha's own copies instead.
    if (process.platform === 'darwin') this.record(this.snapshot([], text))
  }

  // The Mac paste path: an image or long text that arrived in a paste event,
  // saved as a file for the session to reference.
  async saveBlob(workspaceId: string, data: Uint8Array, extension: string): Promise<string> {
    return this.pathFor(workspaceId, this.save(extension, Buffer.from(data)))
  }

  // What Ctrl+V should insert into `workspaceId`'s terminal. Text pastes as
  // text; an image or a file copied in Explorer becomes a path to reference.
  async paste(workspaceId: string): Promise<PasteTarget> {
    const file = this.clipboardFilePath()
    if (file) return { kind: 'path', path: await this.pathFor(workspaceId, file) }

    const text = clipboard.readText()
    if (text) return this.textTarget(workspaceId, text)

    const image = clipboard.readImage()
    if (!image.isEmpty()) {
      return { kind: 'path', path: await this.pathFor(workspaceId, this.saveImage(image)) }
    }
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
    return { kind: 'path', path: await this.pathFor(workspaceId, this.saveText(text)) }
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

  // There is no clipboard-change event, so poll a cheap signature (format
  // list + text) rather than decoding the clipboard every tick. Two images
  // copied back to back share a signature, so only the first joins the
  // history — the live clipboard still pastes the newer one, and the history
  // only exists for older clips.
  private poll(): void {
    let formats: string[]
    let text: string
    try {
      formats = clipboard.availableFormats()
      text = clipboard.readText()
    } catch {
      return
    }
    const signature = `${formats.join('|')}\u0000${text}`
    if (signature === this.signature) return
    this.signature = signature
    this.record(this.snapshot(formats, text))
  }

  private record(clip: StoredClip | null): void {
    if (!clip) return
    const duplicate = (c: StoredClip): boolean =>
      clip.text !== null ? c.text === clip.text : c.path === clip.path
    this.history = [clip, ...this.history.filter((c) => !duplicate(c))].slice(0, HISTORY_LIMIT)
  }

  private snapshot(formats: string[], text: string): StoredClip | null {
    const id = `clip-${++this.seq}`
    if (text.trim()) {
      return {
        id,
        kind: 'text',
        preview: text.trim().slice(0, PREVIEW_CHARS),
        lines: text.split('\n').length,
        chars: text.length,
        thumb: null,
        text,
        path: null
      }
    }
    if (!formats.some((f) => f.startsWith('image/'))) return null
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    try {
      return {
        id,
        kind: 'image',
        preview: `${width}×${height} image`,
        lines: 0,
        chars: 0,
        thumb: image.resize({ height: 40 }).toDataURL(),
        text: null,
        path: this.saveImage(image)
      }
    } catch {
      return null
    }
  }

  private saveImage(image: NativeImage): string {
    return this.save('png', image.toPNG())
  }

  private saveText(text: string): string {
    return this.save('txt', text)
  }

  private save(extension: string, data: Buffer | string): string {
    mkdirSync(CLIP_DIR, { recursive: true })
    const path = join(CLIP_DIR, `paste-${Date.now()}-${++this.seq}.${extension}`)
    writeFileSync(path, data)
    return path
  }

  // A file copied in Explorer rides on the Windows-only CF_HDROP format,
  // which Electron exposes as a UTF-16 'FileNameW' buffer holding one path.
  private clipboardFilePath(): string | null {
    if (process.platform !== 'win32') return null
    try {
      const buffer = clipboard.readBuffer('FileNameW')
      if (buffer.length === 0) return null
      const path = buffer.toString('ucs2').replace(/\0.*$/, '')
      return path && existsSync(path) ? path : null
    } catch {
      return null
    }
  }
}
