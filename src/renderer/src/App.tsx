import Sidebar from './components/Sidebar'
import MainPane from './components/MainPane'

function App(): React.JSX.Element {
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-300">
      <Sidebar />
      <MainPane />
    </div>
  )
}

export default App
