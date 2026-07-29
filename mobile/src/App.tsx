import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, BackHandler, Platform, StatusBar as RNStatusBar, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { Api, clearPairing, loadPairing, probePairing, savePairing } from './api'
import { setupPush } from './push'
import { C } from './theme'
import PairingScreen from './screens/Pairing'
import Fleet from './screens/Fleet'
import Session from './screens/Session'
import TermPeek from './screens/TermPeek'
import DispatchSheet from './screens/DispatchSheet'
import type { FleetPayload, FleetProject, NextStep, Pairing } from './types'

type Route = { name: 'fleet' } | { name: 'session'; id: string } | { name: 'term'; id: string }

export default function App(): React.JSX.Element {
  // undefined = still loading storage; null = not paired yet.
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined)
  const [fleet, setFleet] = useState<FleetPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [route, setRoute] = useState<Route>({ name: 'fleet' })
  const [dispatchTarget, setDispatchTarget] = useState<{
    project: FleetProject
    prefill: NextStep | null
  } | null>(null)
  const [regenInflight, setRegenInflight] = useState<string | null>(null)

  const api = useMemo(() => (pairing ? new Api(pairing) : null), [pairing])
  const apiRef = useRef<Api | null>(null)
  apiRef.current = api

  // First launch: if this APK was built on the PC it pairs with, the pairing
  // is baked into the build — connect silently, no QR needed. The scan screen
  // is the fallback for a moved PC or a build from someone else's machine.
  useEffect(() => {
    loadPairing().then(async (stored) => {
      if (stored) {
        setPairing(stored)
        return
      }
      const baked = (
        Constants.expoConfig?.extra as
          | { defaultPairing?: { urls?: string[]; token?: string } }
          | undefined
      )?.defaultPairing
      if (Array.isArray(baked?.urls) && baked.urls.length > 0 && baked.token) {
        const fresh = await probePairing(baked.urls, baked.token)
        if (fresh) {
          await savePairing(fresh)
          setPairing(fresh)
          return
        }
      }
      setPairing(null)
    })
  }, [])

  const refresh = useCallback((manual = false): void => {
    const current = apiRef.current
    if (!current) return
    if (manual) setRefreshing(true)
    current
      .fleet()
      .then((payload) => {
        setFleet(payload)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => manual && setRefreshing(false))
  }, [])

  // Live updates: the PC pushes invalidations over a websocket; refetch on
  // any of them (debounced), reconnect when the app comes back to the
  // foreground, and keep a slow poll as the fallback.
  useEffect(() => {
    if (!api) return
    let ws: WebSocket | null = null
    let closed = false
    let debounce: ReturnType<typeof setTimeout> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = (): void => {
      if (closed) return
      try {
        ws = new WebSocket(api.eventsUrl())
        ws.onmessage = () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => refresh(), 300)
        }
        ws.onclose = () => {
          if (!closed) retry = setTimeout(connect, 5000)
        }
        ws.onerror = () => ws?.close()
      } catch {
        retry = setTimeout(connect, 5000)
      }
    }

    connect()
    refresh()
    const poll = setInterval(() => refresh(), 30_000)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh()
        if (!ws || ws.readyState === WebSocket.CLOSED) connect()
      }
    })
    return () => {
      closed = true
      sub.remove()
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      if (retry) clearTimeout(retry)
      ws?.close()
    }
  }, [api, refresh])

  // Register for push once paired; failures are non-fatal (app still works).
  useEffect(() => {
    if (!api) return
    setupPush().then(({ token }) => {
      if (token) api.registerDevice(token).catch(() => {})
    })
  }, [api])

  // Notification actions: inline reply answers the session directly; a plain
  // tap deep-links to it.
  useEffect(() => {
    const handle = (response: Notifications.NotificationResponse): void => {
      const data = response.notification.request.content.data as { sessionId?: string }
      const sessionId = data?.sessionId
      if (!sessionId) return
      if (response.actionIdentifier === 'reply' && response.userText?.trim()) {
        apiRef.current?.answerText(sessionId, response.userText.trim()).catch(() => {})
      } else {
        setRoute({ name: 'session', id: sessionId })
      }
    }
    const sub = Notifications.addNotificationResponseReceivedListener(handle)
    Notifications.getLastNotificationResponseAsync().then((last) => {
      if (last) handle(last)
    })
    return () => sub.remove()
  }, [])

  // Android back: term → session → fleet.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dispatchTarget) {
        setDispatchTarget(null)
        return true
      }
      if (route.name === 'term') {
        setRoute({ name: 'session', id: route.id })
        return true
      }
      if (route.name === 'session') {
        setRoute({ name: 'fleet' })
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [route, dispatchTarget])

  const regenSteps = (projectId: string): void => {
    if (!api || regenInflight) return
    setRegenInflight(projectId)
    api
      .regenNextSteps(projectId)
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setRegenInflight(null))
  }

  const unpair = (): void => {
    void clearPairing()
    setPairing(null)
    setFleet(null)
    setRoute({ name: 'fleet' })
  }

  const topPad = Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0

  const fleetView = (
    <Fleet
      fleet={fleet}
      error={error}
      refreshing={refreshing}
      onRefresh={() => refresh(true)}
      onOpenSession={(id) => setRoute({ name: 'session', id })}
      onDispatch={(project, prefill) => setDispatchTarget({ project, prefill })}
      onRegenSteps={regenSteps}
      regenInflight={regenInflight}
      onUnpair={unpair}
    />
  )

  let screen: React.JSX.Element
  if (pairing === undefined) {
    screen = <View style={{ flex: 1, backgroundColor: C.bg }} />
  } else if (!pairing || !api) {
    screen = (
      <PairingScreen
        onPaired={(fresh) => {
          void savePairing(fresh)
          setPairing(fresh)
        }}
      />
    )
  } else if (route.name !== 'fleet') {
    const id = route.id
    const project = fleet?.projects.find((p) => p.sessions.some((s) => s.id === id))
    const session = project?.sessions.find((s) => s.id === id)
    if (!fleet) {
      // Cold start from a notification: keep the deep link while the first
      // fleet fetch is in flight.
      screen = <View style={{ flex: 1, backgroundColor: C.bg }} />
    } else if (!project || !session) {
      // Session vanished (archived/closed) — fall back home. Render-phase
      // state adjustment, same pattern as the desktop's MainPane.
      screen = fleetView
      setRoute({ name: 'fleet' })
    } else if (route.name === 'term') {
      screen = (
        <TermPeek
          url={api.termUrl(id)}
          title={`${project.name} · ${session.name}`}
          onBack={() => setRoute({ name: 'session', id })}
        />
      )
    } else {
      screen = (
        <Session
          api={api}
          session={session}
          projectName={project.name}
          onBack={() => setRoute({ name: 'fleet' })}
          onOpenTerm={() => setRoute({ name: 'term', id })}
        />
      )
    }
  } else {
    screen = fleetView
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: topPad }}>
      <StatusBar style="light" />
      {screen}
      {dispatchTarget && api && (
        <DispatchSheet
          api={api}
          project={dispatchTarget.project}
          prefill={dispatchTarget.prefill}
          onClose={() => setDispatchTarget(null)}
          onDispatched={() => refresh()}
        />
      )}
    </View>
  )
}
