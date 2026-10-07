// Artifacts: substantial, self-contained pieces a reply writes in an
// <artifact> tag (a web page, a React component, an SVG, a diagram, a
// document, code) so they open beside the chat instead of filling it.
// Writing one again with the same identifier makes a new version.
//
//   <artifact identifier="todo-app" type="application/vnd.react" title="To-do app">
//   …
//   </artifact>
//
// Replies stream, so the parser accepts an artifact whose closing tag hasn't
// arrived yet (complete: false). Pure, so main and the renderer share it.

export type ArtifactType =
  | 'text/html'
  | 'application/vnd.react'
  | 'image/svg+xml'
  | 'application/vnd.mermaid'
  | 'text/markdown'
  | 'application/vnd.code'

export interface Artifact {
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  content: string
  complete: boolean
}

export type Segment = { kind: 'text'; text: string } | { kind: 'artifact'; artifact: Artifact }

const TYPES: ArtifactType[] = [
  'text/html',
  'application/vnd.react',
  'image/svg+xml',
  'application/vnd.mermaid',
  'text/markdown',
  'application/vnd.code'
]

const OPEN = /<artifact\b([^>]*)>/g
const CLOSE = '</artifact>'

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return m ? (m[1] ?? m[2]) : null
}

// Splits a reply into its text and its artifacts, in order. An opening tag
// that's still arriving (no ">" yet) is held back rather than shown as text.
export function splitArtifacts(text: string): Segment[] {
  const segments: Segment[] = []
  let at = 0
  OPEN.lastIndex = 0
  for (let m = OPEN.exec(text); m; m = OPEN.exec(text)) {
    if (m.index > at) segments.push({ kind: 'text', text: text.slice(at, m.index) })
    const start = m.index + m[0].length
    const end = text.indexOf(CLOSE, start)
    const type = attr(m[1], 'type') as ArtifactType | null
    let content = text.slice(start, end < 0 ? undefined : end)
    // Content usually sits on its own lines inside the tag.
    content = content.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    segments.push({
      kind: 'artifact',
      artifact: {
        identifier: attr(m[1], 'identifier') ?? `artifact-${segments.length}`,
        type: type && TYPES.includes(type) ? type : 'application/vnd.code',
        title: attr(m[1], 'title') ?? 'Untitled',
        language: attr(m[1], 'language'),
        content,
        complete: end >= 0
      }
    })
    if (end < 0) return segments
    at = end + CLOSE.length
    OPEN.lastIndex = at
  }
  let rest = text.slice(at)
  const partial = rest.lastIndexOf('<artifact')
  if (partial >= 0 && !rest.slice(partial).includes('>')) rest = rest.slice(0, partial)
  if (rest) segments.push({ kind: 'text', text: rest })
  return segments
}

// The text with each artifact as a fenced code block, for copying and
// exporting a reply where artifacts can't open.
export function artifactsAsCode(text: string): string {
  return splitArtifacts(text)
    .map((s) => {
      if (s.kind === 'text') return s.text
      const a = s.artifact
      const lang =
        a.language ??
        {
          'text/html': 'html',
          'application/vnd.react': 'jsx',
          'image/svg+xml': 'svg',
          'application/vnd.mermaid': 'mermaid',
          'text/markdown': 'markdown',
          'application/vnd.code': ''
        }[a.type]
      return `\n**${a.title}**\n\n\`\`\`${lang}\n${a.content}\n\`\`\`\n`
    })
    .join('')
}
