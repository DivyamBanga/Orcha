import { IPC } from '../../shared/ipc'
import { attributionHeaders, isGuest, relayConfig } from '../guest'
import { catalog } from '../catalog'
import * as db from '../db'
import { chats, messages, searchMessages } from './store'
import { buildSystemPrompt } from './prompt'
import { chatSettings } from './settings'
import { memories, MEMORY_TOOL, memoryPrompt } from './memory'
import { knowledge, projectPrompt } from './projects'
import { anthropicAdapter } from './anthropic'
import { responsesAdapter } from './responses'
import {
  hasAttachment,
  MAX_FILE_BYTES,
  readAttachment,
  saveAttachment,
  sweepAttachments
} from './attachments'
import {
  estimateCost,
  TurnAborted,
  type ChatAdapter,
  type StreamEvent,
  type ToolRunner,
  type TurnResult
} from './adapter'
import type {
  CatalogModel,
  ChatDetail,
  ChatFile,
  ChatMessage,
  ChatRetryInput,
  ChatSendInput,
  ChatStreamEvent,
  ChatSummary,
  ChatTool,
  Memory
} from '../../shared/types'

type SendFn = (channel: string, payload: unknown) => void

// How often streamed text is pushed to the window: often enough to read as
// live, rare enough not to flood IPC with a message per token.
const FLUSH_MS = 30
const MAX_FILES = 20

// Orcha's chat: one turn at a time per chat, streamed to the window and saved
// as it finishes. Providers sit behind ChatAdapter (anthropic.ts,
// responses.ts); this decides which one a chat uses and keeps the record.
export class ChatService {
  private running = new Map<string, AbortController>()

  constructor(private push: SendFn) {
    // Files left behind by deleted chats, once startup has settled.
    setTimeout(
      () => sweepAttachments(new Set([...messages.fileHashes(), ...knowledge.hashes()])),
      30_000
    ).unref()
  }

  list(): ChatSummary[] {
    return chats.list()
  }

  detail(chatId: string): ChatDetail | null {
    return chats.detail(chatId)
  }

  search(query: string): ReturnType<typeof searchMessages> {
    return searchMessages(query)
  }

  rename(chatId: string, title: string): void {
    chats.update(chatId, { title: title.trim().slice(0, 120) })
    this.changed()
  }

  star(chatId: string, starred: boolean): void {
    chats.update(chatId, { starred })
    this.changed()
  }

  remove(chatId: string): void {
    this.stop(chatId)
    chats.remove(chatId)
    this.changed()
  }

  // Settings → Memory, and Undo on a "Remembered" row.
  memories(): Memory[] {
    return memories.list(null, true)
  }

  updateMemory(id: number, text: string): void {
    if (text.trim()) memories.update(id, text.trim().slice(0, 500))
  }

  removeMemory(id: number): void {
    memories.remove(id)
  }

  clearMemories(): void {
    memories.clear()
  }

  // Settings → Data → Delete all chats: every chat and every attached file.
  removeAll(): void {
    for (const controller of this.running.values()) controller.abort()
    chats.removeAll()
    sweepAttachments(new Set(knowledge.hashes()), true)
    this.changed()
  }

  // Which branch is on screen (after switching with ‹2/3›).
  setLeaf(chatId: string, leafId: number): void {
    chats.update(chatId, { leafId })
  }

  stop(chatId: string): void {
    this.running.get(chatId)?.abort()
  }

  // Saves the new message and starts the reply; returns at once with the ids,
  // and the reply streams in as ev:chat events.
  send(input: ChatSendInput): { chatId: string; userId: number; assistantId: number } {
    const model = this.chatModel(input.model)
    const files = input.files ?? []
    this.checkFiles(files, model)
    let chatId = input.chatId
    if (chatId) {
      this.continuing(chatId, model)
    } else {
      chatId = chats.create({
        projectId: input.projectId ?? null,
        provider: model.provider,
        model: model.id
      })
    }
    const userId = messages.insert({
      chatId,
      parentId: input.parentId,
      role: 'user',
      text: input.text,
      files
    })
    return this.start(chatId, userId, model, input)
  }

  // Answers a message again; the new reply sits beside the old one (‹2/2›).
  retry(input: ChatRetryInput): { chatId: string; userId: number; assistantId: number } {
    const model = this.chatModel(input.model)
    this.continuing(input.chatId, model)
    const user = messages.all(input.chatId).find((m) => m.id === input.userId)
    if (user?.role !== 'user') throw new Error('That message no longer exists.')
    this.checkFiles(user.files, model)
    return this.start(input.chatId, user.id, model, { ...input, text: user.text })
  }

  // Stores a file for the next message (see attachments.ts).
  attach(name: string, mime: string, data: Uint8Array): ChatFile {
    return saveAttachment(name, mime, data)
  }

  // A message's files must still be stored, and the model must read them.
  private checkFiles(files: ChatFile[], model: CatalogModel): void {
    if (files.length > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} files at a time.`)
    if (files.reduce((n, f) => n + f.bytes, 0) > MAX_FILE_BYTES) {
      throw new Error('Those files add up to more than 30 MB; attach fewer at once.')
    }
    for (const f of files) {
      if (!hasAttachment(f)) throw new Error(`${f.name} is no longer here; attach it again.`)
      if (f.kind === 'image' && !model.vision) {
        throw new Error(`${model.label} can't see images. Pick another model for this one.`)
      }
      if (f.kind === 'pdf' && !model.pdfPages) {
        throw new Error(`${model.label} can't read PDFs. Pick another model for this one.`)
      }
      if (f.kind === 'pdf' && model.pdfPages && (f.pages ?? 0) > model.pdfPages) {
        throw new Error(
          `${f.name} has ${f.pages} pages; ${model.label} reads up to ${model.pdfPages}.`
        )
      }
    }
  }

  private chatModel(id: string): CatalogModel {
    const model = catalog().models.find((m) => m.id === id && m.chat)
    if (!model) throw new Error('That model is not available.')
    this.relayFor(model)
    return model
  }

  // Checks an existing chat can take another turn on this model.
  private continuing(chatId: string, model: CatalogModel): void {
    const chat = chats.get(chatId)
    if (!chat) throw new Error('That chat no longer exists.')
    if (this.running.has(chatId)) throw new Error('Wait for the reply to finish first.')
    // Claude and GPT can't continue each other's conversations; switching
    // across starts a new chat (the UI offers that), within is fine.
    if (chat.provider !== model.provider) {
      throw new Error('Start a new chat to switch between Claude and GPT models.')
    }
    if (chat.model !== model.id) chats.update(chatId, { model: model.id })
  }

  // Adds the empty reply under `userId` and starts writing it.
  private start(
    chatId: string,
    userId: number,
    model: CatalogModel,
    input: { text: string; thinking?: boolean; webSearch?: boolean }
  ): { chatId: string; userId: number; assistantId: number } {
    const assistantId = messages.insert({
      chatId,
      parentId: userId,
      role: 'assistant',
      text: '',
      model: model.id,
      status: 'streaming'
    })
    chats.update(chatId, { leafId: assistantId })
    chats.touch(chatId)
    this.changed()

    void this.reply(chatId, userId, assistantId, model, this.adapterFor(model, chatId), input)
    return { chatId, userId, assistantId }
  }

  private async reply(
    chatId: string,
    userId: number,
    assistantId: number,
    model: CatalogModel,
    adapter: ChatAdapter,
    input: { text: string; thinking?: boolean; webSearch?: boolean }
  ): Promise<void> {
    const abort = new AbortController()
    this.running.set(chatId, abort)

    // Built once, when the chat starts, and kept (see prompt.ts): your
    // profile, and what it remembers (yours, and this project's).
    const chat = chats.get(chatId)!
    const settings = chatSettings()
    let system = chat.systemPrompt
    if (!system) {
      const project = chat.projectId ? db.projects.get(chat.projectId) : undefined
      system = buildSystemPrompt({
        now: new Date(),
        profile: settings,
        project: project ? projectPrompt(project) : null,
        memory: settings.memory ? memoryPrompt(memories.list(chat.projectId)) : null
      })
      chats.update(chatId, { systemPrompt: system })
    }
    const history = messages
      .path(chatId, userId)
      .filter((m) => m.role === 'user' || (m.status !== 'error' && m.text.trim()))
      .map((m) => ({ role: m.role, text: m.text, files: m.files }))

    // Deltas are gathered and pushed in small batches.
    const pending: { kind: 'text' | 'thinking'; delta: string }[] = []
    const flush = (): void => {
      for (const kind of ['thinking', 'text'] as const) {
        const delta = pending
          .filter((p) => p.kind === kind)
          .map((p) => p.delta)
          .join('')
        if (delta) this.emit({ chatId, messageId: assistantId, kind, delta })
      }
      pending.length = 0
    }
    const timer = setInterval(flush, FLUSH_MS)
    const tools: ChatTool[] = []
    const onEvent = (event: StreamEvent): void => {
      if (event.kind === 'tool') {
        tools.push(event.tool)
        flush()
        this.emit({ chatId, messageId: assistantId, kind: 'tool', tool: event.tool })
      } else {
        pending.push(event)
      }
    }
    // The memory tool: saves to this chat's project, or to your general
    // memory, and shows in the reply (with Undo on a save).
    const runTool: ToolRunner = ({ name, input }) => {
      const call = (input ?? {}) as { action?: string; text?: string; id?: number }
      if (name !== MEMORY_TOOL.name) return `There's no tool called ${name}.`
      if (call.action === 'remember' && call.text?.trim()) {
        const text = call.text.trim().slice(0, 500)
        const memoryId = memories.add(chat.projectId, text, chatId)
        onEvent({ kind: 'tool', tool: { kind: 'memory', label: text, memoryId } })
        return `Saved as memory ${memoryId}.`
      }
      if (call.action === 'forget' && typeof call.id === 'number') {
        const memory = memories.get(call.id)
        if (!memory) return `There's no memory ${call.id}.`
        memories.remove(call.id)
        onEvent({ kind: 'tool', tool: { kind: 'memory', label: `Forgot: ${memory.text}` } })
        return `Memory ${call.id} removed.`
      }
      return 'Nothing changed. Use action "remember" with text, or "forget" with an id.'
    }

    let result: TurnResult | null = null
    let status: ChatMessage['status'] = 'done'
    let error: string | null = null
    try {
      result = await adapter.run(
        {
          model,
          system,
          history,
          thinking: input.thinking ?? false,
          webSearch: input.webSearch ?? false,
          tools: settings.memory ? [MEMORY_TOOL] : []
        },
        onEvent,
        abort.signal,
        settings.memory ? runTool : undefined
      )
    } catch (err) {
      if (err instanceof TurnAborted) {
        result = err.partial
        status = 'aborted'
      } else {
        status = 'error'
        error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      clearInterval(timer)
      flush()
      this.running.delete(chatId)
    }

    const parts = { ...(result?.parts ?? {}), ...(tools.length ? { tools } : {}) }
    if (error) parts.error = error
    messages.finish(assistantId, {
      text: result?.text ?? '',
      parts: Object.keys(parts).length ? parts : null,
      status,
      usage: result?.usage ?? null,
      costUsd: estimateCost(model, result?.usage ?? null),
      model: result?.model
    })
    chats.touch(chatId)
    const message = messages.get(assistantId)
    if (message) this.emit({ chatId, messageId: assistantId, kind: 'done', message })
    this.changed()

    // A first reply that was stopped or failed still names the chat, from its
    // opening words rather than another model call.
    if (!chats.get(chatId)?.title) {
      this.nameChat(chatId, input.text, status === 'done' ? model : null).catch(() => {})
    }
  }

  // A short title from the first message, by the cheap model on the same
  // provider; the opening words if that fails (or with no model given).
  private async nameChat(
    chatId: string,
    firstMessage: string,
    chatModel: CatalogModel | null
  ): Promise<void> {
    let title = ''
    const titleModel =
      chatModel && catalog().models.find((m) => m.title && m.provider === chatModel.provider)
    if (titleModel) {
      try {
        title = await this.adapterFor(titleModel, chatId).complete(
          titleModel.id,
          'You name chats. Reply with a title of 2 to 6 words for a chat that starts with the message below: no quotes, no punctuation at the end.',
          firstMessage.slice(0, 2000)
        )
      } catch {
        title = ''
      }
    }
    // One plain line, whatever came back.
    title = (title.split('\n').find((line) => line.trim()) ?? '')
      .replace(/^[#>*_\s-]+|[*_]+$/g, '')
      .replace(/^["'“]+|["'”.]+$/g, '')
      .trim()
    if (!title) title = firstMessage.trim().split(/\s+/).slice(0, 6).join(' ')
    chats.update(chatId, { title: title.slice(0, 80) })
    this.changed()
  }

  // Every chat bills through a relay: a guest's host's, or the host's own
  // (whose Claude never goes through it — that runs on their plan, and
  // arrives with the next release).
  private relayFor(model: CatalogModel): { relay: string; token: string } {
    const relay = relayConfig()
    if (!relay) throw new Error('Chat needs an invite, or your own relay set up.')
    if (model.provider === 'anthropic' && !isGuest()) {
      throw new Error('Claude in chat on your own plan is coming next; pick a GPT model for now.')
    }
    return relay
  }

  // Spend is attributed to the chat (and its project) on the relay.
  private adapterFor(model: CatalogModel, chatId: string): ChatAdapter {
    const relay = this.relayFor(model)
    const chat = chats.get(chatId)
    const project = chat?.projectId ? db.projects.get(chat.projectId)?.name : null
    const headers = attributionHeaders(project ?? 'Chat', `chat:${chatId}`)
    return model.provider === 'anthropic'
      ? anthropicAdapter(relay, headers, readAttachment)
      : responsesAdapter(relay, headers, readAttachment)
  }

  private emit(event: ChatStreamEvent): void {
    this.push(IPC.EvChat, event)
  }

  private changed(): void {
    this.push(IPC.EvChatsChanged, {})
  }
}
