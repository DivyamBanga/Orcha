import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createVault, keyHint, redactKeys, VAULT_SCHEMA, type Cipher } from './vault'

// A stand-in for the OS keychain: reversible, but never plain text at rest.
function fakeCipher(available = true): Cipher & { calls: number } {
  const c = {
    calls: 0,
    available: async () => available,
    encrypt: async (plain: string) => Buffer.from(plain, 'utf8').reverse(),
    decrypt: async (blob: Buffer) => {
      c.calls++
      return { plain: Buffer.from(blob).reverse().toString('utf8'), stale: false }
    }
  }
  return c
}

function db(): Database.Database {
  const d = new Database(':memory:')
  d.exec(VAULT_SCHEMA)
  return d
}

describe('vault', () => {
  it('stores secrets encrypted and reads them back once per run', async () => {
    const d = db()
    const cipher = fakeCipher()
    const vault = createVault(d, cipher)
    await vault.put('key:1', 'sk-ant-api03-secret-value')
    const raw = d.prepare('SELECT blob FROM secrets').get() as { blob: Buffer }
    expect(raw.blob.toString('utf8')).not.toContain('secret')

    const fresh = createVault(d, cipher)
    expect(await fresh.get('key:1')).toBe('sk-ant-api03-secret-value')
    expect(await fresh.get('key:1')).toBe('sk-ant-api03-secret-value')
    expect(cipher.calls).toBe(1)
    expect(await fresh.get('missing')).toBeNull()
  })

  it('removes secrets', async () => {
    const vault = createVault(db(), fakeCipher())
    await vault.put('azure', 'abc')
    expect(vault.has('azure')).toBe(true)
    vault.remove('azure')
    expect(vault.has('azure')).toBe(false)
    expect(await vault.get('azure')).toBeNull()
  })

  it('refuses to store when the keychain is unavailable', async () => {
    const vault = createVault(db(), fakeCipher(false))
    await expect(vault.put('x', 'y')).rejects.toThrow(/wasn't saved/)
  })

  it('hints and redacts keys', () => {
    expect(keyHint('sk-ant-api03-abcdefgh1234')).toBe('…1234')
    expect(keyHint('short')).toBe('…')
    const log =
      'call failed: x-api-key: sk-ant-api03-abcdefghijklmnop api-key=0123456789abcdef0123456789abcdef'
    expect(redactKeys(log)).not.toMatch(/abcdefghijklmnop|0123456789abcdef0123456789abcdef/)
  })
})
