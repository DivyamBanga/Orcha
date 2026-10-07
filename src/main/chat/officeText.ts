import { strFromU8, unzipSync } from 'fflate'

// The text inside Word, PowerPoint and Excel files, so a chat can read them.
// These formats are zipped XML; only the parts holding text are unzipped, and
// the XML is read with a few patterns rather than a parser (the text sits in
// a handful of predictable elements). Layout, images and formulas are left
// out — this is what the model needs to answer questions about the file.

export type OfficeKind = 'docx' | 'pptx' | 'xlsx'

// Enough for a long report or a big sheet without flooding the chat.
const MAX_ROWS_PER_SHEET = 2000

function decode(xml: string): string {
  return xml.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
    if (named[e.toLowerCase()]) return named[e.toLowerCase()]
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

// Text runs of each paragraph (<w:p>/<a:p>), one line per paragraph.
function paragraphs(xml: string, ns: 'w' | 'a'): string[] {
  const lines: string[] = []
  for (const para of xml.split(`</${ns}:p>`)) {
    let line = ''
    const token = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:(tab|br)\\s*/>`, 'g')
    for (const m of para.matchAll(token)) {
      line += m[1] !== undefined ? decode(m[1]) : m[2] === 'tab' ? '\t' : '\n'
    }
    if (line.trim()) lines.push(line)
  }
  return lines
}

const numbered = (prefix: string) => (a: string, b: string) =>
  Number(a.slice(prefix.length).replace(/\D/g, '')) -
  Number(b.slice(prefix.length).replace(/\D/g, ''))

function docx(files: Record<string, Uint8Array>): string {
  const body = files['word/document.xml']
  return body ? paragraphs(strFromU8(body), 'w').join('\n') : ''
}

function pptx(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(numbered('ppt/slides/slide'))
  return slides
    .map((name, i) => {
      const text = paragraphs(strFromU8(files[name]), 'a').join('\n')
      return text ? `Slide ${i + 1}\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

// Column letters of a cell reference ("BC12" → 54), 1-based.
function column(ref: string): number {
  let n = 0
  for (const c of ref.replace(/\d+$/, '')) n = n * 26 + (c.charCodeAt(0) - 64)
  return n
}

function xlsx(files: Record<string, Uint8Array>): string {
  const shared: string[] = []
  const strings = files['xl/sharedStrings.xml']
  if (strings) {
    for (const si of strFromU8(strings).split('</si>')) {
      const parts = [...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1]))
      if (si.includes('<si')) shared.push(parts.join(''))
    }
  }
  const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : ''
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]))
  const sheets = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort(numbered('xl/worksheets/sheet'))

  return sheets
    .map((name, i) => {
      const rows: string[] = []
      for (const row of strFromU8(files[name]).split('</row>')) {
        if (rows.length >= MAX_ROWS_PER_SHEET) break
        const cells: string[] = []
        for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]
          const inner = c[2] ?? ''
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
          const type = /\bt="(\w+)"/.exec(attrs)?.[1]
          const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1]
          let value = ''
          if (type === 's' && v !== undefined) value = shared[Number(v)] ?? ''
          else if (type === 'inlineStr')
            value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
              .map((m) => decode(m[1]))
              .join('')
          else if (v !== undefined) value = decode(v)
          const at = ref ? column(ref) - 1 : cells.length
          while (cells.length < at) cells.push('')
          cells[at] = value.replace(/[\t\n]/g, ' ')
        }
        if (cells.some((v) => v !== '')) rows.push(cells.join('\t').trimEnd())
      }
      if (!rows.length) return ''
      return `Sheet: ${names[i] ?? `Sheet ${i + 1}`}\n${rows.join('\n')}`
    })
    .filter(Boolean)
    .join('\n\n')
}

const PARTS: Record<OfficeKind, (name: string) => boolean> = {
  docx: (n) => n === 'word/document.xml',
  pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n),
  xlsx: (n) =>
    n === 'xl/sharedStrings.xml' ||
    n === 'xl/workbook.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
}

export function officeText(kind: OfficeKind, data: Uint8Array): string {
  const files = unzipSync(data, { filter: (f) => PARTS[kind](f.name) })
  const text = kind === 'docx' ? docx(files) : kind === 'pptx' ? pptx(files) : xlsx(files)
  return text.trim()
}
