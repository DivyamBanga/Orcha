import { memo, useRef, useState } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { normalizeMath, splitBlocks } from '../markdownBlocks'
import { Check, Copy } from './Icon'

// Markdown as Claude and GPT write it: GitHub tables and task lists, LaTeX
// maths, highlighted code with a copy button. Shared by chat and Mission
// Control.

// Single-dollar maths is off ("$5 and $10" is money); normalizeMath has
// already turned real inline maths into $$…$$.
const remarkPlugins: Options['remarkPlugins'] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }]
]
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex, rehypeHighlight]

function CodeBlock({ children, ...rest }: React.ComponentProps<'pre'>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const code = (children as React.ReactElement<{ className?: string }> | undefined)?.props
  const language = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]
  const copy = (): void => {
    navigator.clipboard.writeText(ref.current?.textContent ?? '').catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="code-block group/code">
      <div className="code-head">
        <span>{language ?? 'code'}</span>
        <button onClick={copy} className="code-copy" title="Copy code">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  )
}

// Links open in the browser. Anything that isn't a web or mail link (a relative
// path would navigate Orcha itself) does nothing.
function Link({ href, children }: React.ComponentProps<'a'>): React.JSX.Element {
  const external = href && /^(https?:|mailto:)/i.test(href)
  return (
    <a
      href={href}
      title={external ? href : undefined}
      onClick={(e) => {
        e.preventDefault()
        if (external) window.open(href)
      }}
    >
      {children}
    </a>
  )
}

const components: Components = { pre: CodeBlock, a: Link }

const Block = memo(function Block({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
})

// Rendered block by block, so while a reply streams in only its last block
// is parsed again; everything above it stays as it was.
function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  return (
    <div className={`prose-chat select-text ${className ?? ''}`}>
      {splitBlocks(normalizeMath(text)).map((block, i) => (
        <Block key={i} text={block} />
      ))}
    </div>
  )
}

export default Markdown
