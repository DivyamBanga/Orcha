import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import MainPane from './components/MainPane'
import NewWorkspaceModal from './components/NewWorkspaceModal'
import { wireIpc } from './wireIpc'
import { useStore } from './store'

function App(): React.JSX.Element {
  useEffect(() => wireIpc(), [])

  // Ctrl+1..9 jumps to a workspace (0 = Mission Control), Ctrl+T flips Chat/Terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const s = useStore.getState()
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        if (s.activeWorkspaceId && s.activeWorkspaceId !== 'orchestrator') {
          s.setActiveTab(s.activeTab === 'chat' ? 'terminal' : 'chat')
        }
      } else if (e.key === '0') {
        e.preventDefault()
        s.setActiveWorkspace('orchestrator')
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const ws = s.workspaces[Number(e.key) - 1]
        if (ws) s.setActiveWorkspace(ws.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="flex h-full bg-surface-0 text-zinc-300">
      <Sidebar />
      <MainPane />
      <NewWorkspaceModal />
    </div>
  )
}

export default App
