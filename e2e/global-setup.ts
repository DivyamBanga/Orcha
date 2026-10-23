import { spawnSync } from 'node:child_process'

// The tests drive the built app (out/), so build it once up front. Set
// ORCHA_E2E_SKIP_BUILD=1 to reuse an existing build.
export default function globalSetup(): void {
  if (process.env.ORCHA_E2E_SKIP_BUILD) return
  const r = spawnSync('npx electron-vite build', { stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error('electron-vite build failed')
}
