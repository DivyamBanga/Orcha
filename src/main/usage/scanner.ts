import { Worker } from 'node:worker_threads'
import {
  defaultDirs,
  mapCwdToProject,
  type FileState,
  type ProjectRef,
  type ScanDirs,
  type ScannedEvent
} from './transcripts'

// The main process's side of usage scanning. Reading transcripts happens in a
// worker thread (transcriptsWorker.ts); this starts it, hands each batch of
// events to the caller, and keeps the worker alive. Nothing here touches a
// transcript, so the main thread only ever sees small batches of finished
// events.

// Sent to the worker when it starts.
export interface WorkerConfig {
  dirs: ScanDirs
  intervalMs: number
  since: number | null
  batchSize: number
  files: Record<string, FileState> // where the last run got to
}

export type ToWorker = { type: 'scan' }

export type FromWorker =
  | {
      type: 'batch'
      events: ScannedEvent[]
      files: Record<string, FileState>
      removed: string[]
    }
  | { type: 'error'; message: string }

// How far the scan has got in each file. The caller keeps these, in the same
// transaction as the events they came with, and passes them back as `files`
// on the next start.
export interface SourceUpdates {
  files: Record<string, FileState>
  removed: string[]
}

export interface ScannerOptions {
  // The built transcriptsWorker file (electron-vite: import it with ?modulePath).
  workerPath: string
  // Called with each batch. If it throws, nothing from the batch counts as
  // delivered: the worker is restarted from the last good positions and the
  // batch comes again.
  onEvents: (events: ScannedEvent[], sources: SourceUpdates) => void
  dirs?: ScanDirs
  // How often to look for new lines. Default 15 s; scanNow() looks right away.
  intervalMs?: number
  // Ignore anything older than this (ms epoch), to bound a first import.
  since?: number | null
  // Positions saved from the last run.
  files?: Record<string, FileState>
  // The projects as they are now; each event's projectId is filled in from its
  // folder before it is delivered.
  projects?: () => ProjectRef[]
  batchSize?: number
  restartMs?: number
  onError?: (message: string) => void
}

export interface Scanner {
  scanNow(): void
  stop(): Promise<void>
}

export function startScanner(options: ScannerOptions): Scanner {
  const intervalMs = options.intervalMs ?? 15_000
  const restartMs = options.restartMs ?? 10_000
  const report = options.onError ?? ((message: string) => console.error(`[usage] ${message}`))
  // Positions the caller has accepted: what a restarted worker picks up from.
  const accepted = new Map(Object.entries(options.files ?? {}))
  let worker: Worker | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let stopped = false

  function withProjects(events: ScannedEvent[]): ScannedEvent[] {
    const projects = options.projects?.() ?? []
    if (projects.length === 0) return events
    const byFolder = new Map<string, string | null>()
    for (const event of events) {
      if (!event.cwd) continue
      if (!byFolder.has(event.cwd)) byFolder.set(event.cwd, mapCwdToProject(event.cwd, projects))
      event.projectId = byFolder.get(event.cwd) ?? null
    }
    return events
  }

  function restartLater(): void {
    worker = null
    if (stopped || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      try {
        launch()
      } catch (err) {
        report(`could not start the usage scanner: ${String(err)}`)
        restartLater()
      }
    }, restartMs)
  }

  function receive(from: Worker, message: FromWorker): void {
    if (from !== worker) return // a worker we already gave up on
    if (message.type === 'error') {
      report(message.message)
      return
    }
    const sources = { files: message.files, removed: message.removed }
    try {
      options.onEvents(withProjects(message.events), sources)
    } catch (err) {
      report(`could not record a batch of usage, will read it again: ${String(err)}`)
      void from.terminate()
      restartLater()
      return
    }
    for (const [path, state] of Object.entries(message.files)) accepted.set(path, state)
    for (const path of message.removed) accepted.delete(path)
  }

  function launch(): void {
    const config: WorkerConfig = {
      dirs: options.dirs ?? defaultDirs(),
      intervalMs,
      since: options.since ?? null,
      batchSize: options.batchSize ?? 2000,
      files: Object.fromEntries(accepted)
    }
    const thread = new Worker(options.workerPath, { workerData: config })
    // Never the reason the app can't quit.
    thread.unref()
    thread.on('message', (message: FromWorker) => receive(thread, message))
    thread.on('error', (err) => report(err.message))
    thread.on('exit', () => {
      if (thread === worker) restartLater()
    })
    worker = thread
  }

  launch()
  return {
    scanNow() {
      worker?.postMessage({ type: 'scan' } satisfies ToWorker)
    },
    async stop() {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      const thread = worker
      worker = null
      await thread?.terminate()
    }
  }
}
