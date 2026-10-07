import { app, protocol } from 'electron'

// Where artifacts run: a page on its own orcha-artifact:// origin, loaded in
// a sandboxed iframe (scripts only: no popups, no navigation, no access to
// Orcha or this computer). It's handed an artifact by postMessage and draws
// it: HTML as a page, SVG as an image, Mermaid as a diagram, React through
// sucrase with a fixed set of libraries. Libraries come from two CDNs at
// pinned versions (one map, below) rather than shipping in the app; chat
// needs the network anyway. Its CSP allows those CDNs and nothing else to
// load or connect.

// One React for everything: libraries that use it are pinned to the same one.
const REACT = 'deps=react@18.3.1,react-dom@18.3.1'
const LIBS = {
  react: 'https://esm.sh/react@18.3.1',
  'react-dom': 'https://esm.sh/react-dom@18.3.1',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
  recharts: `https://esm.sh/recharts@2.15.0?${REACT}`,
  'lucide-react': `https://esm.sh/lucide-react@0.468.0?${REACT}`,
  d3: 'https://esm.sh/d3@7.9.0',
  three: 'https://esm.sh/three@0.170.0',
  lodash: 'https://esm.sh/lodash@4.17.21',
  papaparse: 'https://esm.sh/papaparse@5.4.1'
}
const SUCRASE = 'https://esm.sh/sucrase@3.35.0'
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs'
const TAILWIND = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.0.0'

// What generated pages may load: the pinned CDNs, plus the ones hand-written
// HTML pages commonly pull from.
const CDNS = [
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.tailwindcss.com'
].join(' ')
const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src data: ${CDNS} https://fonts.gstatic.com`,
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  `connect-src ${CDNS}`
].join('; ')

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: LIBS })}</script>
<style>
  html, body { margin: 0; min-height: 100%; background: #fff; color: #18181b;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .orcha-center { display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .orcha-center > svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
const send = (message) => parent.postMessage(message, '*')
const fail = (err) => send({ type: 'error', message: String(err && err.message ? err.message : err) })
window.addEventListener('error', (e) => fail(e.error || e.message))
window.addEventListener('unhandledrejection', (e) => fail(e.reason))
const tailwind = () =>
  new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = ${JSON.stringify(TAILWIND)}
    s.onload = s.onerror = resolve
    document.head.appendChild(s)
  })

async function render({ kind, content, dark }) {
  const root = document.getElementById('root')
  if (kind === 'text/html') {
    document.open()
    document.write(content)
    document.close()
  } else if (kind === 'image/svg+xml') {
    root.className = 'orcha-center'
    root.innerHTML = content
  } else if (kind === 'application/vnd.mermaid') {
    const { default: mermaid } = await import(${JSON.stringify(MERMAID)})
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
    const { svg } = await mermaid.render('orcha-diagram', content)
    if (dark) document.body.style.background = '#09090b'
    root.className = 'orcha-center'
    root.innerHTML = svg
  } else if (kind === 'application/vnd.react') {
    const [{ transform }] = await Promise.all([import(${JSON.stringify(SUCRASE)}), tailwind()])
    let code = transform(content, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'classic',
      production: true
    }).code
    if (!/import\\s+React\\b/.test(code)) code = "import React from 'react';\\n" + code
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const [mod, React, ReactDOM] = await Promise.all([import(url), import('react'), import('react-dom/client')])
    const App = mod.default
    if (typeof App !== 'function') throw new Error('The component needs a default export.')
    // React keeps an error while drawing to itself; this catches it and
    // reports it like any other.
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        fail(error)
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }
    ReactDOM.createRoot(root).render(
      React.createElement(Boundary, null, React.createElement(App))
    )
  }
  send({ type: 'rendered' })
}

window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || e.data.type !== 'render') return
  render(e.data).catch(fail)
})
send({ type: 'ready' })
</script>
</body>
</html>`

export function serveArtifacts(): void {
  protocol.handle(
    'orcha-artifact',
    () =>
      new Response(PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }
      })
  )
  // Nothing in an artifact may take its frame (or the window) somewhere
  // else; links meant for the browser open there instead.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) return
      if (
        event.frame?.url.startsWith('orcha-artifact:') &&
        !event.url.startsWith('orcha-artifact:')
      ) {
        event.preventDefault()
      }
    })
  })
}
