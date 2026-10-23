import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

// Reads a growing JSON Lines file (a Claude Code transcript, a Codex rollout)
// from a saved position, one complete line at a time. A transcript can be
// hundreds of megabytes and one line can be several (a pasted file, an image),
// so the file is read in chunks and only the lines the caller cares about are
// ever turned into strings.

export const CHUNK_BYTES = 1 << 20
// A line longer than this is skipped unread rather than held in memory.
export const MAX_LINE_BYTES = 64 << 20

export interface ReadLimits {
  chunkBytes: number
  maxLineBytes: number
}

export interface ReadResult {
  // Where the first line not yet handled begins: everything before it is done.
  // Short of `size` when the file ends in a half-written line.
  offset: number
  // How far into the file this read looked. The next scan has nothing to do
  // while the file is still this size.
  size: number
  bytesRead: number
}

// Lines in data[0, end), which ends just after a newline. With a needle, only
// lines containing it are decoded: finding the next hit is one native search,
// where splitting every line first would copy the whole file. Returns how many
// bytes were consumed (all of them unless `onLine` asked to stop).
function eachLine(
  buf: Buffer,
  end: number,
  needle: Buffer | null,
  onLine: (line: string) => boolean
): number {
  const data = buf.subarray(0, end)
  let pos = 0
  while (pos < end) {
    let start = pos
    let stop: number
    if (needle) {
      const hit = data.indexOf(needle, pos)
      if (hit === -1) return end
      start = data.lastIndexOf(0x0a, hit) + 1
      stop = data.indexOf(0x0a, hit)
    } else {
      stop = data.indexOf(0x0a, pos)
    }
    pos = stop + 1
    if (onLine(data.toString('utf8', start, stop))) return pos
  }
  return end
}

// Calls `onLine` for each complete line from byte `from` to the end of the
// file as it is now, in order. `onLine` returns true to stop after that line
// (the caller's budget is spent); the result then says where to resume.
export function readLines(
  path: string,
  from: number,
  needle: Buffer | null,
  onLine: (line: string) => boolean,
  limits: ReadLimits
): ReadResult {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    // Shorter than where we were: the file was replaced between the caller's
    // look and ours. Report an empty position so the next scan starts over.
    if (size < from) return { offset: 0, size: 0, bytesRead: 0 }

    let buf = Buffer.allocUnsafe(Math.max(1, Math.min(limits.chunkBytes, size - from)))
    let have = 0 // bytes held in buf: a half line carried over, then fresh data
    let offset = from // file position of buf[0]; everything before it is done
    let bytesRead = 0
    let dropping = false // inside a line too long to keep, discarding up to its newline
    let stopped = false

    while (!stopped && offset + have < size) {
      if (have === buf.length) {
        // One line is longer than the buffer: make room, or give the line up.
        if (buf.length >= limits.maxLineBytes) {
          offset += have
          have = 0
          dropping = true
        } else {
          const bigger = Buffer.allocUnsafe(Math.min(buf.length * 2, limits.maxLineBytes))
          buf.copy(bigger, 0, 0, have)
          buf = bigger
        }
      }
      const room = Math.min(buf.length - have, size - offset - have)
      const n = readSync(fd, buf, have, room, offset + have)
      if (n <= 0) break
      bytesRead += n
      have += n

      if (dropping) {
        const newline = buf.subarray(0, have).indexOf(0x0a)
        if (newline === -1) {
          offset += have
          have = 0
          continue
        }
        buf.copy(buf, 0, newline + 1, have)
        offset += newline + 1
        have -= newline + 1
        dropping = false
      }

      const whole = buf.subarray(0, have).lastIndexOf(0x0a) + 1
      if (whole === 0) continue
      const used = eachLine(buf, whole, needle, (line) => {
        stopped = onLine(line)
        return stopped
      })
      buf.copy(buf, 0, used, have)
      offset += used
      have -= used
    }
    // When stopped early the rest of the file is unread, so don't claim it was seen.
    return { offset, size: stopped ? offset : size, bytesRead }
  } finally {
    closeSync(fd)
  }
}
