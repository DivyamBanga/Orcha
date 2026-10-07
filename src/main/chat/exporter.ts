import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalog } from '../catalog'
import { pathTo } from '../../shared/chatTree'
import { artifactsAsCode } from '../../shared/artifacts'
import { chats, messages } from './store'

// Chats as Markdown files: the branch on screen, top to bottom, with who said
// each part and the names of any attached files. Artifacts become titled code
// blocks, and web citations become footnotes.

function chatMarkdown(chatId: string): { title: string; text: string } | null {
  const chat = chats.get(chatId)
  if (!chat) return null
  const label = (id: string | null): string =>
    catalog().models.find((m) => m.id === id)?.label ?? id ?? 'Assistant'
  const title = chat.title ?? 'New chat'
  const lines = [`# ${title}`, '', `_${new Date(chat.createdAt).toLocaleString('en-US')}_`, '']
  const notes: string[] = []
  for (const m of pathTo(messages.all(chatId), chat.leafId)) {
    lines.push(m.role === 'user' ? '## You' : `## ${label(m.model)}`, '')
    if (m.files.length) lines.push(`_Attached: ${m.files.map((f) => f.name).join(', ')}_`, '')
    let text = m.role === 'assistant' ? artifactsAsCode(m.text) : m.text
    // " [2](<url> "cite")" → "[^7]", with the source listed at the end.
    const numbered = new Map<string, number>()
    text = text.replace(/ ?\[(\d+)\]\(<([^>]*)> "cite"\)/g, (_, n: string, url: string) => {
      if (!numbered.has(n)) {
        const source = m.parts?.sources?.[Number(n) - 1]
        notes.push(`[^${notes.length + 1}]: [${source?.title ?? url}](${url})`)
        numbered.set(n, notes.length)
      }
      return `[^${numbered.get(n)}]`
    })
    if (text.trim()) lines.push(text.trim(), '')
  }
  if (notes.length) lines.push('---', '', ...notes, '')
  return { title, text: lines.join('\n') }
}

// A title as a file name: no characters Windows or macOS refuse, not too long.
export function fileName(title: string): string {
  const safe = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (safe || 'Chat').slice(0, 80)
}

export function exportChat(chatId: string, path: string): void {
  const md = chatMarkdown(chatId)
  if (!md) throw new Error('That chat no longer exists.')
  writeFileSync(path, md.text)
}

// Every chat into a folder, one file each; returns how many were written.
export function exportAllChats(folder: string): number {
  const used = new Set<string>()
  let count = 0
  for (const chat of chats.list()) {
    const md = chatMarkdown(chat.id)
    if (!md) continue
    let name = fileName(md.title)
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${fileName(md.title)} (${n})`
    used.add(name.toLowerCase())
    writeFileSync(join(folder, `${name}.md`), md.text)
    count++
  }
  return count
}
