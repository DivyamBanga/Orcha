import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A stand-in for Ollama in tests: a real HTTP server on 127.0.0.1 that answers
// however the test says, and remembers what it was asked.

export interface FakeRequest {
  method: string
  path: string
  body: Record<string, unknown> | null // the JSON it was sent, if any
}

export type FakeHandler = (req: FakeRequest, res: ServerResponse) => void | Promise<void>

export interface FakeOllama {
  url: string // http://127.0.0.1:<port>
  requests: FakeRequest[]
  close(): Promise<void>
}

// `port` 0 picks a free one; asking for a port a closed server had is how a
// test starts "Ollama" later, in the same place.
export async function fakeOllama(handler: FakeHandler, port = 0): Promise<FakeOllama> {
  const requests: FakeRequest[] = []
  const server = createServer((incoming, res) => {
    const parts: Buffer[] = []
    incoming.on('data', (part: Buffer) => parts.push(part))
    incoming.on('end', () => {
      let body: FakeRequest['body'] = null
      try {
        const text = Buffer.concat(parts).toString()
        body = text ? JSON.parse(text) : null
      } catch {
        // not JSON
      }
      const req = { method: incoming.method ?? 'GET', path: incoming.url ?? '/', body }
      requests.push(req)
      Promise.resolve(handler(req, res)).catch(() => res.destroy())
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    // Open connections are cut, or a client's kept-alive one would hold the
    // server open for seconds.
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// A streamed answer the way Ollama gives one: one JSON object per line.
export function ndjson(res: ServerResponse, lines: object[]): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  for (const line of lines) res.write(JSON.stringify(line) + '\n')
  res.end()
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
