import { describe, expect, it } from 'vitest'
import { deepestLatest, pathTo, siblings } from './chatTree'

// 1 → 2 → 3, with an edited user message 4 (sibling of 2) → 5, and a retry 6
// of reply 3.
const m = (id: number, parentId: number | null, createdAt: number) => ({ id, parentId, createdAt })
const chat = [m(1, null, 1), m(2, 1, 2), m(3, 2, 3), m(4, 1, 4), m(5, 4, 5), m(6, 2, 6)]

describe('chat tree', () => {
  it('walks root to leaf', () => {
    expect(pathTo(chat, 5).map((x) => x.id)).toEqual([1, 4, 5])
    expect(pathTo(chat, 6).map((x) => x.id)).toEqual([1, 2, 6])
    expect(pathTo(chat, null)).toEqual([])
    expect(pathTo(chat, 99)).toEqual([])
  })

  it('lists the alternatives at a point, oldest first', () => {
    expect(siblings(chat, 4).map((x) => x.id)).toEqual([2, 4])
    expect(siblings(chat, 3).map((x) => x.id)).toEqual([3, 6])
    expect(siblings(chat, 1).map((x) => x.id)).toEqual([1])
  })

  it('lands a branch switch on its newest leaf', () => {
    expect(deepestLatest(chat, 2)).toBe(6)
    expect(deepestLatest(chat, 4)).toBe(5)
    expect(deepestLatest(chat, 1)).toBe(5)
  })
})
