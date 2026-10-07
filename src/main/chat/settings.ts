import * as db from '../db'
import type { ChatSettings } from '../../shared/types'

// Settings → Profile, Appearance and Defaults, kept as one JSON value.

const KEY = 'chat:settings'

const DEFAULTS: ChatSettings = {
  name: '',
  about: '',
  style: '',
  model: null,
  thinking: false,
  webSearch: false,
  textSize: 'default',
  memory: true
}

const LIMIT = 4000

export function chatSettings(): ChatSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(db.appState.get(KEY) ?? '{}') as Partial<ChatSettings>) }
  } catch {
    return DEFAULTS
  }
}

export function saveChatSettings(changes: Partial<ChatSettings>): ChatSettings {
  const next = { ...chatSettings(), ...changes }
  next.name = next.name.slice(0, 80)
  next.about = next.about.slice(0, LIMIT)
  next.style = next.style.slice(0, LIMIT)
  db.appState.set(KEY, JSON.stringify(next))
  return next
}
