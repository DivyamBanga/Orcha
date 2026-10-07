import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app, protocol } from 'electron'
import { officeText, type OfficeKind } from './officeText'
import type { ChatFile } from '../../shared/types'

// Files attached to chat messages, stored once each under their content hash
// in <userData>/attachments: images and PDFs as they are (the renderer has
// already shrunk images), text as UTF-8, and Office documents beside the text
// read out of them. Every turn sends the files on its branch again, so they
// are read back from here rather than kept in the database.

export const MAX_FILE_BYTES = 30 * 1024 * 1024
// About 150k tokens: past this a single file would crowd out the chat.
const MAX_TEXT_CHARS = 600_000

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
// Text the models read as-is: anything text/*, plus the usual code and data
// files that browsers don't label as text.
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|r|lua|pl|scala|dart|vue|svelte|tex|bib|srt|vtt|gitignore|dockerfile|makefile)$/i
const OFFICE_EXT: Record<string, OfficeKind> = { docx: 'docx', pptx: 'pptx', xlsx: 'xlsx' }
const LEGACY_OFFICE = /\.(doc|xls|ppt)$/i

const dir = (): string => join(app.getPath('userData'), 'attachments')
const ext = (name: string): string => /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? ''

function blobName(file: Pick<ChatFile, 'hash' | 'kind' | 'mime' | 'name'>): string {
  if (file.kind === 'image') return `${file.hash}.${IMAGE_TYPES[file.mime] ?? 'img'}`
  if (file.kind === 'pdf') return `${file.hash}.pdf`
  const office = OFFICE_EXT[ext(file.name)]
  return office ? `${file.hash}.${office}` : `${file.hash}.txt`
}

// A PDF's page count, by counting its page objects: no parser needed, and
// close enough to check a model's page limit.
function pdfPages(data: Uint8Array): number {
  const text = Buffer.from(data).toString('latin1')
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

function looksLikeText(data: Uint8Array): boolean {
  const head = data.subarray(0, 8192)
  return !head.includes(0)
}

// Saves an attached file and says what it is. Throws, in plain words, for
// anything a chat can't read.
export function saveAttachment(name: string, mime: string, bytes: Uint8Array): ChatFile {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`${name} is too big to attach (the limit is 30 MB).`)
  }
  if (LEGACY_OFFICE.test(name)) {
    throw new Error(`${name} is an older Office format. Save it as .${ext(name)}x and attach that.`)
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const office = OFFICE_EXT[ext(name)]
  let file: ChatFile
  let text: string | null = null

  if (IMAGE_TYPES[mime]) {
    file = { hash, name, mime, bytes: bytes.length, kind: 'image' }
  } else if (mime === 'application/pdf' || ext(name) === 'pdf') {
    file = {
      hash,
      name,
      mime: 'application/pdf',
      bytes: bytes.length,
      kind: 'pdf',
      pages: pdfPages(bytes)
    }
  } else if (office) {
    try {
      text = officeText(office, bytes)
    } catch {
      throw new Error(`${name} couldn't be opened. Is it a real ${office} file?`)
    }
    if (!text) throw new Error(`There's no text in ${name} to read.`)
    file = { hash, name, mime, bytes: bytes.length, kind: 'text', chars: text.length }
  } else if (mime.startsWith('text/') || TEXT_EXT.test(name) || looksLikeText(bytes)) {
    text = new TextDecoder('utf-8').decode(bytes)
    file = {
      hash,
      name,
      mime: mime || 'text/plain',
      bytes: bytes.length,
      kind: 'text',
      chars: text.length
    }
  } else {
    throw new Error(
      `${name} isn't something a chat can read. Images, PDFs, text and Office files work.`
    )
  }
  if (text !== null && text.length > MAX_TEXT_CHARS) {
    throw new Error(`${name} is too long to read in a chat. Try attaching a part of it.`)
  }

  mkdirSync(dir(), { recursive: true })
  // Written once; attaching the same file again only marks it fresh, so the
  // sweep below never takes a file that's about to be sent.
  const keep = (path: string, data: Uint8Array | string): void => {
    if (existsSync(path)) utimesSync(path, new Date(), new Date())
    else writeFileSync(path, data)
  }
  keep(join(dir(), blobName(file)), bytes)
  if (office) keep(join(dir(), `${hash}.txt`), text!)
  return file
}

export function hasAttachment(file: ChatFile): boolean {
  return /^[0-9a-f]{64}$/.test(file.hash) && existsSync(join(dir(), blobName(file)))
}

// What a model is sent for a file: base64 for images and PDFs, text otherwise.
export function readAttachment(file: ChatFile): { base64: string } | { text: string } {
  if (file.kind === 'text') return { text: readFileSync(join(dir(), `${file.hash}.txt`), 'utf8') }
  return { base64: readFileSync(join(dir(), blobName(file))).toString('base64') }
}

// Deletes stored files no message refers to any more (their chats were
// deleted, or they were attached and never sent) once they're a day old, so
// nothing being attached right now is touched. `everything` clears it all.
export function sweepAttachments(keep: Set<string>, everything = false): void {
  let names: string[]
  try {
    names = readdirSync(dir())
  } catch {
    return
  }
  const cutoff = Date.now() - 86_400_000
  for (const name of names) {
    const path = join(dir(), name)
    try {
      if (everything || (!keep.has(name.slice(0, 64)) && statSync(path).mtimeMs < cutoff)) {
        rmSync(path, { force: true })
      }
    } catch {
      // in use or already gone
    }
  }
}

// Attached images, for the window to show as orcha-file://f/<hash>.<ext>.
// Only stored images are served; any other path is a 404.
export function serveAttachments(): void {
  protocol.handle('orcha-file', (request) => {
    const name = new URL(request.url).pathname.slice(1)
    const m = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/.exec(name)
    const path = m && join(dir(), name)
    if (!m || !path || !existsSync(path)) return new Response(null, { status: 404 })
    const mime = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === m[2])!
    return new Response(readFileSync(path), { headers: { 'content-type': mime } })
  })
}
