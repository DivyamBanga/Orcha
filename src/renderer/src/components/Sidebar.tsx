function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="flex h-11 items-center border-b border-zinc-800 px-4">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">Orcha</span>
      </div>

      {/* Orchestrator — pinned mission control */}
      <button className="mx-2 mt-2 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-left hover:bg-zinc-800/70">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="font-medium text-zinc-100">Mission Control</span>
      </button>

      <div className="mt-4 flex-1 overflow-y-auto px-2">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
          Workspaces
        </div>
        <div className="px-2 py-6 text-center text-zinc-600">
          No workspaces yet
        </div>
      </div>

      <div className="border-t border-zinc-800 p-2">
        <button className="w-full rounded-md px-3 py-1.5 text-left text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200">
          + Add project
        </button>
        <button className="w-full rounded-md px-3 py-1.5 text-left text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200">
          + New workspace
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
