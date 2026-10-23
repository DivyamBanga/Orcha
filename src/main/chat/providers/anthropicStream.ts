import type {
  BetaContentBlock,
  BetaRawContentBlockDelta,
  BetaRawMessageStreamEvent
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatParts, ChatSource } from '../../../shared/types'
import type { StreamEvent } from '../provider'

// Turns Claude's stream of events into what the chat shows: the words, the
// reasoning summary, search rows, and the pages a reply cites (as numbered
// chips in the text and a list of sources).

// Citation chips after a claim: " [1][3]", each a Markdown link to its source
// titled "cite" (which the chat draws as a chip, and Copy leaves out).
export function citeMarks(numbers: number[], sources: ChatSource[]): string {
  return (
    ' ' +
    numbers
      .filter((n) => sources[n])
      .map((n) => `[${n + 1}](<${sources[n].url.replace(/[<>\s]/g, encodeURIComponent)}> "cite")`)
      .join('')
  )
}

// What an open content block is for, when it matters at its end.
type Open =
  { kind: 'text' } | { kind: 'thinking'; since: number } | { kind: 'search'; json: string }

// The blocks after which the next words belong in a new paragraph: the model
// said something, a tool ran, and now it carries on.
function isToolBlock(block: BetaContentBlock): boolean {
  return (
    block.type === 'tool_use' ||
    block.type === 'server_tool_use' ||
    block.type.endsWith('_tool_result')
  )
}

function searchLabel(json: string): string {
  try {
    const query = (JSON.parse(json) as { query?: unknown }).query
    if (typeof query === 'string' && query.trim()) {
      const q = query.trim()
      return `Searching: ${q.length > 80 ? q.slice(0, 79) + '…' : q}`
    }
  } catch {
    // A query that didn't parse is still a search.
  }
  return 'Searching the web'
}

// The blank line owed between what was said before and what comes next.
function paragraphBreak(text: string): string {
  return text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
}

export class Reply {
  text = ''
  ttftMs: number | null = null

  private thinking = ''
  private thinkingMs = 0
  private thinkingGap = false
  private owesBreak = false
  private cited: number[] = []
  private open = new Map<number, Open>()
  // Pages cited, in the order they were first cited, so the chips count from 1.
  private sources: ChatSource[] = []
  // Every page the searches returned, for the sources a reply never cited.
  private found = new Map<string, string>()
  private started = Date.now()

  constructor(private emit: (event: StreamEvent) => void) {}

  // One call to the model. A later call's words start a new paragraph after
  // the last ones.
  startRound(round: number): void {
    this.open.clear()
    this.cited = []
    if (round > 0) this.owesBreak = true
  }

  handle(event: BetaRawMessageStreamEvent): void {
    if (event.type === 'content_block_start') this.begin(event.index, event.content_block)
    else if (event.type === 'content_block_delta') this.delta(event.index, event.delta)
    else if (event.type === 'content_block_stop') this.end(event.index)
  }

  parts(): ChatParts {
    const sources = [...this.sources]
    for (const [url, title] of this.found) {
      if (!sources.some((s) => s.url === url)) sources.push({ url, title })
    }
    let ms = this.thinkingMs
    for (const block of this.open.values()) {
      if (block.kind === 'thinking') ms += Date.now() - block.since
    }
    return {
      ...(this.thinking ? { thinking: { text: this.thinking, ms } } : {}),
      ...(sources.length ? { sources } : {})
    }
  }

  private begin(index: number, block: BetaContentBlock): void {
    if (isToolBlock(block)) this.owesBreak = true
    if (block.type === 'text') {
      this.cited = []
      this.open.set(index, { kind: 'text' })
    } else if (block.type === 'thinking') {
      this.thinkingGap = this.thinking !== ''
      this.open.set(index, { kind: 'thinking', since: Date.now() })
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      this.open.set(index, { kind: 'search', json: '' })
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && !this.found.has(r.url)) {
          this.found.set(r.url, r.title || r.url)
        }
      }
    }
  }

  private delta(index: number, delta: BetaRawContentBlockDelta): void {
    if (delta.type === 'text_delta') {
      this.write(delta.text)
    } else if (delta.type === 'thinking_delta') {
      this.think(delta.thinking)
    } else if (delta.type === 'citations_delta') {
      if (delta.citation.type === 'web_search_result_location') {
        const n = this.source(delta.citation.url, delta.citation.title)
        if (!this.cited.includes(n)) this.cited.push(n)
      }
    } else if (delta.type === 'input_json_delta') {
      const block = this.open.get(index)
      if (block?.kind === 'search') block.json += delta.partial_json
    }
  }

  private end(index: number): void {
    const block = this.open.get(index)
    if (!block) return
    this.open.delete(index)
    if (block.kind === 'text' && this.cited.length > 0) {
      // The chips close the claim the block just made.
      const marks = citeMarks(this.cited, this.sources)
      this.cited = []
      this.text += marks
      this.emit({ kind: 'text', delta: marks })
    } else if (block.kind === 'thinking') {
      this.thinkingMs += Date.now() - block.since
    } else if (block.kind === 'search') {
      this.emit({ kind: 'tool', tool: { kind: 'search', label: searchLabel(block.json) } })
    }
  }

  private write(delta: string): void {
    let out = delta
    if (this.owesBreak && this.text.trim()) {
      out = delta.trimStart()
      if (!out) return
      out = paragraphBreak(this.text) + out
    }
    if (!out) return
    this.owesBreak = false
    this.firstToken()
    this.text += out
    this.emit({ kind: 'text', delta: out })
  }

  private think(delta: string): void {
    if (!delta) return
    // A second thought starts a new paragraph of the summary.
    const out = this.thinkingGap ? '\n\n' + delta : delta
    this.thinkingGap = false
    this.firstToken()
    this.thinking += out
    this.emit({ kind: 'thinking', delta: out })
  }

  private source(url: string, title: string | null): number {
    let n = this.sources.findIndex((s) => s.url === url)
    if (n < 0) n = this.sources.push({ url, title: title || this.found.get(url) || url }) - 1
    return n
  }

  private firstToken(): void {
    if (this.ttftMs === null) this.ttftMs = Date.now() - this.started
  }
}
