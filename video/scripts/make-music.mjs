// Procedural soundtrack for the Orcha intro — dark minimal techno at 120 BPM,
// synthesized to the picture: every scene cut (3.0, 7.5, 12.5, 17.5, 21.0,
// 25.0, 29.5s) sits exactly on a beat and gets a riser into it + an impact on
// it. Pure Node → 16-bit stereo WAV at public/audio.wav. No samples, no
// licenses, fully deterministic.
// Run: node scripts/make-music.mjs
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const SR = 44100
const DUR = 35
const N = SR * DUR
const CUTS = [3.0, 7.5, 12.5, 17.5, 21.0, 25.0, 29.5]
const BEAT = 0.5 // 120 BPM
const GROOVE_START = 3.0
const GROOVE_END = 29.5
const TENSION = [17.5, 19.5] // the "needs you" strip-down

const L = new Float64Array(N)
const R = new Float64Array(N)

// deterministic noise
let seed = 0x9e3779b9
const rand = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed >>>= 0
  return seed / 0xffffffff - 0.5
}

// add a rendered voice into the mix at time t (seconds), pan -1..1
function add(t, samples, gain, pan = 0) {
  const start = Math.round(t * SR)
  const gl = gain * Math.min(1, 1 - pan)
  const gr = gain * Math.min(1, 1 + pan)
  for (let i = 0; i < samples.length; i++) {
    const idx = start + i
    if (idx < 0 || idx >= N) continue
    L[idx] += samples[i] * gl
    R[idx] += samples[i] * gr
  }
}

const seconds = (s) => new Float64Array(Math.round(s * SR))

// --- voices ------------------------------------------------------------------

function kick(punch = 1) {
  const out = seconds(0.3)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const freq = 44 + 110 * Math.exp(-t * 30) * punch
    phase += (2 * Math.PI * freq) / SR
    const click = t < 0.004 ? (1 - t / 0.004) * 0.6 : 0
    out[i] = Math.tanh(Math.sin(phase) * 2.2) * Math.exp(-t * 15) + click * rand()
  }
  return out
}

function boom() {
  const out = seconds(0.9)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const freq = 40 + 40 * Math.exp(-t * 18)
    phase += (2 * Math.PI * freq) / SR
    out[i] = Math.tanh(Math.sin(phase) * 2.5) * Math.exp(-t * 5)
  }
  return out
}

function hat(open = false) {
  const len = open ? 0.14 : 0.045
  const out = seconds(len)
  let hp = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const n = rand()
    hp = 0.82 * hp + n - (i > 0 ? 0 : 0) // crude high-pass memory
    out[i] = (n - hp * 0.9) * Math.exp(-t * (open ? 28 : 90))
  }
  return out
}

function blip(freq) {
  const out = seconds(0.11)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 38) * (1 - Math.exp(-t * 900))
  }
  return out
}

function bassPulse(freq, len = 0.21) {
  const out = seconds(len)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const body = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2 * t)
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 9)
    out[i] = Math.tanh(body * 1.6) * env
  }
  return out
}

function riser(len = 1.2) {
  const out = seconds(len)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const p = t / len
    const freq = 150 + 950 * p * p
    phase += (2 * Math.PI * freq) / SR
    out[i] = (rand() * 0.8 + Math.sin(phase) * 0.45) * p * p
  }
  return out
}

function splash() {
  const out = seconds(0.22)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = rand() * Math.exp(-t * 26)
  }
  return out
}

// slow drone: detuned root + fifth, breathing
function drone(len, root = 110) {
  const out = seconds(len)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const env = Math.min(1, t / 1.2) * Math.min(1, (len - t) / 1.6)
    const breathe = 0.8 + 0.2 * Math.sin((2 * Math.PI * t) / 4)
    out[i] =
      (Math.sin(2 * Math.PI * root * t) +
        Math.sin(2 * Math.PI * root * 1.006 * t) +
        0.5 * Math.sin(2 * Math.PI * root * 1.5 * t)) *
      env *
      breathe *
      0.33
  }
  return out
}

// --- arrangement -------------------------------------------------------------

const inTension = (t) => t >= TENSION[0] && t < TENSION[1]

// intro + outro drones
add(0, drone(3.6, 110), 0.16)
add(GROOVE_END, drone(DUR - GROOVE_END - 0.6, 110), 0.2)

// kick grid: four-on-floor across the groove, softened in the tension bar
for (let t = GROOVE_START; t < GROOVE_END - 1e-9; t += BEAT) {
  add(t, kick(), inTension(t) ? 0.5 : 0.95)
}

// offbeat hats, 16ths in the busier sections; skipped in tension
for (let t = GROOVE_START; t < GROOVE_END; t += BEAT) {
  if (inTension(t)) continue
  add(t + BEAT / 2, hat(), 0.3, 0.25)
  const busy = (t >= 12.5 && t < 17.5) || (t >= 21 && t < 29.5)
  if (busy) {
    add(t + BEAT / 4, hat(), 0.13, -0.35)
    add(t + (3 * BEAT) / 4, hat(), 0.13, -0.35)
  }
}
// open hat marking every bar (2s) in the full-energy stretches
for (let t = 7.5; t < GROOVE_END; t += 2) {
  if (inTension(t)) continue
  add(t + BEAT, hat(true), 0.2, 0.4)
}

// sub bass: 8th-note pulses walking A1 / G1 / C2, ducked right after kicks
const CHORDS = [55, 55, 49, 65.4] // A1 A1 G1 C2, one per bar
for (let t = GROOVE_START; t < GROOVE_END - 1e-9; t += BEAT / 2) {
  if (inTension(t)) continue
  const bar = Math.floor((t - GROOVE_START) / 2)
  const freq = CHORDS[bar % 4]
  const onKick = Math.abs(t / BEAT - Math.round(t / BEAT)) < 1e-6
  add(t, bassPulse(freq), onKick ? 0.22 : 0.42)
}

// sparkle arp in second half of the groove sections
const ARP = [220, 330, 440, 660, 550, 440, 330, 275]
let step = 0
for (let t = 7.5; t < GROOVE_END; t += BEAT / 2) {
  if (inTension(t) || (t >= 17.5 && t < 21)) continue
  const freq = ARP[step++ % ARP.length]
  const pan = step % 2 === 0 ? 0.45 : -0.45
  add(t, blip(freq), 0.09, pan)
  add(t + 0.375, blip(freq * 2), 0.03, -pan) // echo
}

// risers into every cut, impact on every cut
for (const cut of CUTS) {
  add(cut - 1.2, riser(1.2), 0.3)
  add(cut, boom(), 0.85)
  add(cut, splash(), 0.4)
  add(cut, kick(1.2), 0.9)
}
// the wordmark lands in the outro
add(30.5, boom(), 0.6)
add(30.5, splash(), 0.2)

// --- master ------------------------------------------------------------------

let peak = 0
for (let i = 0; i < N; i++) {
  // gentle glue + fade-out tail
  const t = i / SR
  const fade = t > 33.6 ? Math.max(0, 1 - (t - 33.6) / 1.2) : 1
  L[i] = Math.tanh(L[i] * 1.15) * fade
  R[i] = Math.tanh(R[i] * 1.15) * fade
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
}
const norm = 0.89 / peak

const data = Buffer.alloc(N * 4)
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(L[i] * norm * 32767), i * 4)
  data.writeInt16LE(Math.round(R[i] * norm * 32767), i * 4 + 2)
}
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(2, 22) // stereo
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 4, 28)
header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio.wav')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([header, data]))
console.log(`wrote ${out} — ${DUR}s @ 120 BPM, impacts at ${CUTS.join(', ')}s`)
