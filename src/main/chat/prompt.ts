import type { ChatSettings } from '../../shared/types'

// The system prompt a chat starts with. It's built once, when the chat's
// first message is sent, and stored with the chat: a prompt that changed
// between turns would throw away the prompt cache (and, on the newest Claude
// models, the reasoning bound to it), so later changes to settings apply to
// new chats.

// How to write an artifact (shared/artifacts.ts reads them; the libraries
// listed are the ones the artifact runtime provides).
const ARTIFACTS = `When you make something substantial and self-contained that they'll want to see, run, or keep (a web page, an interactive app, a chart or diagram, an SVG, a document of more than a few paragraphs, or a whole program), write it as an artifact so it opens beside the chat:

<artifact identifier="kebab-case-id" type="TYPE" title="Short title">
...the complete content...
</artifact>

TYPE is one of: text/html (a full page; inline CSS and JS), application/vnd.react (one React component as the default export, styled with Tailwind classes; it may import react, recharts, lucide-react, d3, three, lodash and papaparse, nothing else, and cannot make network requests), image/svg+xml, application/vnd.mermaid (a Mermaid diagram), text/markdown (a document), or application/vnd.code (code, with language="python" or similar). To change an artifact, write it again in full with the same identifier. Keep short code snippets and explanations in the chat as normal Markdown, not artifacts.`

export function buildSystemPrompt(opts: {
  now: Date
  profile?: Pick<ChatSettings, 'name' | 'about' | 'style'>
  project?: string | null // its project's instructions and knowledge (projects.ts)
  memory?: string | null // what it remembers, and how to save more (memory.ts)
}): string {
  const date = opts.now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const { name = '', about = '', style = '' } = opts.profile ?? {}
  return [
    "You're chatting with someone in Orcha, a desktop app for working with AI. Be direct and genuinely helpful.",
    'Write in Markdown. Match the length to the question: a casual message gets a short, natural reply; use headings, lists and tables only when they make an answer easier to read. Put code in fenced blocks with the language named.',
    ARTIFACTS,
    `Today is ${date}.`,
    ...(opts.project ? [opts.project] : []),
    ...(name.trim() ? [`Their name is ${name.trim()}.`] : []),
    ...(about.trim()
      ? [`What they've said about themselves:\n<about>\n${about.trim()}\n</about>`]
      : []),
    ...(style.trim()
      ? [`How they'd like you to respond:\n<preferences>\n${style.trim()}\n</preferences>`]
      : []),
    ...(opts.memory ? [opts.memory] : [])
  ].join('\n\n')
}
