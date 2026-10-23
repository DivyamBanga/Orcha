import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mapCwdToProject, newScanState, scanAll, scanOnce, type ScanDirs } from './transcripts'

let root: string
let dirs: ScanDirs

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcha-scan-'))
  dirs = { claude: join(root, 'projects'), codex: join(root, 'sessions') }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(path: string, lines: object[], mode: 'write' | 'append' = 'write'): string {
  mkdirSync(dirname(path), { recursive: true })
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  if (mode === 'write') writeFileSync(path, text)
  else appendFileSync(path, text)
  return path
}

function assistant(
  id: string,
  usage: object,
  extra: { model?: string; requestId?: string; at?: string; sessionId?: string } = {}
): object {
  return {
    type: 'assistant',
    timestamp: extra.at ?? '2026-10-01T10:00:00.000Z',
    cwd: 'C:\\Users\\me\\repo',
    sessionId: extra.sessionId ?? 's1',
    requestId: extra.requestId ?? `req_${id}`,
    message: { id, model: extra.model ?? 'claude-haiku-4-5-20251001', usage }
  }
}

const claudeFile = (name: string): string => join(dirs.claude!, 'proj', name)
const small = { input_tokens: 1, output_tokens: 1 }

describe('Claude Code transcripts', () => {
  it('splits buckets exclusively and keeps the 1-hour cache bucket', () => {
    put(claudeFile('a.jsonl'), [
      assistant('m1', {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 150,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 100 }
      })
    ])
    const { events } = scanOnce(dirs, newScanState())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      surface: 'claude-code',
      route: 'plan',
      costKind: 'plan',
      input: 10,
      output: 20,
      cacheRead: 300,
      cacheWrite5m: 50,
      cacheWrite1h: 100,
      sessionId: 's1',
      cwd: 'C:\\Users\\me\\repo'
    })
    expect(events[0].spec).toBe('claude-haiku-4-5')
  })

  it('falls back to the 5-minute bucket when the split is absent', () => {
    put(claudeFile('a.jsonl'), [
      assistant('m1', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 40 })
    ])
    const [event] = scanOnce(dirs, newScanState()).events
    expect(event.cacheWrite5m).toBe(40)
    expect(event.cacheWrite1h).toBe(0)
  })

  it('keeps claude-fable models, even when the plain cache total reads 0', () => {
    put(claudeFile('a.jsonl'), [
      assistant(
        'm1',
        {
          input_tokens: 5,
          output_tokens: 6,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 70 }
        },
        { model: 'claude-fable-5-1' }
      )
    ])
    const [event] = scanOnce(dirs, newScanState()).events
    expect(event.model).toBe('claude-fable-5-1')
    expect(event.spec).toBe('claude-fable-5-1')
    expect(event.cacheWrite1h).toBe(70)
  })

  it('skips synthetic replies and lines with no tokens', () => {
    put(claudeFile('a.jsonl'), [
      assistant('m1', { input_tokens: 5, output_tokens: 5 }, { model: '<synthetic>' }),
      assistant('m2', { input_tokens: 0, output_tokens: 0 })
    ])
    expect(scanOnce(dirs, newScanState()).events).toHaveLength(0)
  })

  it('counts a message once when a resumed session copies it, crediting the first session', () => {
    const first = put(claudeFile('first.jsonl'), [assistant('m1', small, { sessionId: 'old' })])
    utimesSync(first, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    // The resumed session carries the old message again, plus a new one.
    put(claudeFile('resumed.jsonl'), [
      assistant('m1', small, { sessionId: 'new' }),
      assistant('m2', small, { sessionId: 'new' })
    ])
    const { events } = scanOnce(dirs, newScanState())
    expect(events.map((e) => e.key).sort()).toEqual(['m1:req_m1', 'm2:req_m2'])
    expect(events.find((e) => e.key === 'm1:req_m1')?.sessionId).toBe('old')
  })

  it('keeps the most complete version of a message written in several lines', () => {
    put(claudeFile('a.jsonl'), [
      assistant('m1', { input_tokens: 10, output_tokens: 8 }),
      assistant('m1', { input_tokens: 10, output_tokens: 506 })
    ])
    const { events } = scanOnce(dirs, newScanState())
    expect(events).toHaveLength(1)
    expect(events[0].output).toBe(506)
  })

  it('reads nested subagent transcripts', () => {
    put(claudeFile('s1.jsonl'), [assistant('top', small)])
    put(join(dirs.claude!, 'proj', 's1', 'subagents', 'agent-a.jsonl'), [assistant('sub', small)])
    put(join(dirs.claude!, 'proj', 's1', 'subagents', 'workflows', 'w', 'agent-b.jsonl'), [
      assistant('deep', small)
    ])
    const keys = scanOnce(dirs, newScanState()).events.map((e) => e.key)
    expect(keys.sort()).toEqual(['deep:req_deep', 'sub:req_sub', 'top:req_top'])
  })

  it('prices each iteration at its own model', () => {
    put(claudeFile('a.jsonl'), [
      assistant('m1', {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          { model: 'claude-opus-4-7', input_tokens: 10, output_tokens: 20 },
          { model: 'claude-fable-5', input_tokens: 30, output_tokens: 40 }
        ]
      })
    ])
    const { events } = scanOnce(dirs, newScanState())
    expect(events.map((e) => [e.model, e.input])).toEqual([
      ['claude-opus-4-7', 10],
      ['claude-fable-5', 30]
    ])
  })

  it('only reads appended bytes on a second scan', () => {
    const path = claudeFile('a.jsonl')
    put(path, [assistant('m1', small)])
    const state = newScanState()
    const one = scanOnce(dirs, state)
    expect(one.events).toHaveLength(1)

    expect(scanOnce(dirs, state)).toMatchObject({ events: [], bytesRead: 0 })

    put(path, [assistant('m2', small)], 'append')
    const three = scanOnce(dirs, state)
    expect(three.events.map((e) => e.key)).toEqual(['m2:req_m2'])
    expect(three.bytesRead).toBeLessThan(one.bytesRead * 1.5)
  })

  it('waits for a half-written line to be finished', () => {
    const path = claudeFile('a.jsonl')
    const line = JSON.stringify(assistant('m1', small))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, line.slice(0, 40))
    const state = newScanState()
    expect(scanOnce(dirs, state).events).toHaveLength(0)
    appendFileSync(path, line.slice(40) + '\n')
    expect(scanOnce(dirs, state).events).toHaveLength(1)
  })

  it('starts a file over when it shrinks, without counting old messages twice', () => {
    const path = claudeFile('a.jsonl')
    put(path, [
      assistant('m1', small),
      assistant('m2', small),
      assistant('m-long-id-xxxxxx', small)
    ])
    const state = newScanState()
    expect(scanOnce(dirs, state).events).toHaveLength(3)
    // Replaced by a shorter file holding one old and one new message.
    put(path, [assistant('m1', small), assistant('m3', small)])
    const again = scanOnce(dirs, state)
    expect(again.events.map((e) => e.key)).toEqual(['m3:req_m3'])
    expect(again.bytesRead).toBeGreaterThan(0)
  })

  it('reports deleted files and delivers in batches', () => {
    const path = claudeFile('a.jsonl')
    put(path, [assistant('m1', small), assistant('m2', small), assistant('m3', small)])
    const state = newScanState()
    const batches: number[] = []
    scanAll(dirs, state, { maxEvents: 2 }, (b) => batches.push(b.events.length))
    expect(batches.reduce((a, b) => a + b, 0)).toBe(3)
    expect(Math.max(...batches)).toBeLessThanOrEqual(2)
    rmSync(path)
    expect(scanOnce(dirs, state).removed).toEqual([path])
  })

  it('resumes from saved positions without re-reading', () => {
    put(claudeFile('a.jsonl'), [assistant('m1', small)])
    const done = scanOnce(dirs, newScanState())
    expect(scanOnce(dirs, newScanState(done.files))).toMatchObject({ events: [], bytesRead: 0 })
  })
})

describe('Codex rollouts', () => {
  const sid = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const rollout = (): string =>
    join(dirs.codex!, '2026', '10', '01', `rollout-2026-10-01T10-00-00-${sid}.jsonl`)
  const tokenCount = (total: number, last: object, at: string): object => ({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: total }, last_token_usage: last }
    }
  })
  const head = (provider: string): object[] => [
    {
      timestamp: '2026-10-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: sid, cwd: '/work/repo', model_provider: provider }
    },
    {
      timestamp: '2026-10-01T10:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.5', cwd: '/work/repo' }
    }
  ]

  it('turns token_count events into codex events and skips repeated totals', () => {
    put(rollout(), [
      ...head('orcha'),
      tokenCount(
        150,
        {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 50,
          reasoning_output_tokens: 10
        },
        '2026-10-01T10:00:05.000Z'
      ),
      tokenCount(150, { input_tokens: 100, output_tokens: 50 }, '2026-10-01T10:00:06.000Z')
    ])
    const { events } = scanOnce(dirs, newScanState())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      surface: 'codex',
      route: 'azure',
      costKind: 'billed',
      model: 'gpt-5.5',
      input: 60,
      cacheRead: 40,
      output: 50,
      reasoning: 10,
      sessionId: sid,
      cwd: '/work/repo'
    })
  })

  it('counts Codex on the owner own account as plan usage', () => {
    put(rollout(), [
      ...head('openai'),
      tokenCount(10, { input_tokens: 6, output_tokens: 4 }, '2026-10-01T10:00:05.000Z')
    ])
    expect(scanOnce(dirs, newScanState()).events[0]).toMatchObject({
      route: 'plan',
      costKind: 'plan'
    })
  })

  it('remembers the model and folder across incremental scans', () => {
    put(rollout(), [
      ...head('orcha'),
      tokenCount(10, { input_tokens: 6, output_tokens: 4 }, '2026-10-01T10:00:05.000Z')
    ])
    const state = newScanState()
    scanOnce(dirs, state)
    put(
      rollout(),
      [tokenCount(30, { input_tokens: 12, output_tokens: 8 }, '2026-10-01T10:01:00.000Z')],
      'append'
    )
    const { events } = scanOnce(dirs, state)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ model: 'gpt-5.5', cwd: '/work/repo', input: 12 })
  })
})

describe('mapCwdToProject', () => {
  const projects = [
    { id: 'a', name: 'Alpha', repoPath: 'C:\\Code\\Alpha' },
    { id: 'b', name: 'Beta', repoPath: 'C:\\Code\\Beta' },
    { id: 'c', name: 'Chat', repoPath: 'C:\\Code\\Chat', chatOnly: true }
  ]
  const wt = 'C:\\Users\\me\\.orcha\\worktrees'

  it('maps repos, anything inside them, and Orcha worktrees', () => {
    expect(mapCwdToProject('c:/code/alpha', projects, wt)).toBe('a')
    expect(mapCwdToProject('C:\\Code\\Alpha\\.claude\\worktrees\\x', projects, wt)).toBe('a')
    expect(mapCwdToProject(`${wt}\\Beta\\session-1\\src`, projects, wt)).toBe('b')
  })

  it('returns null for strangers, lookalikes, chat-only projects and ambiguous names', () => {
    expect(mapCwdToProject(null, projects, wt)).toBeNull()
    expect(mapCwdToProject('C:\\Code\\AlphaTwo', projects, wt)).toBeNull()
    expect(mapCwdToProject('C:\\Code\\Chat', projects, wt)).toBeNull()
    const twins = [...projects, { id: 'd', name: 'beta', repoPath: 'D:\\Beta' }]
    expect(mapCwdToProject(`${wt}\\Beta\\s`, twins, wt)).toBeNull()
  })
})
