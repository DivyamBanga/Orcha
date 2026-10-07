// End-to-end smoke test of an installed Orcha build on a real Mac (GitHub
// Actions macOS runner), as a guest on a local relay with fake providers ($0).
//
//   node scripts/smoke/run.mjs --app /Applications/Orcha.app [--next-zip dist-next/Orcha-mac-arm64.zip]
//
// It launches Orcha the way Finder does (`open`), drives the renderer over the
// Chrome DevTools Protocol, reads main-process state through the smoke hooks
// (src/main/smoke.ts), and leaves screenshots + logs in $SMOKE_OUT.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDevStack } from '../../relay/test/dev-stack.mjs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
)
const APP = resolve(args.app ?? '/Applications/Orcha.app')
const NEXT_ZIP = args['next-zip'] ? resolve(args['next-zip']) : null
const OUT = resolve(process.env.SMOKE_OUT ?? 'smoke-out')
const PORT = 9333
const HOME = homedir()
const PROJECT = join(HOME, 'Projects', 'smoke-app')
const USER_DATA = join(HOME, 'orcha-smoke-profile')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  console.log(line)
  appendFileSync(join(OUT, 'smoke.log'), line + '\n')
}
const failures = []
function check(ok, label) {
  log(ok ? 'PASS' : 'FAIL', label)
  if (!ok) failures.push(label)
  return ok
}
async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await sleep(1000)
  }
  throw new Error(`timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`)
}
const flat = (s) => s.replace(/\s+/g, '')

// ---- CDP ------------------------------------------------------------------------

let ws = null
let seq = 0
const pending = new Map()
async function connect() {
  const target = await waitFor(
    async () => {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      return list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
    },
    60_000,
    'renderer page on the debugging port'
  )
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
}
// A call that never gets an answer (sent while the page was still loading)
// fails after a while instead of hanging the run; waitFor then retries.
function cdp(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => {
    pending.set(id, res)
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`no answer to ${method}`))
    }, 15_000)
  })
}
async function evaluate(expression) {
  const msg = await cdp('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (msg.result?.exceptionDetails) {
    throw new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return msg.result?.result?.value
}
let shot = 0
async function screenshot(name) {
  try {
    const msg = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`),
      Buffer.from(msg.result.data, 'base64')
    )
  } catch {
    // window hidden
  }
  spawnSync('screencapture', [
    '-x',
    join(OUT, `${String(shot).padStart(2, '0')}-${name}-screen.png`)
  ])
}
const state = () => evaluate('return await window.orcha.smoke.state()')
const clickButton = (text) =>
  evaluate(`
    const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled)
    if (!b) return false
    b.click()
    return true`)
const session = async (id) => (await state()).sessions.find((s) => s.id === id)

// ---- the run --------------------------------------------------------------------

function launch(extra = []) {
  // `open` gives the app launchd's bare environment, exactly like Finder.
  execFileSync('open', [
    '-n',
    '-a',
    APP,
    '--args',
    `--remote-debugging-port=${PORT}`,
    '--orcha-smoke',
    `--user-data-dir=${USER_DATA}`,
    ...extra
  ])
}

// rc files that print noise, prompt, and try to redirect billing; none of it
// may reach a session.
function writeHostileShellFiles() {
  const hostile = [
    'echo "hello from a noisy zshrc"',
    'export ANTHROPIC_BASE_URL=http://127.0.0.1:9/evil',
    'export ANTHROPIC_AUTH_TOKEN=leaked',
    'export CLAUDE_CODE_USE_BEDROCK=1',
    '[[ -t 0 ]] && read -t 1 -q "?update oh-my-zsh? [y/N] "',
    ''
  ].join('\n')
  for (const f of ['.zshrc', '.zprofile', '.bash_profile'])
    appendFileSync(join(HOME, f), `\n${hostile}`)
}

// Waits for Claude Code's prompt, recording every first-run screen on the way
// (these are what a friend sees on a fresh Mac). The test presses nothing:
// Orcha has to get through those screens on its own.
async function claudeReady(id) {
  const seen = new Set()
  return waitFor(
    async () => {
      const s = await session(id)
      const screen = flat(s?.screen ?? '').slice(-1500)
      if (/forshortcuts|bypasspermissionson|shift\+tab/i.test(screen.slice(-600))) return true
      const key = screen.slice(-300)
      if (!seen.has(key)) {
        seen.add(key)
        await screenshot(`claude-firstrun-${seen.size}`)
        writeFileSync(join(OUT, `claude-firstrun-${seen.size}.txt`), s?.screen ?? '')
      }
      return false
    },
    150_000,
    'Claude Code prompt ready'
  )
}

async function main() {
  writeHostileShellFiles()
  const stack = await startDevStack({ caps: { claude: 50, sol: 50, astra: 50 } })
  log('relay up', stack.relay, 'invite', stack.invite)
  const guests = async () =>
    fetch(`${stack.relay}/admin/guests`, {
      headers: { authorization: `Bearer ${stack.admin}` }
    }).then((r) => r.json())
  const spent = async (pool) => (await guests())[0].pools.find((p) => p.pool === pool).spent

  try {
    launch()
    await connect()
    await waitFor(
      () => evaluate('return Boolean(document.querySelector("#invite"))'),
      60_000,
      'welcome screen'
    )
    await screenshot('welcome')

    const env = await state()
    check(
      env.path.split(':').includes(join(HOME, '.local', 'bin')),
      `PATH has ~/.local/bin (${env.path})`
    )
    check(Boolean(env.lang), `LANG is set (${env.lang})`)
    check(
      env.leakedEnv.length === 0,
      `no ANTHROPIC_*/provider switches imported from the shell (${env.leakedEnv})`
    )
    // Electron reports roles in lower case.
    const roles = env.menu.map((r) => String(r).toLowerCase())
    check(roles.includes('appmenu') && roles.includes('windowmenu'), `Mac menu roles (${env.menu})`)

    // Invite by orcha:// link: shown, not redeemed until Join.
    execFileSync('open', [`orcha://join/${stack.code}?relay=${encodeURIComponent(stack.relay)}`])
    await waitFor(
      () =>
        evaluate(
          `return document.querySelector('#invite')?.value === ${JSON.stringify(stack.invite)}`
        ),
      30_000,
      'invite prefilled from the orcha:// link'
    )
    check(
      !(await evaluate('return (await window.orcha.guest.status()).paired')),
      'deep link alone does not pair'
    )
    await screenshot('invite-prefilled')
    await clickButton('Join')
    await waitFor(
      () => evaluate('return document.body.innerText.includes("One last check")'),
      30_000,
      'tools screen'
    )
    await screenshot('tools')

    // The real installers, as the friend gets them.
    const started = Date.now()
    if (!(await clickButton('Install everything'))) {
      for (const label of ['Install', 'Update']) while (await clickButton(label)) await sleep(2000)
    }
    await waitFor(
      () =>
        evaluate(
          `const t = await window.orcha.tools.status(); return t.claude.ready && t.codex.ready && t.git.ready`
        ),
      15 * 60_000,
      'Claude Code, Codex and git installed'
    )
    const tools = await evaluate('return await window.orcha.tools.status()')
    log(`installed in ${Math.round((Date.now() - started) / 1000)}s:`, JSON.stringify(tools))
    await screenshot('tools-ready')
    await waitFor(() => clickButton('Start using Orcha'), 30_000, 'Start using Orcha')

    // A project with one commit (worktree sessions need a HEAD).
    mkdirSync(PROJECT, { recursive: true })
    execFileSync('git', ['init', '-q', PROJECT])
    execFileSync('git', [
      '-C',
      PROJECT,
      '-c',
      'user.name=Smoke',
      '-c',
      'user.email=smoke@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    ])
    const project = await evaluate(
      `return await window.orcha.projects.add(${JSON.stringify(PROJECT)}, 'claude')`
    )
    const workspaces = await evaluate('return await window.orcha.workspaces.list()')
    const main = workspaces.find((w) => w.projectId === project.id && w.kind === 'main')
    await evaluate(
      `await window.orcha.pty.create(${JSON.stringify(main.id)}, 120, 34); return true`
    )
    await evaluate('location.reload(); return true').catch(() => {})
    await sleep(3000)
    await connect()
    await evaluate(`
      const row = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('smoke-app'))
      row?.click()
      return true`)
    await claudeReady(main.id)
    await screenshot('claude-ready')

    // Working → finished, billed through the relay (the rc file's bogus base
    // URL would have made the reply fail).
    await evaluate(
      `await window.orcha.session.send(${JSON.stringify(main.id)}, 'ORCHA_SLOW hello'); return true`
    )
    await waitFor(
      async () => (await session(main.id)).activity === 'working',
      30_000,
      'session reads as working'
    )
    check(true, 'session went working')
    await waitFor(
      async () =>
        (await state()).pings.some((p) => p.workspaceId === main.id && p.kind === 'finished'),
      90_000,
      'finished ping'
    )
    check(true, 'finished ping fired')
    check(
      flat((await session(main.id)).screen).includes('step25'),
      'reply streamed into the terminal'
    )
    check((await spent('claude')) > 0, 'Claude spend recorded on the relay')
    await screenshot('claude-replied')

    await evaluate(
      `await window.orcha.session.send(${JSON.stringify(main.id)}, 'ORCHA_ASK which way?'); return true`
    )
    const asked = await waitFor(
      async () =>
        (await state()).pings.find((p) => p.workspaceId === main.id && p.kind === 'blocked'),
      90_000,
      'blocked ping'
    )
    check(
      /Which one should I use/.test(asked.body),
      `blocked ping carries the question (${asked.body})`
    )
    await screenshot('claude-asks')

    // /exit, then a message brings Claude back instead of running in zsh.
    await evaluate(
      `await window.orcha.session.send(${JSON.stringify(main.id)}, '/exit'); return true`
    )
    await waitFor(async () => (await session(main.id)).agentExited, 30_000, 'exit detected')
    check(true, 'agent exit detected')
    await screenshot('claude-exited')
    await evaluate(
      `await window.orcha.session.send(${JSON.stringify(main.id)}, 'hello again'); return true`
    )
    await waitFor(
      async () => {
        const s = await session(main.id)
        return !s.agentExited && flat(s.screen).includes('Hellofromthefakeupstream')
      },
      90_000,
      'Claude restarted and answered'
    )
    check(true, 'message after exit restarted Claude')

    // A Codex tab on the Sol budget.
    const codexTab = await evaluate(
      `return await window.orcha.workspaces.create(${JSON.stringify(project.id)}, 'codex-tab', 'gpt-6-sol', null, 'codex')`
    )
    await evaluate(
      `await window.orcha.pty.create(${JSON.stringify(codexTab.id)}, 120, 34); return true`
    )
    await waitFor(
      async () => {
        // Booted = its prompt is up and it has gone quiet.
        const s = await session(codexTab.id)
        return s.outputAgeMs !== null && s.outputAgeMs > 4000 && flat(s.screen).includes('AskCodex')
      },
      90_000,
      'Codex booted'
    )
    await screenshot('codex-booted')
    writeFileSync(join(OUT, 'codex-boot.txt'), (await session(codexTab.id)).screen)
    await evaluate(
      `await window.orcha.session.send(${JSON.stringify(codexTab.id)}, 'ORCHA_SLOW hello codex'); return true`
    )
    await waitFor(
      async () => flat((await session(codexTab.id)).screen).includes('step25'),
      90_000,
      'Codex reply'
    )
    check((await spent('sol')) > 0, 'Sol spend recorded on the relay')
    await screenshot('codex-replied')

    // Mission Control answers (its bundled Claude binary starts from outside app.asar).
    const before = readFileSync(stack.logPath, 'utf8').length
    await evaluate(`await window.orcha.orchestrator.send('Say hi in two words'); return true`)
    const history = await evaluate('return await window.orcha.orchestrator.history()')
    check(
      history.length > 0 && readFileSync(stack.logPath, 'utf8').length > before,
      'Mission Control replied through the relay'
    )

    // Closing the window hides it; the Dock brings the same one back.
    await evaluate('window.close(); return true').catch(() => {})
    await sleep(2000)
    check(!(await state()).windowVisible, 'closing the window hides it')
    check((await session(main.id)).open, 'sessions keep running while hidden')
    execFileSync('open', ['-a', APP])
    await waitFor(async () => (await state()).windowVisible, 15_000, 'window shown again')
    check(true, 'reopening shows the same window')

    // Quit leaves nothing running (no orphan agents billing anyone).
    await evaluate('await window.orcha.smoke.quit(); return true').catch(() => {})
    await waitFor(
      () => spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/Orcha`]).status !== 0,
      30_000,
      'Orcha exited'
    )
    await sleep(2000)
    const orphans = spawnSync('pgrep', ['-fl', 'dangerously'], { encoding: 'utf8' }).stdout.trim()
    check(!orphans, `no agent processes left after quit${orphans ? `: ${orphans}` : ''}`)

    if (NEXT_ZIP) await updaterCheck()
  } catch (err) {
    // What every terminal showed when it went wrong.
    try {
      const last = await state()
      for (const s of last.sessions) {
        writeFileSync(
          join(OUT, `failed-${s.agent}-${s.id.slice(0, 8)}.txt`),
          JSON.stringify({ ...s, screen: undefined }) + '\n\n' + s.screen
        )
      }
      writeFileSync(
        join(OUT, 'failed-activity.json'),
        JSON.stringify({ pings: last.pings, transitions: last.transitions }, null, 2)
      )
      await screenshot('failed')
    } catch {
      // the app is gone
    }
    throw err
  } finally {
    stack.stop()
    try {
      writeFileSync(join(OUT, 'upstream.log'), readFileSync(stack.logPath))
    } catch {
      // no log
    }
    const logFile = join(HOME, 'Library', 'Logs', 'Orcha', 'main.log')
    if (existsSync(logFile)) writeFileSync(join(OUT, 'main.log'), readFileSync(logFile))
  }
}

// A local stand-in for GitHub Releases serving a "v99.0.0" build; clicking
// Update must swap it into /Applications and reopen it.
async function updaterCheck() {
  const zipName = 'Orcha-mac-arm64.zip'
  const sha = createHash('sha256').update(readFileSync(NEXT_ZIP)).digest('hex')
  const feed = createServer((req, res) => {
    if (req.url.startsWith('/releases/latest')) {
      res.writeHead(302, { location: '/releases/tag/v99.0.0' }).end()
    } else if (req.url === '/releases/tag/v99.0.0') {
      res.writeHead(200).end('ok')
    } else if (req.url === '/releases/download/v99.0.0/SHA256SUMS') {
      res.writeHead(200).end(`${sha}  ${zipName}\n`)
    } else if (req.url === `/releases/download/v99.0.0/${zipName}`) {
      res.writeHead(200, { 'content-length': statSync(NEXT_ZIP).size })
      createReadStream(NEXT_ZIP).pipe(res)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => feed.listen(9555, '127.0.0.1', r))
  try {
    launch(['--orcha-update-feed=http://127.0.0.1:9555/releases'])
    await connect()
    await waitFor(
      async () => (await state()).sessions.every((s) => s.activity !== 'working'),
      60_000,
      'sessions idle'
    )
    await waitFor(() => clickButton('Update now'), 60_000, 'update notice')
    await screenshot('update-clicked')
    const version = () =>
      spawnSync(
        'plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', join(APP, 'Contents', 'Info.plist')],
        {
          encoding: 'utf8'
        }
      ).stdout.trim()
    await waitFor(() => version() === '99.0.0', 180_000, 'app replaced with v99')
    check(true, 'update swapped the new version in')
    check(
      spawnSync('codesign', ['--verify', '--deep', '--strict', APP]).status === 0,
      'updated app signature is valid'
    )
    check(
      spawnSync('xattr', ['-p', 'com.apple.quarantine', APP]).status !== 0,
      'updated app carries no quarantine flag'
    )
    await waitFor(
      () => spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/Orcha`]).status === 0,
      30_000,
      'updated app reopened'
    )
    check(true, 'updated app reopened')
    spawnSync('pkill', ['-f', `${APP}/Contents/MacOS/Orcha`])
  } finally {
    feed.close()
  }
}

main()
  .catch((err) => {
    failures.push(err.message)
    log('ERROR', err.stack ?? err.message)
  })
  .finally(async () => {
    log(
      failures.length
        ? `SMOKE FAILED (${failures.length}): ${failures.join(' | ')}`
        : 'SMOKE PASSED'
    )
    process.exit(failures.length ? 1 : 0)
  })
