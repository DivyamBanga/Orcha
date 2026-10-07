// What an invite link shows when opened in a browser instead of pasted into
// Orcha: who sent it, where to download Orcha, and how to get the invite into
// it. Self-contained HTML — no scripts beyond copy-to-clipboard.

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export type Visitor = 'windows' | 'mac' | 'phone'

// Phones first: an iPhone's user agent also says "Mac OS X".
export function visitorFrom(userAgent: string): Visitor {
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(userAgent)) return 'phone'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac'
  return 'windows'
}

export function joinPage(opts: {
  link: string
  code: string
  relayOrigin: string
  hostName: string | null
  usable: boolean
  downloadUrl: string
  macDownloadUrl: string
  visitor: Visitor
}): string {
  const host = opts.hostName ? escape(opts.hostName) : 'Someone'
  const copyStep = (title: string, note: string): string => `
        <li>
          <div class="step">${title}</div>
          <div class="copy"><code id="link">${escape(opts.link)}</code><button id="copy">Copy</button></div>
          <div class="note">${note}</div>
        </li>`
  const steps =
    opts.visitor === 'mac'
      ? `
        <li>
          <div class="step">Download Orcha for Mac</div>
          <a class="button" href="${escape(opts.macDownloadUrl)}">Download</a>
          <div class="note">For Macs with Apple silicon (M1 or newer) on macOS 12 or later.</div>
        </li>
        <li>
          <div class="step">Open the download and drag Orcha into Applications</div>
        </li>
        <li>
          <div class="step">Open Orcha once from Applications</div>
          <div class="note">macOS will say it can't check Orcha for malicious software, because Orcha isn't sold through Apple. Click <b>Done</b>, open <b>System Settings → Privacy &amp; Security</b>, scroll down and click <b>Open Anyway</b>, then enter your Mac password. On macOS 14 or older: right-click Orcha → <b>Open</b> → <b>Open</b>. You only do this once.</div>
        </li>
        <li>
          <div class="step">Come back here and connect</div>
          <a class="button" href="${escape(`orcha://join/${opts.code}?relay=${encodeURIComponent(opts.relayOrigin)}`)}">Open in Orcha</a>
          <div class="note">Orcha shows the invite; click <b>Join</b> there. Or copy the link below and paste it into Orcha. The link works once.</div>
          <div class="copy" style="margin-top:10px"><code id="link">${escape(opts.link)}</code><button id="copy">Copy</button></div>
        </li>`
      : opts.visitor === 'phone'
        ? `
        <li>
          <div class="step">Open this link on your computer</div>
          <div class="note">Orcha runs on a Mac or a Windows PC. Send this link to yourself and open it there.</div>
          <div class="copy" style="margin-top:10px"><code id="link">${escape(opts.link)}</code><button id="copy">Copy</button></div>
        </li>`
        : `
        <li>
          <div class="step">Download Orcha for Windows</div>
          <a class="button" href="${escape(opts.downloadUrl)}">Download</a>
          <div class="note">If Windows says “Windows protected your PC”, click <b>More info</b> → <b>Run anyway</b>.</div>
        </li>${copyStep('Open Orcha and paste this invite link', 'Orcha picks it up from your clipboard automatically. The link works once.')}`
  const body = opts.usable
    ? `
      <p class="lead">${host} invited you to Orcha, with Claude and GPT-6 credits ready to use.</p>
      <ol>${steps}
      </ol>`
    : `<p class="lead">This invite link has already been used or has expired. Ask ${host} for a new one.</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orcha invite</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
         background: #0a0a0c; color: #d4d4d8; font: 14px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { width: 100%; max-width: 440px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
           font: 600 18px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; color: #f4f4f5; letter-spacing: -0.02em; }
  .lead { color: #a1a1aa; margin: 0 0 20px; }
  ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; counter-reset: step; }
  li { border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 14px 16px; background: #0f0f12;
       counter-increment: step; }
  .step::before { content: counter(step) "  "; color: #52525b; font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; }
  .step { color: #f4f4f5; font-weight: 500; margin-bottom: 10px; }
  li > .step:last-child { margin-bottom: 0; }
  .button { display: inline-block; background: #f4f4f5; color: #0a0a0c; text-decoration: none; font-weight: 600;
            border-radius: 7px; padding: 7px 16px; }
  .button:hover { background: #fff; }
  .note { color: #71717a; font-size: 12px; margin-top: 10px; }
  .note b { color: #a1a1aa; font-weight: 500; }
  .copy { display: flex; gap: 8px; align-items: center; }
  code { flex: 1; min-width: 0; overflow-wrap: anywhere; font: 12px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; color: #d4d4d8;
         background: #16161a; border: 1px solid rgba(255,255,255,.08); border-radius: 7px; padding: 7px 10px; }
  button { background: transparent; color: #d4d4d8; border: 1px solid rgba(255,255,255,.12); border-radius: 7px;
           padding: 7px 12px; font: inherit; cursor: pointer; }
  button:hover { background: #16161a; }
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="3.25" height="12" rx="1" fill="#f4f4f5"/><rect x="6.25" y="2" width="8.25" height="12" rx="1" fill="#f4f4f5"/></svg>
    orcha
  </div>
  ${body}
</main>
<script>
  const b = document.getElementById('copy')
  if (b) b.onclick = () => navigator.clipboard.writeText(document.getElementById('link').textContent).then(() => { b.textContent = 'Copied' })
</script>
</body>
</html>`
}
