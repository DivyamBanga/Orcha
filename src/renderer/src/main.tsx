import './styles/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ArtifactWindow, PrintView } from './components/chat/Windows'

// Light or dark, decided before the first paint so the window never flashes
// the other one. prefers-color-scheme follows the app's chosen theme (main
// sets nativeTheme from Settings → Appearance), which itself defaults to the
// system's, so this one listener covers both.
const html = document.documentElement
html.classList.add(`platform-${window.orcha.platform}`)
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  html.dataset.theme = dark.matches ? 'dark' : 'light'
}
applyTheme()
dark.addEventListener('change', applyTheme)

// The same bundle draws the other windows: an artifact popped out, and a
// chat laid out for print.
const query = new URLSearchParams(location.search)
const popout = query.get('popout')
const print = query.get('print')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popout ? <ArtifactWindow id={popout} /> : print ? <PrintView chatId={print} /> : <App />}
  </StrictMode>
)
