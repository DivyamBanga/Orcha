import { accessSync, constants } from 'fs'
import { delimiter, isAbsolute, join } from 'path'

// Platform helpers with no Electron import, so they can be unit-tested.

export const SHELL_ENV_SENTINEL = '__ORCHA_ENV__'

// PATH entries in order with duplicates dropped (first one wins).
export function mergePath(dirs: (string | undefined)[], sep: string = delimiter): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs.flatMap((d) => (d ?? '').split(sep))) {
    const clean = dir.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out.join(sep)
}

// The login shell prints `<sentinel>\0PATH\0LANG\0LC_ALL\0` after whatever its
// rc files echo; only what follows the sentinel counts.
export function parseShellEnv(
  output: string
): { path: string; lang: string; lcAll: string } | null {
  const at = output.lastIndexOf(SHELL_ENV_SENTINEL)
  if (at === -1) return null
  const [, path = '', lang = '', lcAll = ''] = output.slice(at).split('\0')
  return path ? { path, lang, lcAll } : null
}

// "en-US" → "en_US.UTF-8". Anything without a region falls back to en_US, the
// one UTF-8 locale every Mac has.
export function utf8Locale(systemLocale: string): string {
  const m = systemLocale.match(/^([a-z]{2,3})[-_]([A-Z]{2})/)
  return m ? `${m[1]}_${m[2]}.UTF-8` : 'en_US.UTF-8'
}

// A downloaded app opened straight from ~/Downloads or the DMG runs from a
// randomised read-only copy ("App Translocation"); it can't update itself there.
export function isTranslocated(appPath: string): boolean {
  return appPath.includes('/AppTranslocation/')
}

// First executable called `name` on PATH, as an absolute path.
export function findExecutable(
  name: string,
  path: string | undefined = process.env.PATH
): string | null {
  if (isAbsolute(name)) return canExecute(name) ? name : null
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (canExecute(candidate)) return candidate
  }
  return null
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// -1 / 0 / 1 for dotted versions ("0.158.0"), missing parts read as 0.
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

// `xcode-select --install` either opens Apple's installer or says the tools
// are already there; anything else is a failure worth reporting.
export function xcodeInstallOutcome(output: string): 'requested' | 'installed' | 'error' {
  if (/install requested/i.test(output)) return 'requested'
  if (/already installed/i.test(output)) return 'installed'
  return 'error'
}
