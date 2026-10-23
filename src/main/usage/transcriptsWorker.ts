import { parentPort, workerData } from 'node:worker_threads'
import type { FromWorker, ToWorker, WorkerConfig } from './scanner'
import { newScanState, scanAll } from './transcripts'

// The scanner's side of the thread (see scanner.ts for the other): scan, send
// what was found, wait, repeat. All the reading happens here, so the main
// thread never touches a transcript.

if (!parentPort) throw new Error('transcriptsWorker runs as a worker thread')
const port = parentPort
const config = workerData as WorkerConfig
const state = newScanState(config.files)
let timer: NodeJS.Timeout | null = null

function send(message: FromWorker): void {
  port.postMessage(message)
}

function cycle(): void {
  if (timer) clearTimeout(timer)
  try {
    const limits = { since: config.since, maxEvents: config.batchSize }
    scanAll(config.dirs, state, limits, ({ events, files, removed }) => {
      send({ type: 'batch', events, files, removed })
    })
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  timer = setTimeout(cycle, config.intervalMs)
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'scan') cycle()
})
cycle()
