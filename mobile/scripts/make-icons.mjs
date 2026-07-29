// Generates the Android app icons from Orcha's "Thirds" mark — two rounded
// panes (x=1.5 w=3.25 and x=6.25 w=8.25, y=2 h=12, rx=1 on a 16-unit box),
// white on the #14141a tile. Pure Node (zlib → PNG chunks), analytic
// rounded-rect coverage with 4×4 supersampling — no image library needed.
// Run: node scripts/make-icons.mjs  (from mobile/)
import { deflateSync } from 'zlib'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
mkdirSync(OUT, { recursive: true })

// --- PNG writing -------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crc])
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- mark geometry -----------------------------------------------------------

const PANES = [
  { x: 1.5, y: 2, w: 3.25, h: 12, r: 1 },
  { x: 6.25, y: 2, w: 8.25, h: 12, r: 1 }
]
const VIEW = 16

function insideRoundRect(u, v, { x, y, w, h, r }) {
  if (u < x || u > x + w || v < y || v > y + h) return false
  const cx = Math.max(x + r, Math.min(u, x + w - r))
  const cy = Math.max(y + r, Math.min(v, y + h - r))
  const inX = u >= x + r && u <= x + w - r
  const inY = v >= y + r && v <= y + h - r
  if (inX || inY) return true
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r
}

// Coverage of the mark at output pixel (px, py), 4×4 supersampled.
function coverage(px, py, offset, scale) {
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const u = (px + (sx + 0.5) / 4 - offset) / scale
      const v = (py + (sy + 0.5) / 4 - offset) / scale
      if (PANES.some((p) => insideRoundRect(u, v, p))) hits++
    }
  }
  return hits / 16
}

// bg null = transparent output (white mark with alpha).
function render(size, markFrac, bg) {
  const markPx = size * markFrac
  const scale = markPx / VIEW
  const offset = (size - markPx) / 2
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, offset, scale)
      const i = (y * size + x) * 4
      if (bg) {
        out[i] = Math.round(bg[0] + (255 - bg[0]) * a)
        out[i + 1] = Math.round(bg[1] + (255 - bg[1]) * a)
        out[i + 2] = Math.round(bg[2] + (255 - bg[2]) * a)
        out[i + 3] = 255
      } else {
        out[i] = 255
        out[i + 1] = 255
        out[i + 2] = 255
        out[i + 3] = Math.round(255 * a)
      }
    }
  }
  return png(size, size, out)
}

const TILE = [0x14, 0x14, 0x1a]

writeFileSync(join(OUT, 'icon.png'), render(1024, 0.58, TILE))
writeFileSync(join(OUT, 'adaptive-icon.png'), render(1024, 0.44, null))
writeFileSync(join(OUT, 'notification-icon.png'), render(96, 0.8, null))
console.log('wrote icon.png, adaptive-icon.png, notification-icon.png to', OUT)
