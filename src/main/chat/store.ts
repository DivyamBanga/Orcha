import { randomUUID } from 'crypto'
import { database } from '../db'
import { pathTo } from '../../shared/chatTree'
import type {
  ChatDetail,
  ChatFile,
  ChatMessage,
  ChatParts,
  ChatSummary
} from '../../shared/types'

// Chats and their messages (schema in db.ts).

interface ChatRow {
  id: string
  project_id: string | null
  title: string | null
  provider: string
  model: string
  system_prompt: string | null
  leaf_id: number | null
  starred: number
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: number
  chat_id: string
  parent_id: number | null
  role: string
  text: string
  files: string | null
  parts: string | null
  model: string | null
  status: string
  cost_usd: number | null
  created_at: number
}

export type StoredChat = ChatSummary & { leafId: number | null; systemPrompt: string | null }

function toChat(r: ChatRow): StoredChat {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    provider: r.provider === 'azure' ? 'azure' : 'anthropic',
    model: r.model,
    starred: r.starred === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    leafId: r.leaf_id,
    systemPrompt: r.system_prompt
  }
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    parentId: r.parent_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    text: r.text,
    files: parse<ChatFile[]>(r.files, []),
    parts: parse<ChatParts | null>(r.parts, null),
    model: r.model,
    status: (['streaming', 'done', 'aborted', 'error'] as const).find((s) => s === r.status) ?? 'done',
    costUsd: r.cost_usd,
    createdAt: r.created_at
  }
}

export const chats = {
  list(): ChatSummary[] {
    return (
      database().prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as ChatRow[]
    ).map((r) => {
      const { leafId: _leaf, systemPrompt: _system, ...summary } = toChat(r)
      return summary
    })
  },

  get(id: string): StoredChat | null {
    const row = database().prepare('SELECT * FROM chats WHERE id = ?').get(id) as
      | ChatRow
      | undefined
    return row ? toChat(row) : null
  },

  create(opts: { projectId: string | null; provider: string; model: string }): string {
    const id = randomUUID()
    const now = Date.now()
    database()
      .prepare(
        `INSERT INTO chats (id, project_id, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, opts.projectId, opts.provider, opts.model, now, now)
    return id
  },

  update(
    id: string,
    fields: Partial<{
      title: string
      model: string
      systemPrompt: string
      leafId: number
      starred: boolean
    }>
  ): void {
    const columns: Record<string, string> = {
      title: 'title',
      model: 'model',
      systemPrompt: 'system_prompt',
      leafId: 'leaf_id',
      starred: 'starred'
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      database()
        .prepare(`UPDATE chats SET ${columns[key]} = ? WHERE id = ?`)
        .run(typeof value === 'boolean' ? Number(value) : value, id)
    }
  },

  touch(id: string): void {
    database().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  },

  remove(id: string): void {
    database().prepare('DELETE FROM chats WHERE id = ?').run(id)
  },

  detail(id: string): ChatDetail | null {
    const chat = chats.get(id)
    if (!chat) return null
    const { systemPrompt: _system, ...rest } = chat
    return { chat: rest, messages: messages.all(id) }
  }
}

export const messages = {
  all(chatId: string): ChatMessage[] {
    return (
      database()
        .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id')
        .all(chatId) as MessageRow[]
    ).map(toMessage)
  },

  get(id: number): ChatMessage | null {
    const row = database().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? toMessage(row) : null
  },

  // The conversation from the first message down to `leafId`.
  path(chatId: string, leafId: number): ChatMessage[] {
    return pathTo(messages.all(chatId), leafId)
  },

  insert(opts: {
    chatId: string
    parentId: number | null
    role: 'user' | 'assistant'
    text: string
    files?: ChatFile[]
    model?: string | null
    status?: ChatMessage['status']
  }): number {
    const info = database()
      .prepare(
        `INSERT INTO messages (chat_id, parent_id, role, text, files, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.chatId,
        opts.parentId,
        opts.role,
        opts.text,
        opts.files?.length ? JSON.stringify(opts.files) : null,
        opts.model ?? null,
        opts.status ?? 'done',
        Date.now()
      )
    return Number(info.lastInsertRowid)
  },

  finish(
    id: number,
    result: {
      text: string
      parts: ChatParts | null
      status: ChatMessage['status']
      usage: unknown
      costUsd: number | null
      model?: string | null
    }
  ): void {
    database()
      .prepare(
        `UPDATE messages SET text = ?, parts = ?, status = ?, usage = ?, cost_usd = ?,
           model = COALESCE(?, model) WHERE id = ?`
      )
      .run(
        result.text,
        result.parts ? JSON.stringify(result.parts) : null,
        result.status,
        result.usage ? JSON.stringify(result.usage) : null,
        result.costUsd,
        result.model ?? null,
        id
      )
  }
}

// Message text search for ⌘K: every word must appear (each as a prefix), best
// matches first, with a snippet around the hit.
export function searchMessages(
  query: string
): { chatId: string; messageId: number; snippet: string }[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
  if (terms.length === 0) return []
  const match = terms.map((t) => `"${t}"*`).join(' AND ')
  return (
    database()
      .prepare(
        `SELECT m.id AS messageId, m.chat_id AS chatId,
                snippet(messages_fts, 0, '[', ']', '…', 14) AS snippet
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ? ORDER BY rank LIMIT 40`
      )
      .all(match) as { chatId: string; messageId: number; snippet: string }[]
  )
}
