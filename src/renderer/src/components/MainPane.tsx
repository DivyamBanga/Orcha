function MainPane(): React.JSX.Element {
  return (
    <main className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <div className="text-lg font-medium text-zinc-500">No workspace selected</div>
        <div className="mt-1 text-zinc-600">
          Add a project, then create a workspace to start a session
        </div>
      </div>
    </main>
  )
}

export default MainPane
