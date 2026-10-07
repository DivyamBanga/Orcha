// Inline $…$ by Pandoc's rule: the opening $ has text right after it, the
// closing one has text right before it and no digit after, so "$5 and $10"
// stays money.
const DOLLAR_MATH = /(?<![\\$])\$(?!\s)([^$\n]*?[^\s$\\])\$(?![\d$])/g
const DISPLAY_LINE = /^\s*(?:\$\$((?:(?!\$\$).)+)\$\$|\\\[(.+)\\\])\s*$/

// Maths as models write it, in the one form the renderer reads ($$…$$, with
// single-dollar parsing off so prices are safe): $…$ and GPT's \(…\) inline,
// \[…\] and a line that is just $$…$$ as a display equation. Code (fenced or
// inline) and the inside of display blocks are left alone.
export function normalizeMath(text: string): string {
  let fence: string | null = null
  let display = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null
      out.push(line)
      continue
    }
    const opens = /^(`{3,}|~{3,})/.exec(trimmed)
    if (opens) {
      fence = opens[1]
      out.push(line)
      continue
    }
    if (trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]') {
      display = trimmed === '$$' ? !display : trimmed === '\\['
      out.push('$$')
      continue
    }
    if (display) {
      out.push(line)
      continue
    }
    const whole = DISPLAY_LINE.exec(line)
    if (whole) {
      out.push('$$', (whole[1] ?? whole[2]).trim(), '$$')
      continue
    }
    out.push(
      line
        .split(/(`+[^`]*`+)/)
        .map((part, i) =>
          i % 2
            ? part
            : part
                .replace(/\\\((.+?)\\\)/g, (_, m: string) => `$$${m}$$`)
                .replace(/\\\[(.+?)\\\]/g, (_, m: string) => `$$${m}$$`)
                .replace(DOLLAR_MATH, (_, m: string) => `$$${m}$$`)
        )
        .join('')
    )
  }
  return out.join('\n')
}

// Splits markdown into blocks that render the same on their own as they do
// together: at blank lines, but never inside a code fence or a $$ maths block,
// and never before an indented line (that continues a list item, and on its own
// would turn into a code block).
export function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  let maths = false
  let blank = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null
    } else if (maths) {
      if (trimmed.endsWith('$$')) maths = false
    } else if (/^(`{3,}|~{3,})/.test(trimmed)) {
      fence = trimmed.match(/^(`{3,}|~{3,})/)![1]
    } else if (trimmed.startsWith('$$') && !(trimmed.length > 2 && trimmed.endsWith('$$'))) {
      maths = true
    }
    const inside = fence !== null || maths
    if (!inside && trimmed === '') {
      blank = true
      current.push(line)
      continue
    }
    if (blank && !/^\s/.test(line) && current.some((l) => l.trim() !== '')) {
      blocks.push(current.join('\n'))
      current = []
    }
    blank = false
    current.push(line)
  }
  if (current.some((l) => l.trim() !== '')) blocks.push(current.join('\n'))
  return blocks
}
