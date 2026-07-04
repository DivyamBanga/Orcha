import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import MainPane from './components/MainPane'
import NewProjectModal from './components/NewProjectModal'
import NewSessionModal from './components/NewSessionModal'
import SetupGate from './components/SetupGate'
import { wireIpc } from './wireIpc'
import { useStore } from './store'

function App(): React.JSX.Element {
  const setup = useStore((s) => s.setup)

  useEffect(() => wireIpc(), [])

  useEffect(() => {
    const s = useStore.getState()
    s.checkSetup()
    s.load().then(() => s.restoreOpenSessions())
  }, [])

  // Ctrl+1..9 jumps to a session (0 = Mission Control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const s = useStore.getState()
      if (e.key === '0') {
        e.preventDefault()
        s.setActive('orchestrator')
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const ws = s.workspaces[Number(e.key) - 1]
        if (ws) s.setActive(ws.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ready = setup !== null && setup.gh && setup.claude

  return (
    <div className="flex h-full bg-surface-0 text-zinc-300">
      {ready ? (
        <>
          <Sidebar />
          <MainPane />
          <NewProjectModal />
          <NewSessionModal />
        </>
      ) : setup === null ? (
        <div className="flex flex-1 items-center justify-center font-mono text-zinc-700">
          checking connections…
        </div>
      ) : (
        <SetupGate />
      )}
    </div>
  )
}

export default App
