import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { database } from '../db'
import { hasAttachment, readAttachment } from './attachments'
import { fileText } from './adapter'
import type { ChatFile, Project, ProjectInstructions } from '../../shared/types'

// What chats in a project start with: its instructions and its knowledge
// files. A project with a folder on this computer keeps its instructions in
// the repo's CLAUDE.md, so Claude Code sessions in it read the same thing;
// one with no folder (or on a server) keeps them in Orcha.

const claudeMd = (project: Project): string | null =>
  project.chatOnly || project.sshHost ? null : join(project.repoPath, 'CLAUDE.md')

export function projectInstructions(project: Project): ProjectInstructions {
  const path = claudeMd(project)
  if (path) {
    return { text: existsSync(path) ? readFileSync(path, 'utf8') : '', path }
  }
  const row = database()
    .prepare('SELECT instructions FROM projects WHERE id = ?')
    .get(project.id) as { instructions: string | null } | undefined
  return { text: row?.instructions ?? '', path: null }
}

export function setProjectInstructions(project: Project, text: string): void {
  const path = claudeMd(project)
  if (path) writeFileSync(path, text)
  else database().prepare('UPDATE projects SET instructions = ? WHERE id = ?').run(text, project.id)
}

// Knowledge files: text the project's chats all read (plain text, code, and
// what was read out of Office files; stored like attachments).
export const knowledge = {
  list(projectId: string): (ChatFile & { id: number })[] {
    const rows = database()
      .prepare('SELECT id, file FROM project_files WHERE project_id = ? ORDER BY id')
      .all(projectId) as { id: number; file: string }[]
    return rows.map((r) => ({ ...(JSON.parse(r.file) as ChatFile), id: r.id }))
  },

  add(projectId: string, file: ChatFile): void {
    if (file.kind !== 'text') {
      throw new Error(
        `${file.name} can't be project knowledge: text, code and Office files can. Attach it in a chat instead.`
      )
    }
    if (!hasAttachment(file)) throw new Error(`${file.name} is no longer here; add it again.`)
    database()
      .prepare('INSERT INTO project_files (project_id, file, created_at) VALUES (?, ?, ?)')
      .run(projectId, JSON.stringify(file), Date.now())
  },

  remove(id: number): void {
    database().prepare('DELETE FROM project_files WHERE id = ?').run(id)
  },

  // Stored files the knowledge of any project still uses.
  hashes(): string[] {
    const rows = database().prepare('SELECT file FROM project_files').all() as { file: string }[]
    return rows.map((r) => (JSON.parse(r.file) as ChatFile).hash)
  }
}

// The project's part of a chat's system prompt.
export function projectPrompt(project: Project): string {
  const instructions = projectInstructions(project).text.trim()
  const files = knowledge.list(project.id).flatMap((f) => {
    try {
      const data = readAttachment(f)
      return 'text' in data ? [fileText(f.name, data.text)] : []
    } catch {
      return []
    }
  })
  return [
    `This chat is in their project "${project.name}".`,
    ...(instructions
      ? [`The project's instructions:\n<instructions>\n${instructions}\n</instructions>`]
      : []),
    ...(files.length ? [`The project's knowledge files:\n${files.join('\n')}`] : [])
  ].join('\n\n')
}
