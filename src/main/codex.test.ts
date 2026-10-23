import { describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../shared/types'

vi.mock('./catalog', () => ({
  codexModels: () => ({ ids: ['gpt-6-sol', 'gpt-6-astra'], fallback: 'gpt-6-sol' })
}))

const { codexArgv, codexEnv, codexLaunchCommand, OFFICIAL_CODEX_EXE } = await import('./codex')

const BASE_URL = 'https://example.openai.azure.com/openai/v1'

const workspace = {
  id: 'ws-1',
  name: 'main',
  worktreePath: "C:\\Users\\friend\\Desktop\\Projects\\it's-app",
  model: 'gpt-6-astra'
} as Workspace

describe('codex launch', () => {
  // Pinned byte for byte to the command line Windows tabs run: the provider
  // block is the one part that follows the endpoint it is given.
  it('builds the PowerShell command line', () => {
    const { file } = codexArgv(workspace, BASE_URL)
    const quoted = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const expected = [
      '--no-daemon',
      '-c',
      'model_provider=orcha',
      '-c',
      "model_providers.orcha={name='Orcha',base_url='https://example.openai.azure.com/openai/v1',env_key='ORCHA_CODEX_KEY',wire_api='responses',stream_idle_timeout_ms=600000}",
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
    expect(codexLaunchCommand(workspace, BASE_URL)).toBe(
      `& ${quoted(file)} ${expected.map(quoted).join(' ')}`
    )
  })

  it('gives Mac tabs the same arguments as an argv', () => {
    const { args } = codexArgv(workspace, BASE_URL)
    expect(args[0]).toBe('--no-daemon')
    expect(args.slice(-3)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      workspace.worktreePath
    ])
  })

  it('falls back to the default model for anything not on the list', () => {
    const { args } = codexArgv({ ...workspace, model: 'opus' } as Workspace, BASE_URL)
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-sol')
  })
})

describe('codex environment', () => {
  it('carries the provider key in the variable the launch names, beside the rest', () => {
    expect(codexEnv({ PATH: '/bin' }, 'sk-azure')).toEqual({
      PATH: '/bin',
      ORCHA_CODEX_KEY: 'sk-azure'
    })
  })
})
