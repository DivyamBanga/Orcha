import { describe, expect, it } from 'vitest'
import { firstRunKeys, type FirstRunState } from './firstRun'

// Screen text recorded from a fresh Mac in CI (Claude Code 2.1.292), in the
// order and chunks it arrives.
const THEME =
  "Let's get started. Choose the text style that looks best with your terminal To change this later, run /theme Auto (match terminal) ❯ ✔ Dark mode Light mode"
const NOTES =
  'Security notes: 1. Claude can make mistakes. 2. Due to prompt injection risks, only use it with code you trust Learn more: https://code.claude.com/docs/en/security Press Enter to continue…'
const TRUST =
  'Accessing workspace: /Users/runner/Projects/smoke-app Quick safety check: Is this a project you created or one you trust? ❯ No, exit  Yes, I trust this folder Enter to confirm · Esc to cancel'
const BYPASS =
  'WARNING: Claude Code running in Bypass Permissions mode ... ❯ No, exit  Yes, I accept Enter to confirm · Esc to cancel'

// What PtyManager does: feed chunks, and clear the tail once keys are sent.
function run(chunks: string[]): string[][] {
  const state: FirstRunState = { tail: '', done: new Set() }
  const sent: string[][] = []
  for (const chunk of chunks) {
    const keys = firstRunKeys(state, chunk)
    if (keys) {
      sent.push(keys)
      state.tail = ''
    }
  }
  return sent
}

describe('first-run screens', () => {
  it('answers all four, stepping down to "Yes" on the two that pre-select "No, exit"', () => {
    expect(run([THEME, NOTES, TRUST, BYPASS])).toEqual([
      ['\r'],
      ['\r'],
      ['\x1b[B', '\r'],
      ['\x1b[B', '\r']
    ])
  })

  it('catches a screen that arrives whole right after the previous answer', () => {
    // The trust dialog drawn in one chunk, immediately after the notes' Enter.
    expect(run([NOTES, TRUST])).toEqual([['\r'], ['\x1b[B', '\r']])
  })

  it('catches a screen split across chunks', () => {
    const half = Math.floor(TRUST.length / 2)
    expect(run([TRUST.slice(0, half), TRUST.slice(half)])).toEqual([['\x1b[B', '\r']])
  })

  it('answers each screen once, even when it redraws', () => {
    expect(run([NOTES, NOTES, NOTES])).toEqual([['\r']])
  })

  it('only presses Enter when "Yes" is already selected', () => {
    expect(run([TRUST.replace('❯ No, exit  Yes', 'No, exit ❯ Yes')])).toEqual([['\r']])
  })

  it('leaves an ordinary prompt alone', () => {
    expect(run(['> Try "refactor <filepath>"  ⏵⏵ bypass permissions on (shift+tab to cycle)'])).toEqual([])
  })
})
