import { describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../shared/types'

vi.mock('./guest', () => ({
  relayConfig: () => ({ relay: 'https://relay.example', token: 'og_x' }),
  attributionHeaders: (project: string, session: string) => ({
    'X-Orcha-Project': project,
    'X-Orcha-Session': session
  })
}))

const { codexArgv, codexLaunchCommand, OFFICIAL_CODEX_EXE } = await import('./codex')

const workspace = {
  id: 'ws-1',
  name: 'main',
  worktreePath: "C:\\Users\\friend\\Desktop\\Projects\\it's-app",
  model: 'gpt-6-astra'
} as Workspace

describe('codex launch', () => {
  // Pinned byte for byte to the command line Windows tabs ran before the
  // launch was split into argv (for Mac) and a PowerShell string.
  it('builds the same PowerShell command line as before', () => {
    const { file } = codexArgv(workspace, undefined)
    const quoted = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const expected = [
      '--no-daemon',
      '-c',
      'model_provider=orcha',
      '-c',
      "model_providers.orcha={name='Orcha',base_url='https://relay.example/openai/v1',env_key='ORCHA_RELAY_KEY',wire_api='responses',stream_idle_timeout_ms=600000,http_headers={'X-Orcha-Project'='main','X-Orcha-Session'='ws-1'}}",
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      `projects={"C:\\\\Users\\\\friend\\\\Desktop\\\\Projects\\\\it's-app"={trust_level='trusted'}}`,
      '-m',
      'gpt-6-astra',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workspace.worktreePath
    ]
    expect([OFFICIAL_CODEX_EXE, 'codex']).toContain(file)
    expect(codexLaunchCommand(workspace, undefined)).toBe(
      `& ${quoted(file)} ${expected.map(quoted).join(' ')}`
    )
  })

  it('gives Mac tabs the same arguments as an argv', () => {
    const { args } = codexArgv(workspace, undefined)
    expect(args[0]).toBe('--no-daemon')
    expect(args.slice(-3)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workspace.worktreePath
    ])
  })

  it('falls back to the default model for anything not on the list', () => {
    const { args } = codexArgv({ ...workspace, model: 'opus' } as Workspace, undefined)
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-sol')
  })
})
