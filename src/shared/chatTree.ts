// Chats are trees: editing a message or retrying a reply adds a sibling. These
// helpers turn the flat list of a chat's messages into the conversation you
// see (one path from the first message to a leaf) and the ‹2/3› choices
// along it. Pure, so main and the renderer share them.

interface Node {
  id: number
  parentId: number | null
  createdAt: number
}

// Root → leaf, in order. An unknown leaf gives an empty path.
export function pathTo<T extends Node>(messages: T[], leafId: number | null): T[] {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: T[] = []
  for (let at = leafId === null ? undefined : byId.get(leafId); at;) {
    path.push(at)
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  }
  return path.reverse()
}

// A message and its alternatives (same parent), oldest first.
export function siblings<T extends Node>(messages: T[], id: number): T[] {
  const self = messages.find((m) => m.id === id)
  if (!self) return []
  return messages
    .filter((m) => m.parentId === self.parentId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
}

// The newest leaf under `id` (following the newest child each step) — where
// switching to a branch should land.
export function deepestLatest<T extends Node>(messages: T[], id: number): number {
  let at = id
  for (;;) {
    const kids = messages.filter((m) => m.parentId === at)
    if (kids.length === 0) return at
    at = kids.reduce((a, b) =>
      b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a
    ).id
  }
}
