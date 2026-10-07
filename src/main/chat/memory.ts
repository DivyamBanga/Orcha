import { database } from '../db'
import type { Memory } from '../../shared/types'

// What chats remember about you. A chat in a project saves to that project's
// memory; any other chat saves to your general memory. A chat starts knowing
// the general memories plus its project's (see prompt.ts), and the models
// save and remove them with the memory tool below.

interface MemoryRow {
  id: number
  project_id: string | null
  text: string
  chat_id: string | null
  created_at: number
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  projectId: r.project_id,
  text: r.text,
  createdAt: r.created_at
})

export const memories = {
  // General memories, plus one project's when given; oldest first.
  list(projectId: string | null = null, all = false): Memory[] {
    const rows = all
      ? database().prepare('SELECT * FROM memories ORDER BY id').all()
      : database()
          .prepare('SELECT * FROM memories WHERE project_id IS NULL OR project_id = ? ORDER BY id')
          .all(projectId)
    return (rows as MemoryRow[]).map(toMemory)
  },

  get(id: number): Memory | null {
    const row = database().prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      MemoryRow | undefined
    return row ? toMemory(row) : null
  },

  add(projectId: string | null, text: string, chatId: string | null): number {
    const info = database()
      .prepare('INSERT INTO memories (project_id, text, chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId, text, chatId, Date.now())
    return Number(info.lastInsertRowid)
  },

  update(id: number, text: string): void {
    database().prepare('UPDATE memories SET text = ? WHERE id = ?').run(text, id)
  },

  remove(id: number): void {
    database().prepare('DELETE FROM memories WHERE id = ?').run(id)
  },

  clear(): void {
    database().prepare('DELETE FROM memories').run()
  }
}

// The tool both providers are offered (Anthropic's input_schema and the
// Responses function's parameters take the same JSON Schema).
export const MEMORY_TOOL = {
  name: 'memory',
  description:
    "Save something lasting about the person you're chatting with, so you know it in their future chats, or remove something saved. Save what would genuinely help later: their work and projects, preferences, how they like answers. Don't save one-off details, things already saved, or anything sensitive (health, money, passwords) unless they ask. When they ask you to forget something, remove it.",
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget'] },
      text: { type: 'string', description: 'For remember: one short sentence.' },
      id: { type: 'integer', description: 'For forget: the number of the memory.' }
    },
    required: ['action']
  }
}

// How the saved memories read in a system prompt.
export function memoryPrompt(list: Memory[]): string {
  const saved = list.length
    ? `What you remember about them from earlier chats:\n${list.map((m) => `- [${m.id}] ${m.text}`).join('\n')}`
    : "You don't remember anything about them yet."
  return `You can remember things about them across chats with the memory tool.\n\n${saved}`
}
