import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Project, Workspace } from '../shared/types'

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'orcha.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id),
      name             TEXT NOT NULL,
      branch           TEXT NOT NULL,
      worktree_path    TEXT NOT NULL,
      session_id       TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       INTEGER NOT NULL,
      last_activity_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  // Additive migrations for pre-existing databases.
  for (const col of ['model TEXT', 'effort TEXT', "kind TEXT NOT NULL DEFAULT 'worktree'"]) {
    try {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }

  // Terminal-first rework: retire pre-rework SDK-chat workspaces, then make
  // sure every project has a 'main' session rooted at the repo folder.
  const migrated = db.prepare("SELECT value FROM app_state WHERE key = 'terminal_rework'").get()
  if (!migrated) {
    db.exec("UPDATE workspaces SET status = 'archived' WHERE kind = 'worktree'")
    db.prepare("INSERT INTO app_state (key, value) VALUES ('terminal_rework', '1')").run()
  }
  const projectRows = db.prepare('SELECT * FROM projects').all() as ProjectRow[]
  for (const p of projectRows) {
    const main = db
      .prepare("SELECT id FROM workspaces WHERE project_id = ? AND kind = 'main' AND status = 'active'")
      .get(p.id)
    if (!main) {
      db.prepare(
        `INSERT INTO workspaces
         (id, project_id, name, branch, worktree_path, session_id, status, created_at, last_activity_at, model, effort, kind)
         VALUES (?, ?, ?, '', ?, NULL, 'active', ?, NULL, NULL, NULL, 'main')`
      ).run(randomUUID(), p.id, p.name, p.repo_path, Date.now())
    }
  }
}

interface ProjectRow {
  id: string
  name: string
  repo_path: string
  created_at: number
}

interface WorkspaceRow {
  id: string
  project_id: string
  name: string
  branch: string
  worktree_path: string
  session_id: string | null
  status: string
  created_at: number
  last_activity_at: number | null
  model: string | null
  effort: string | null
  kind: string
}

function toProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, repoPath: r.repo_path, createdAt: r.created_at }
}

function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    branch: r.branch,
    worktreePath: r.worktree_path,
    sessionId: r.session_id,
    status: r.status as Workspace['status'],
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at,
    model: r.model,
    effort: r.effort as Workspace['effort'],
    kind: r.kind as Workspace['kind']
  }
}

export const projects = {
  insert(p: Project): void {
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
      p.id,
      p.name,
      p.repoPath,
      p.createdAt
    )
  },
  list(): Project[] {
    return (db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[]).map(
      toProject
    )
  },
  byRepoPath(repoPath: string): Project | undefined {
    const row = db.prepare('SELECT * FROM projects WHERE repo_path = ?').get(repoPath) as
      | ProjectRow
      | undefined
    return row && toProject(row)
  },
  remove(id: string): void {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

export const workspaces = {
  insert(w: Workspace): void {
    db.prepare(
      `INSERT INTO workspaces
       (id, project_id, name, branch, worktree_path, session_id, status, created_at, last_activity_at, model, effort, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      w.id,
      w.projectId,
      w.name,
      w.branch,
      w.worktreePath,
      w.sessionId,
      w.status,
      w.createdAt,
      w.lastActivityAt,
      w.model,
      w.effort,
      w.kind
    )
  },
  listActive(): Workspace[] {
    return (
      db
        .prepare("SELECT * FROM workspaces WHERE status = 'active' ORDER BY created_at")
        .all() as WorkspaceRow[]
    ).map(toWorkspace)
  },
  get(id: string): Workspace | undefined {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceRow
      | undefined
    return row && toWorkspace(row)
  },
  setSessionId(id: string, sessionId: string): void {
    db.prepare('UPDATE workspaces SET session_id = ?, last_activity_at = ? WHERE id = ?').run(
      sessionId,
      Date.now(),
      id
    )
  },
  setStatus(id: string, status: Workspace['status']): void {
    db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id)
  }
}

export const appState = {
  get(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  },
  set(key: string, value: string): void {
    db.prepare(
      'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(key, value, value)
  }
}
