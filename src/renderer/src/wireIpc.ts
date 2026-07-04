import { IPC } from '../../shared/ipc'
import { useStore } from './store'
import type { ChatItem, GitStatus, SessionStatus } from '../../shared/types'

interface SessionMessageEvent {
  workspaceId: string
  message: Record<string, unknown> & { type: string }
}

interface SessionStatusEvent {
  workspaceId: string
  status: SessionStatus
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function blockContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : ''))
      .join('\n')
  }
  return JSON.stringify(content)
}

// Reduce one raw SDK message into the workspace's ChatItem list.
// includeUserText is used when replaying history: live user prompts are
// echoed optimistically by the store, so they're skipped there.
export function reduceMessage(
  items: ChatItem[],
  streamingText: string,
  message: SessionMessageEvent['message'],
  includeUserText = false
): { items: ChatItem[]; streamingText: string } {
  switch (message.type) {
    case 'stream_event': {
      const event = message.event as { type: string; delta?: { type: string; text?: string } }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return { items, streamingText: streamingText + (event.delta.text ?? '') }
      }
      return { items, streamingText }
    }
    case 'assistant': {
      const apiMessage = message.message as { content: ContentBlock[] }
      const next = [...items]
      for (const block of apiMessage.content) {
        if (block.type === 'text' && block.text?.trim()) {
          next.push({ kind: 'assistant_text', text: block.text })
        } else if (block.type === 'tool_use') {
          next.push({
            kind: 'tool',
            toolUseId: block.id ?? '',
            name: block.name ?? 'tool',
            input: block.input
          })
        }
      }
      return { items: next, streamingText: '' }
    }
    case 'user': {
      const apiMessage = message.message as { content: unknown }
      if (typeof apiMessage?.content === 'string') {
        return includeUserText && apiMessage.content.trim()
          ? { items: [...items, { kind: 'user', text: apiMessage.content }], streamingText }
          : { items, streamingText }
      }
      if (!Array.isArray(apiMessage?.content)) return { items, streamingText }
      let next = items
      for (const block of apiMessage.content as ContentBlock[]) {
        if (includeUserText && block.type === 'text' && block.text?.trim()) {
          next = [...next, { kind: 'user', text: block.text }]
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
          next = next.map((item) =>
            item.kind === 'tool' && item.toolUseId === block.tool_use_id
              ? {
                  ...item,
                  result: blockContentToString(block.content),
                  isError: block.is_error ?? false
                }
              : item
          )
        }
      }
      return { items: next, streamingText }
    }
    case 'orcha_error':
      return {
        items: [...items, { kind: 'error', text: String(message.text ?? 'Unknown error') }],
        streamingText: ''
      }
    default:
      return { items, streamingText }
  }
}

export function wireIpc(): () => void {
  const unsubMessage = window.orcha.on(IPC.EvSessionMessage, (payload) => {
    const { workspaceId, message } = payload as SessionMessageEvent
    if (message.type === 'system' && message.subtype === 'init') {
      const commands = (message as { slash_commands?: string[] }).slash_commands
      if (Array.isArray(commands)) {
        useStore.setState((s) => ({
          slashCommands: { ...s.slashCommands, [workspaceId]: commands }
        }))
      }
    }
    useStore.setState((s) => {
      const reduced = reduceMessage(
        s.messages[workspaceId] ?? [],
        s.streaming[workspaceId] ?? '',
        message
      )
      return {
        messages: { ...s.messages, [workspaceId]: reduced.items },
        streaming: { ...s.streaming, [workspaceId]: reduced.streamingText },
        unread:
          workspaceId !== s.activeWorkspaceId && message.type === 'assistant'
            ? { ...s.unread, [workspaceId]: true }
            : s.unread
      }
    })
  })

  const unsubStatus = window.orcha.on(IPC.EvSessionStatus, (payload) => {
    const { workspaceId, status } = payload as SessionStatusEvent
    useStore.setState((s) => ({
      sessionStatus: { ...s.sessionStatus, [workspaceId]: status },
      streaming: status === 'busy' ? s.streaming : { ...s.streaming, [workspaceId]: '' }
    }))
  })

  const unsubGit = window.orcha.on(IPC.EvGitStatus, (payload) => {
    const { workspaceId, status } = payload as { workspaceId: string; status: GitStatus }
    useStore.setState((s) => ({ gitStatus: { ...s.gitStatus, [workspaceId]: status } }))
  })

  // Fired when the orchestrator creates a workspace, so the sidebar updates.
  const unsubChanged = window.orcha.on(IPC.EvWorkspacesChanged, () => {
    useStore.getState().load()
  })

  return () => {
    unsubMessage()
    unsubStatus()
    unsubGit()
    unsubChanged()
  }
}
