import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalog } from '../catalog'
import { pathTo } from '../../shared/chatTree'
import { chats, messages } from './store'

// Chats as Markdown files: the branch on screen, top to bottom, with who said
// each part and the names of any attached files.

function chatMarkdown(chatId: string): { title: string; text: string } | null {
  const chat = chats.get(chatId)
  if (!chat) return null
  const label = (id: string | null): string =>
    catalog().models.find((m) => m.id === id)?.label ?? id ?? 'Assistant'
  const title = chat.title ?? 'New chat'
  const lines = [`# ${title}`, '', `_${new Date(chat.createdAt).toLocaleString('en-US')}_`, '']
  for (const m of pathTo(messages.all(chatId), chat.leafId)) {
    lines.push(m.role === 'user' ? '## You' : `## ${label(m.model)}`, '')
    if (m.files.length) lines.push(`_Attached: ${m.files.map((f) => f.name).join(', ')}_`, '')
    if (m.text.trim()) lines.push(m.text.trim(), '')
  }
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
