import { MODEL_SPECS } from '../shared/models'

// The models a Codex tab can run (GPT, by deployment name: the Azure portal
// names a deployment after its model), and the one a new tab starts on.
// Codex on the owner's Azure resource comes later; until then nothing offers
// Codex tabs (codexProvider() is null).
export function codexModels(): { ids: string[]; fallback: string } {
  const ids = MODEL_SPECS.filter((m) => m.family === 'gpt' && m.current && !m.deprecated).map(
    (m) => m.id
  )
  return { ids, fallback: ids.includes('gpt-6-sol') ? 'gpt-6-sol' : (ids[0] ?? 'gpt-6-sol') }
}
