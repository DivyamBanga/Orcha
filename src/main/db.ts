import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Project, Workspace, WorkspaceAuth } from '../shared/types'

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'orcha.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      repo_path   TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      remote_path TEXT,
      ssh_host    TEXT,
      ssh_user    TEXT,
      ssh_port    INTEGER
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
  for (const col of [
    'model TEXT',
    'effort TEXT',
    "kind TEXT NOT NULL DEFAULT 'worktree'",
    "agent TEXT NOT NULL DEFAULT 'claude'"
  ]) {
    try {
      db.exec(`ALTER TABLE workspaces ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  for (const col of [
    'remote_path TEXT',
    'ssh_host TEXT',
    'ssh_user TEXT',
    'ssh_port INTEGER',
    'instructions TEXT'
  ]) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }

  // Chats. Messages form a tree (parent_id) so edits and retries become
  // branches; leaf_id is the branch on screen. Each chat freezes its system
  // prompt when it starts. messages_fts indexes message text for search.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id            TEXT PRIMARY KEY,
      project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title         TEXT,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      system_prompt TEXT,
      leaf_id       INTEGER,
      starred       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_updated ON chats (updated_at);
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      parent_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      text       TEXT NOT NULL DEFAULT '',
      files      TEXT,
      parts      TEXT,
      model      TEXT,
      status     TEXT NOT NULL DEFAULT 'done',
      usage      TEXT,
      cost_usd   REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
    END;
  `)
  // Claude on the host's own plan (chat/claudeMax.ts) keeps each chat as a
  // Claude Code session: the session a reply is in, and where it ended.
  for (const col of ['sdk_session TEXT', 'sdk_uuid TEXT']) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  // A reply that was mid-stream when Orcha last closed never finished.
  db.exec("UPDATE messages SET status = 'error' WHERE status = 'streaming'")

  // A project's knowledge: files every chat in it starts with (stored like
  // attachments, by hash).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_files (
      id         INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  // What chats remember about you (chat/memory.ts): global, or one project's.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      chat_id    TEXT,
      created_at INTEGER NOT NULL
    );
  `)

  // Terminal-first rework: retire pre-rework SDK-chat workspaces, then make
  // sure every project has a 'main' session rooted at the repo folder.
  const migrated = db.prepare("SELECT value FROM app_state WHERE key = 'terminal_rework'").get()
  if (!migrated) {
    db.exec("UPDATE workspaces SET status = 'archived' WHERE kind = 'worktree'")
    db.prepare("INSERT INTO app_state (key, value) VALUES ('terminal_rework', '1')").run()
  }
  // (A project made for chats alone has no folder, so no session.)
  const projectRows = db
    .prepare("SELECT * FROM projects WHERE repo_path NOT LIKE 'chat:%'")
    .all() as ProjectRow[]
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

// The open database, for modules that keep their own queries (chat/store.ts).
export function database(): Database.Database {
  return db
}

interface ProjectRow {
  id: string
  name: string
  repo_path: string
  created_at: number
  remote_path: string | null
  ssh_host: string | null
  ssh_user: string | null
  ssh_port: number | null
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
  agent: string
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    createdAt: r.created_at,
    remotePath: r.remote_path,
    sshHost: r.ssh_host,
    sshUser: r.ssh_user,
    sshPort: r.ssh_port,
    chatOnly: r.repo_path.startsWith('chat:')
  }
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
    kind: r.kind as Workspace['kind'],
    agent: r.agent === 'codex' ? 'codex' : 'claude'
  }
}

export const projects = {
  insert(p: Project): void {
    db.prepare(
      `INSERT INTO projects
       (id, name, repo_path, created_at, remote_path, ssh_host, ssh_user, ssh_port)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.id, p.name, p.repoPath, p.createdAt, p.remotePath, p.sshHost, p.sshUser, p.sshPort)
  },
  list(): Project[] {
    return (db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[]).map(
      toProject
    )
  },
  get(id: string): Project | undefined {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row && toProject(row)
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
       (id, project_id, name, branch, worktree_path, session_id, status, created_at, last_activity_at, model, effort, kind, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      w.kind,
      w.agent
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
  // Switches which agent a tab runs and with which model; applies on restart.
  setAgentModel(id: string, agent: Workspace['agent'], model: string | null): void {
    db.prepare('UPDATE workspaces SET agent = ?, model = ? WHERE id = ?').run(agent, model, id)
  },
  setStatus(id: string, status: Workspace['status']): void {
    db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, id)
  },
  removeByProject(projectId: string): void {
    db.prepare('DELETE FROM workspaces WHERE project_id = ?').run(projectId)
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

// Per-workspace auth-mode override, backed by the generic app_state table
// (no schema migration needed) — same trust model as Claude Code's own
// plaintext ~/.claude/.credentials.json on this OS.
export const workspaceAuth = {
  get(workspaceId: string): WorkspaceAuth {
    const raw = appState.get(`authMode:${workspaceId}`)
    if (!raw) return { mode: 'subscription' }
    try {
      return JSON.parse(raw) as WorkspaceAuth
    } catch {
      return { mode: 'subscription' }
    }
  },
  set(workspaceId: string, auth: WorkspaceAuth): void {
    appState.set(`authMode:${workspaceId}`, JSON.stringify(auth))
  }
}
