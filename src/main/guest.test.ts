import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ appState: { get: () => null, set: () => {} } }))

const { claudeRelayEnv, inviteFromDeepLink } = await import('./guest')

const CODE = 'ABCDE-FGHJK-MNPQR-STVWX'

describe('inviteFromDeepLink', () => {
  it('turns the invite page button into the invite link', () => {
    expect(
      inviteFromDeepLink(`orcha://join/${CODE}?relay=https://orcha-relay.example.workers.dev`)
    ).toBe(`https://orcha-relay.example.workers.dev/join/${CODE}`)
  })

  it('allows a local relay over plain http (testing)', () => {
    expect(inviteFromDeepLink(`orcha://join/${CODE}?relay=http://127.0.0.1:8788`)).toBe(
      `http://127.0.0.1:8788/join/${CODE}`
    )
  })

  it('refuses anything that is not exactly an invite', () => {
    expect(inviteFromDeepLink(`orcha://join/${CODE}?relay=http://evil.example`)).toBeNull()
    expect(inviteFromDeepLink(`orcha://join/${CODE}`)).toBeNull()
    expect(inviteFromDeepLink(`orcha://other/${CODE}?relay=https://x.dev`)).toBeNull()
    expect(inviteFromDeepLink(`orcha://join/nope?relay=https://x.dev`)).toBeNull()
    expect(inviteFromDeepLink('https://x.dev/join/' + CODE)).toBeNull()
    expect(inviteFromDeepLink('not a url')).toBeNull()
  })
})

describe('claudeRelayEnv', () => {
  it('is a no-op when not paired', () => {
    const base = { ANTHROPIC_API_KEY: 'k', PATH: '/bin' }
    expect(claudeRelayEnv(base, 'p', 's')).toBe(base)
  })
})
