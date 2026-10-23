import type Database from 'better-sqlite3'

// API keys and other secrets, encrypted with the OS keychain (DPAPI on
// Windows) before they reach the database, and decrypted only in the main
// process. The window, logs, exports and backups only ever see a hint.
//
// The database handle and the cipher are passed in so this runs (and is
// tested) without Electron; main wires in safeStorage's async API (the
// synchronous one is removed in Electron 46).

export const VAULT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    id         TEXT PRIMARY KEY,
    blob       BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
`

export interface Cipher {
  available(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  // `stale`: the OS wants it re-encrypted (a rotated key); the vault does it.
  decrypt(blob: Buffer): Promise<{ plain: string; stale: boolean }>
}

export interface Vault {
  put(id: string, value: string): Promise<void>
  get(id: string): Promise<string | null>
  has(id: string): boolean
  remove(id: string): void
}

export function createVault(db: Database.Database, cipher: Cipher): Vault {
  // Decrypted values for this run, so a chat doesn't ask the keychain per turn.
  const cache = new Map<string, string>()

  const write = async (id: string, value: string): Promise<void> => {
    const blob = await cipher.encrypt(value)
    db.prepare(
      `INSERT INTO secrets (id, blob, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET blob = excluded.blob`
    ).run(id, blob, Date.now())
  }

  return {
    async put(id, value) {
      if (!(await cipher.available())) {
        throw new Error(
          "Windows can't protect keys for this account right now, so it wasn't saved."
        )
      }
      await write(id, value)
      cache.set(id, value)
    },

    async get(id) {
      const cached = cache.get(id)
      if (cached !== undefined) return cached
      const row = db.prepare('SELECT blob FROM secrets WHERE id = ?').get(id) as
        { blob: Buffer } | undefined
      if (!row) return null
      const { plain, stale } = await cipher.decrypt(row.blob)
      if (stale) await write(id, plain)
      cache.set(id, plain)
      return plain
    },

    has(id) {
      return cache.has(id) || db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(id) !== undefined
    },

    remove(id) {
      db.prepare('DELETE FROM secrets WHERE id = ?').run(id)
      cache.delete(id)
    }
  }
}

// Enough of a key to tell two apart, never enough to use: '…3f9a'.
export function keyHint(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 8 ? `…${trimmed.slice(-4)}` : '…'
}

// Anything in `text` that looks like a provider key, masked, for logs and
// diagnostics that might otherwise carry one.
export function redactKeys(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]{8,}/g, 'sk-ant-…')
    .replace(/\b[a-f0-9]{32}\b/gi, '…')
    .replace(/(api-key|x-api-key|authorization)(["':\s]+)(bearer\s+)?[^\s"',}]{8,}/gi, '$1$2$3…')
}
