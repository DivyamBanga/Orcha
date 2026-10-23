import { create } from 'zustand'
import { useStore } from './store'
import { deepestLatest } from '../../shared/chatTree'
import { prepare } from './attach'
import type { ChatModel, Route } from '../../shared/ai'
import type {
  ChatDetail,
  ChatFile,
  ChatMessage,
  ChatStreamEvent,
  ChatSummary,
  ChatTool
} from '../../shared/types'

// Chats on screen. Routes are 'chat:<id>' for a chat and 'chat:new' for the
// new-chat screen, sharing activeId with sessions so the sidebar highlight
// and tab restore work the same for both.

export const NEW_CHAT = 'chat:new'
export const chatRoute = (chatId: string): string => `chat:${chatId}`
export const chatIdOf = (route: string | null): string | null =>
  route?.startsWith('chat:') && route !== NEW_CHAT ? route.slice(5) : null

// A reply being written: what has streamed in so far.
export interface LiveReply {
  text: string
  thinking: string
  tools: ChatTool[]
}

interface ChatStore {
  chats: ChatSummary[]
  details: Record<string, ChatDetail>
  live: Record<number, LiveReply>
  // Which chats have a reply in flight (chat id → message id).
  running: Record<string, number>
  // Unsent text per route, so switching away keeps it.
  drafts: Record<string, string>
  // Models picked in the composer per route (NEW_CHAT: what new chats start
  // on), and the composer's toggles.
  picked: Record<string, string>
  thinking: boolean
  webSearch: boolean
  // A message to scroll to and flash once (from search).
  focusMessage: { chatId: string; messageId: number } | null
  // A chat whose title should open for editing (Rename from the sidebar).
  renaming: string | null
  // Files waiting to go with the next message, per route.
  attachments: Record<string, PendingFile[]>
  // The project a new chat is being started in (null: none).
  newChatProject: string | null
  // The artifact open beside each chat, and which version (null: the latest).
  panel: Record<string, { identifier: string; version: number | null } | null>
}

// A file on its way into the composer: a preview straight away, the stored
// file once it's saved.
export interface PendingFile {
  id: string
  name: string
  image: boolean
  preview: string | null // object URL, images only
  file: ChatFile | null
}

export const useChatStore = create<ChatStore>(() => ({
  chats: [],
  details: {},
  live: {},
  running: {},
  drafts: {},
  picked: {},
  thinking: false,
  webSearch: false,
  focusMessage: null,
  renaming: null,
  attachments: {},
  newChatProject: null,
  panel: {}
}))

export function openArtifact(chatId: string, identifier: string, version: number | null): void {
  useChatStore.setState((s) => ({ panel: { ...s.panel, [chatId]: { identifier, version } } }))
}

export function closeArtifact(chatId: string): void {
  useChatStore.setState((s) => ({ panel: { ...s.panel, [chatId]: null } }))
}

// Opens the new-chat screen, in a project or not.
export function startChat(projectId: string | null = null): void {
  useChatStore.setState({ newChatProject: projectId })
  useStore.getState().setActive(NEW_CHAT)
}

export const projectRoute = (projectId: string): string => `project:${projectId}`

const updateFiles = (route: string, fn: (files: PendingFile[]) => PendingFile[]): void =>
  useChatStore.setState((s) => ({
    attachments: { ...s.attachments, [route]: fn(s.attachments[route] ?? []) }
  }))

// Adds files to the next message. Each shows at once and is stored in the
// background; one that can't be read is dropped with a notice saying why.
export function addFiles(route: string, files: File[]): void {
  for (const f of files) {
    const id = crypto.randomUUID()
    const image = f.type.startsWith('image/') && f.type !== 'image/svg+xml'
    const preview = image ? URL.createObjectURL(f) : null
    updateFiles(route, (list) => [...list, { id, name: f.name, image, preview, file: null }])
    prepare(f)
      .then(({ name, mime, data }) => window.orcha.chat.attach(name, mime, data))
      .then((file) =>
        updateFiles(route, (list) => list.map((p) => (p.id === id ? { ...p, file } : p)))
      )
      .catch((err) => {
        removeFile(route, id)
        failed(err)
      })
  }
}

export function removeFile(route: string, id: string): void {
  const gone = useChatStore.getState().attachments[route]?.find((p) => p.id === id)
  if (gone?.preview) URL.revokeObjectURL(gone.preview)
  updateFiles(route, (list) => list.filter((p) => p.id !== id))
}

function clearFiles(route: string): void {
  for (const p of useChatStore.getState().attachments[route] ?? []) {
    if (p.preview) URL.revokeObjectURL(p.preview)
  }
  updateFiles(route, () => [])
}

// The picker's sections, in order: where each model runs and who pays.
export const ROUTES: { route: Route; label: string }[] = [
  { route: 'plan', label: 'Claude · Max plan' },
  { route: 'api', label: 'Claude · API key' },
  { route: 'azure', label: 'Azure' },
  { route: 'ollama', label: 'On this computer' }
]

// What a new chat starts on unless you pick another: Opus 5.5 on the Max plan.
const DEFAULT_MODEL = 'plan:claude-opus-5-5'

// Where a new chat starts: the last model picked (one saved before 1.0 named
// a Max-plan model without its route), else the default, else the first
// model that's ready.
export function defaultModel(
  models: ChatModel[],
  picked: string | undefined = useChatStore.getState().picked[NEW_CHAT]
): string | null {
  for (const id of picked ? [picked, `plan:${picked}`] : []) {
    if (models.some((m) => m.id === id)) return id
  }
  return (
    models.find((m) => m.id === DEFAULT_MODEL)?.id ??
    models.find((m) => m.ready && m.current)?.id ??
    models[0]?.id ??
    null
  )
}

export async function loadChats(): Promise<void> {
  const chats = await window.orcha.chat.list()
  useChatStore.setState({ chats })
}

export async function loadChat(chatId: string): Promise<ChatDetail | null> {
  const detail = await window.orcha.chat.get(chatId)
  useChatStore.setState((s) => {
    const details = { ...s.details }
    if (detail) details[chatId] = detail
    else delete details[chatId]
    return { details }
  })
  return detail
}

export function setDraft(route: string, text: string): void {
  useChatStore.setState((s) => ({ drafts: { ...s.drafts, [route]: text } }))
}

// Picks the model for the next message. Any model can carry on any chat.
export function pickModel(route: string, model: ChatModel): void {
  useChatStore.setState((s) => ({ picked: { ...s.picked, [route]: model.id } }))
}

const errorText = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

function failed(err: unknown): void {
  useStore.getState().pushNotice({ id: 'chat', tone: 'warn', text: errorText(err) })
}

function started(chatId: string, assistantId: number): void {
  useChatStore.setState((s) => ({
    running: { ...s.running, [chatId]: assistantId },
    live: { ...s.live, [assistantId]: { text: '', thinking: '', tools: [] } }
  }))
}

// Sends a message. `files` defaults to what's attached in the composer for
// this chat (and those are cleared once sent); an edit passes its own. A new
// chat (chatId null) opens once it exists.
export async function sendMessage(
  chatId: string | null,
  parentId: number | null,
  text: string,
  model: string,
  files?: ChatFile[]
): Promise<void> {
  const { thinking, webSearch, attachments, newChatProject } = useChatStore.getState()
  const route = chatId ? chatRoute(chatId) : NEW_CHAT
  const attached = files ?? (attachments[route] ?? []).flatMap((p) => (p.file ? [p.file] : []))
  try {
    const sent = await window.orcha.chat.send({
      chatId,
      projectId: chatId ? undefined : newChatProject,
      parentId,
      text,
      files: attached,
      model,
      thinking,
      webSearch
    })
    if (!files) clearFiles(route)
    started(sent.chatId, sent.assistantId)
    await loadChat(sent.chatId)
    if (!chatId) {
      useChatStore.setState((s) => ({
        picked: { ...s.picked, [NEW_CHAT]: model },
        drafts: { ...s.drafts, [NEW_CHAT]: '' },
        newChatProject: null
      }))
      useStore.getState().setActive(chatRoute(sent.chatId))
    }
  } catch (err) {
    failed(err)
    throw err
  }
}

// Asks for a reply to `userId` again, as a new branch.
export async function retryReply(chatId: string, userId: number, model: string): Promise<void> {
  const { thinking, webSearch } = useChatStore.getState()
  try {
    const sent = await window.orcha.chat.retry({ chatId, userId, model, thinking, webSearch })
    started(chatId, sent.assistantId)
    await loadChat(chatId)
  } catch (err) {
    failed(err)
  }
}

// Shows another branch: the newest conversation under `messageId`.
export function showBranch(chatId: string, messageId: number): void {
  const detail = useChatStore.getState().details[chatId]
  if (!detail) return
  const leafId = deepestLatest(detail.messages, messageId)
  useChatStore.setState((s) => ({
    details: { ...s.details, [chatId]: { ...detail, chat: { ...detail.chat, leafId } } }
  }))
  window.orcha.chat.setLeaf(chatId, leafId).catch(() => {})
}

export async function deleteChat(chatId: string): Promise<void> {
  await window.orcha.chat.remove(chatId)
  useChatStore.setState((s) => {
    const details = { ...s.details }
    delete details[chatId]
    return { details, chats: s.chats.filter((c) => c.id !== chatId) }
  })
  const store = useStore.getState()
  if (store.activeId === chatRoute(chatId)) store.setActive(NEW_CHAT)
}

// ---- streamed replies ---------------------------------------------------------

// Main sends a batch every ~30ms per reply; several replies at once, or a busy
// frame, would still mean several renders a frame, so events are applied
// together on the next animation frame.
let queued: ChatStreamEvent[] = []
let frame = 0

export function onChatEvent(event: ChatStreamEvent): void {
  queued.push(event)
  if (!frame) frame = requestAnimationFrame(flush)
}

function flush(): void {
  frame = 0
  const events = queued
  queued = []
  const finished: string[] = []
  useChatStore.setState((s) => {
    const live = { ...s.live }
    const running = { ...s.running }
    const details = { ...s.details }
    for (const e of events) {
      if (e.kind === 'done') {
        delete live[e.messageId]
        if (running[e.chatId] === e.messageId) delete running[e.chatId]
        const detail = details[e.chatId]
        if (detail) details[e.chatId] = withMessage(detail, e.message)
        finished.push(e.chatId)
        continue
      }
      running[e.chatId] = e.messageId
      const reply = live[e.messageId] ?? { text: '', thinking: '', tools: [] }
      live[e.messageId] =
        e.kind === 'tool'
          ? { ...reply, tools: [...reply.tools, e.tool] }
          : { ...reply, [e.kind]: reply[e.kind] + e.delta }
    }
    return { live, running, details }
  })
  // A reply that lands while you're elsewhere marks its chat unread.
  const store = useStore.getState()
  const unread = finished.filter((id) => store.activeId !== chatRoute(id))
  if (unread.length) {
    useStore.setState((s) => ({
      unread: { ...s.unread, ...Object.fromEntries(unread.map((id) => [chatRoute(id), true])) }
    }))
  }
}

function withMessage(detail: ChatDetail, message: ChatMessage): ChatDetail {
  const known = detail.messages.some((m) => m.id === message.id)
  return {
    ...detail,
    messages: known
      ? detail.messages.map((m) => (m.id === message.id ? message : m))
      : [...detail.messages, message]
  }
}
