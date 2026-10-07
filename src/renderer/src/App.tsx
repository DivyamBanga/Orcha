import { useEffect, useState } from 'react'
import BootReveal from './components/BootReveal'
import Sidebar from './components/Sidebar'
import MainPane from './components/MainPane'
import NewProjectModal from './components/NewProjectModal'
import NewSessionModal from './components/NewSessionModal'
import LinkModal from './components/LinkModal'
import SettingsModal from './components/SettingsModal'
import UsageDashboard from './components/UsageDashboard'
import CreditsDashboard from './components/CreditsDashboard'
import Notices from './components/Notices'
import Onboarding from './components/Onboarding'
import { wireIpc } from './wireIpc'
import { useStore, useIsGuest } from './store'
import { poolLevel, usd } from './money'

function App(): React.JSX.Element {
  const setup = useStore((s) => s.setup)
  const guest = useStore((s) => s.guest)
  const projects = useStore((s) => s.projects)
  const isGuest = useIsGuest()
  // Drives the opening reveal: it stays shut until there is something real
  // behind it. Local rather than in the store since nothing else needs it.
  const [loaded, setLoaded] = useState(false)
  // Whether first-run setup was finished on this machine (either path).
  const [onboarded, setOnboarded] = useState(false)

  useEffect(() => wireIpc(), [])

  useEffect(() => {
    const s = useStore.getState()
    s.checkSetup()
    Promise.all([s.load(), s.loadGuest(), window.orcha.ui.getState('onboarded')]).then(
      async ([, , done]) => {
        setOnboarded(done === '1')
        // Awaited so the restored tab is set before the curtain parts — the
        // reveal should uncover it, not have it pop in mid-animation.
        await s.restoreOpenSessions()
        setLoaded(true)
      }
    )
  }, [])

  // Usage — polled here (not per-workspace) so the sidebar's glance widget
  // stays live no matter which tab is focused. Skipped while the window is
  // hidden and refreshed on return. A host polls their plan limits (rate
  // limited upstream, so once a minute); a guest polls their budgets on the
  // relay, often enough that each tab's cost ticks along while it works.
  useEffect(() => {
    if (guest === null) return
    const refresh = (): void => {
      const s = useStore.getState()
      const load = guest.paired ? s.loadGuestBalance() : s.loadUsageSummary()
      load.catch(() => {})
    }
    refresh()
    const interval = setInterval(
      () => {
        if (document.visibilityState === 'visible') refresh()
      },
      guest.paired ? 15_000 : 60_000
    )
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [guest])

  // Budget warnings at 80% and 95% used, and a notice when one runs out —
  // each shown once per level per budget size, so a top-up re-arms them.
  const balance = useStore((s) => s.guestBalance)
  useEffect(() => {
    if (!balance || balance.error) return
    const s = useStore.getState()
    for (const pool of balance.pools) {
      const level = poolLevel(pool)
      if (level === 'ok') continue
      const key = `warned:${pool.pool}`
      const mark = `${pool.cap}:${level}`
      window.orcha.ui
        .getState(key)
        .then((seen) => {
          if (seen === mark) return
          window.orcha.ui.saveState(key, mark).catch(() => {})
          const left = Math.max(pool.cap - pool.spent, 0)
          s.pushNotice({
            id: key,
            tone: level === 'low' ? 'warn' : 'danger',
            text:
              level === 'empty'
                ? `Your ${pool.label} budget is used up. Ask ${balance.hostName} to top it up.`
                : `${pool.label}: ${usd(left)} left of ${usd(pool.cap)} (${Math.round((pool.spent / pool.cap) * 100)}% used).`
          })
        })
        .catch(() => {})
    }
  }, [balance])

  // A file dropped anywhere but a terminal would otherwise navigate the whole
  // app to that file, which looks exactly like a crash.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // Ctrl+1..9 jumps to a session (0 = Mission Control); ⌘ on a Mac, where
  // Ctrl belongs to the terminal.
  useEffect(() => {
    const mac = window.orcha.platform === 'darwin'
    const onKey = (e: KeyboardEvent): void => {
      if ((mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || e.altKey) return
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

  // A guest is in once onboarding (which ends with their tools installed) is
  // done. A host is in once GitHub and Claude are connected — an existing
  // install with projects never sees onboarding at all.
  const checking = setup === null || guest === null || !loaded
  const ready = isGuest
    ? onboarded
    : setup !== null && setup.gh && setup.claude && (onboarded || projects.length > 0)

  const finishOnboarding = (): void => {
    window.orcha.ui.saveState('onboarded', '1').catch(() => {})
    setOnboarded(true)
  }

  return (
    <>
      <div className="flex h-full bg-surface-0 text-zinc-300">
        {checking ? (
          <div className="flex-1" />
        ) : ready ? (
          <>
            <Sidebar />
            <MainPane />
            <NewProjectModal />
            <NewSessionModal />
            <LinkModal />
            <SettingsModal />
            {isGuest ? <CreditsDashboard /> : <UsageDashboard />}
            <Notices />
          </>
        ) : (
          <Onboarding onDone={finishOnboarding} />
        )}
      </div>
      <BootReveal ready={!checking} />
    </>
  )
}

export default App
