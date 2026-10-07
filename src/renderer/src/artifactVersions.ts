import { splitArtifacts, type Artifact } from '../../shared/artifacts'

// Every artifact in a conversation, as versions: writing one again with the
// same identifier adds a version. Also numbers each artifact in each reply
// (its version), for the card that stands in for it.

export interface ArtifactVersion extends Artifact {
  messageId: number
}

export interface ArtifactIndex {
  versions: Map<string, ArtifactVersion[]>
  // Per reply, the version number (1-based) of each artifact in it, in order.
  numbers: Map<number, number[]>
}

export function indexArtifacts(replies: { id: number; text: string }[]): ArtifactIndex {
  const versions = new Map<string, ArtifactVersion[]>()
  const numbers = new Map<number, number[]>()
  for (const reply of replies) {
    const inReply: number[] = []
    for (const s of splitArtifacts(reply.text)) {
      if (s.kind !== 'artifact') continue
      const list = versions.get(s.artifact.identifier) ?? []
      list.push({ ...s.artifact, messageId: reply.id })
      versions.set(s.artifact.identifier, list)
      inReply.push(list.length)
    }
    if (inReply.length) numbers.set(reply.id, inReply)
  }
  return { versions, numbers }
}

const EXT: Record<string, string> = {
  'text/html': 'html',
  'application/vnd.react': 'jsx',
  'image/svg+xml': 'svg',
  'application/vnd.mermaid': 'mmd',
  'text/markdown': 'md'
}
const LANG_EXT: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  bash: 'sh',
  shell: 'sh',
  ruby: 'rb',
  rust: 'rs',
  go: 'go',
  java: 'java',
  csharp: 'cs',
  cpp: 'cpp',
  c: 'c',
  sql: 'sql',
  json: 'json',
  yaml: 'yml',
  css: 'css'
}

// A file name to download an artifact as.
export function artifactFileName(a: Artifact): string {
  const base = a.title.replace(/[<>:"/\\|?*]/g, ' ').trim() || 'artifact'
  const ext = EXT[a.type] ?? LANG_EXT[(a.language ?? '').toLowerCase()] ?? 'txt'
  return `${base}.${ext}`
}

// The fence language for showing an artifact's code.
export function artifactLanguage(a: Artifact): string {
  return (
    a.language ??
    {
      'text/html': 'html',
      'application/vnd.react': 'jsx',
      'image/svg+xml': 'xml',
      'text/markdown': 'markdown'
    }[a.type as string] ??
    ''
  )
}

export const KIND: Record<string, string> = {
  'text/html': 'Web page',
  'application/vnd.react': 'App',
  'image/svg+xml': 'Image',
  'application/vnd.mermaid': 'Diagram',
  'text/markdown': 'Document',
  'application/vnd.code': 'Code'
}

export const canPreview = (a: Artifact): boolean => a.type !== 'application/vnd.code'
