import { execFileAsync } from '../exec'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { CodexStatus } from '../../shared/types'


export class CodexService {
  async status(): Promise<CodexStatus> {
    const cliInstalled = await execFileAsync('codex', ['--version'])
      .then(() => true)
      .catch(() => false)
    const authenticated = existsSync(join(homedir(), '.codex', 'auth.json'))
    const pluginInstalled = await execFileAsync('claude', ['plugin', 'list'])
      .then(({ stdout }) => stdout.includes('codex@openai-codex'))
      .catch(() => false)
    return { cliInstalled, authenticated, pluginInstalled }
  }

  // One-time, machine-wide: adds OpenAI's official marketplace and installs
  // the plugin that lets a running `claude` session call out to the local
  // `codex` CLI via /codex:* slash commands.
  async setup(): Promise<void> {
    await execFileAsync('claude', ['plugin', 'marketplace', 'add', 'openai/codex-plugin-cc'])
    await execFileAsync('claude', ['plugin', 'install', 'codex@openai-codex'])
  }
}
