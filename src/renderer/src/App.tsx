import Sidebar from './components/Sidebar'
import MainPane from './components/MainPane'
import NewWorkspaceModal from './components/NewWorkspaceModal'

function App(): React.JSX.Element {
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-300">
      <Sidebar />
      <MainPane />
      <NewWorkspaceModal />
    </div>
  )
}

export default App
