import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isTranslocated,
  mergePath,
  parseShellEnv,
  SHELL_ENV_SENTINEL,
  utf8Locale,
  xcodeInstallOutcome
} from './platform-core'

describe('mergePath', () => {
  it('keeps order, drops duplicates and empties', () => {
    expect(mergePath(['/a:/b', undefined, '/b:/c', '', '/a'], ':')).toBe('/a:/b:/c')
  })

  it('does not split Windows paths on the colon after a drive letter', () => {
    expect(mergePath(['C:\\x;C:\\y', 'C:\\x'], ';')).toBe('C:\\x;C:\\y')
  })
})

describe('parseShellEnv', () => {
  it('reads only what follows the sentinel, past rc-file noise', () => {
    const out = `Welcome back!\n${SHELL_ENV_SENTINEL}\0/opt/homebrew/bin:/usr/bin\0en_GB.UTF-8\0\0`
    expect(parseShellEnv(out)).toEqual({
      path: '/opt/homebrew/bin:/usr/bin',
      lang: 'en_GB.UTF-8',
      lcAll: ''
    })
  })

  it('gives up when the shell never got there', () => {
    expect(parseShellEnv('oh-my-zsh update? [Y/n]')).toBeNull()
  })
})

describe('utf8Locale', () => {
  it('maps a system locale to a UTF-8 one', () => {
    expect(utf8Locale('en-US')).toBe('en_US.UTF-8')
    expect(utf8Locale('pt-BR')).toBe('pt_BR.UTF-8')
    expect(utf8Locale('fr')).toBe('en_US.UTF-8')
  })
})

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('0.158.0', '0.158.0')).toBe(0)
    expect(compareVersions('0.160.1', '0.158.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
})

describe('isTranslocated', () => {
  it('spots a translocated app', () => {
    expect(isTranslocated('/private/var/folders/x/T/AppTranslocation/ABC/d/Orcha.app')).toBe(true)
    expect(isTranslocated('/Applications/Orcha.app')).toBe(false)
  })
})

describe('xcodeInstallOutcome', () => {
  it("reads xcode-select --install's answer", () => {
    expect(
      xcodeInstallOutcome('xcode-select: note: install requested for command line developer tools')
    ).toBe('requested')
    expect(
      xcodeInstallOutcome(
        'xcode-select: error: command line tools are already installed, use "Software Update" in System Settings to install updates'
      )
    ).toBe('installed')
    expect(xcodeInstallOutcome('xcode-select: error: no developer tools were found')).toBe('error')
  })
})
