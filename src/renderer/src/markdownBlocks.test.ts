import { describe, expect, it } from 'vitest'
import { normalizeMath, splitBlocks } from './markdownBlocks'

describe('normalizeMath', () => {
  it('leaves money alone', () => {
    for (const text of [
      'It costs $5 and $10.',
      'Pay $5, get $10.',
      'price $20-$30',
      'a \\$5 tip'
    ]) {
      expect(normalizeMath(text)).toBe(text)
    }
  })

  it('turns $…$ and \\(…\\) into inline maths', () => {
    expect(normalizeMath('Euler: $e^{i\\pi} + 1 = 0$, x $y$')).toBe(
      'Euler: $$e^{i\\pi} + 1 = 0$$, x $$y$$'
    )
    expect(normalizeMath('so \\(a^2 + b^2\\) holds')).toBe('so $$a^2 + b^2$$ holds')
  })

  it('makes a line of just $$…$$ or \\[…\\] a display equation', () => {
    expect(normalizeMath('$$\\int_0^1 x\\,dx$$')).toBe('$$\n\\int_0^1 x\\,dx\n$$')
    expect(normalizeMath('  \\[ x = 1 \\]')).toBe('$$\nx = 1\n$$')
  })

  it('handles \\[ and \\] on their own lines, leaving the inside alone', () => {
    expect(normalizeMath('\\[\na $b$ c\n\\]\nafter $x$')).toBe('$$\na $b$ c\n$$\nafter $$x$$')
  })

  it('never touches code', () => {
    const text = 'Use `$x$` here\n\n```sh\necho $HOME and $x$\n```'
    expect(normalizeMath(text)).toBe(text)
  })
})

describe('splitBlocks', () => {
  it('splits paragraphs at blank lines', () => {
    expect(splitBlocks('one\ntwo\n\nthree\n\n\nfour')).toEqual(['one\ntwo\n', 'three\n\n', 'four'])
  })

  it('keeps code fences whole, blank lines and all', () => {
    const text = 'Here:\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nDone.'
    expect(splitBlocks(text)).toEqual([
      'Here:\n',
      '```js\nconst a = 1\n\nconst b = 2\n```\n',
      'Done.'
    ])
  })

  it('keeps an unfinished fence (still streaming) in one block', () => {
    expect(splitBlocks('Intro\n\n```py\nx = 1\n\ny')).toEqual(['Intro\n', '```py\nx = 1\n\ny'])
  })

  it('keeps $$ maths whole', () => {
    expect(splitBlocks('$$\na\n\nb\n$$\n\nafter')).toEqual(['$$\na\n\nb\n$$\n', 'after'])
  })

  it('keeps an indented continuation with its list item', () => {
    const text = '1. First\n\n    code under it\n\n2. Second'
    expect(splitBlocks(text)).toEqual(['1. First\n\n    code under it\n', '2. Second'])
  })
})
