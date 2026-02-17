import { useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
import {
  Info,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react'

// --- Shared config (also used by SummaryReadmeTab) ---

export const remarkPlugins = [remarkGfm, remarkMath]

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'alt', 'width', 'height'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'style', 'data-callout', 'data-mermaid'],
    math: ['xmlns'],
    annotation: ['encoding'],
    details: [],
    summary: [],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'blob'],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'msubsup', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt',
    'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'annotation',
    'details', 'summary',
  ],
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rehypePlugins: any[] = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]

const safeProtocol = /^(https?|ircs?|mailto|xmpp|blob)$/i
export function urlTransform(value: string): string {
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value
  }
  return ''
}

// --- Callout preprocessing ---

const CALLOUT_REGEX = /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:> .*(?:\n|$))*)/gm

function processCallouts(markdown: string): string {
  return markdown.replace(CALLOUT_REGEX, (_match, type: string, body: string) => {
    const content = body.replace(/^> ?/gm, '').trim()
    return `<div data-callout="${type.toLowerCase()}">\n\n**${type.charAt(0) + type.slice(1).toLowerCase()}**\n\n${content}\n\n</div>\n`
  })
}

// --- Wikilink preprocessing ---

function processWikilinks(
  markdown: string,
  resolveWikilink?: (name: string) => string | null,
): string {
  if (!resolveWikilink) return markdown
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, name: string) => {
    const url = resolveWikilink(name)
    if (url) return `[${name}](${url})`
    return `**${name}** *(broken link)*`
  })
}

// --- TOC preprocessing ---

function processToc(markdown: string): string {
  if (!markdown.includes('[[toc]]')) return markdown

  const headings: { level: number; text: string; id: string }[] = []
  const lines = markdown.split('\n')
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
      headings.push({ level, text, id })
    }
  }

  if (headings.length === 0) return markdown.replace('[[toc]]', '')

  const toc = headings
    .map((h) => `${'  '.repeat(h.level - 1)}- [${h.text}](#${h.id})`)
    .join('\n')

  return markdown.replace('[[toc]]', toc)
}

// --- Mermaid rendering ---

function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        // Dynamic import for mermaid (loaded from CDN if not available)
        const mermaid = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
        if (cancelled || !containerRef.current) return
        mermaid.default.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          securityLevel: 'strict',
        })
        const { svg } = await mermaid.default.render(
          `mermaid-${Math.random().toString(36).slice(2, 8)}`,
          code,
        )
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
        }
      } catch {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = `<pre class="text-xs text-destructive p-2">Mermaid error — check diagram syntax</pre>`
        }
      }
    }
    render()
    return () => { cancelled = true }
  }, [code])

  return <div ref={containerRef} className="my-4 flex justify-center [&_svg]:max-w-full" />
}

// --- Callout block component ---

const calloutStyles: Record<string, { icon: React.ReactNode; border: string; bg: string }> = {
  note: { icon: <Info size={16} />, border: 'border-blue-500/40', bg: 'bg-blue-500/5' },
  tip: { icon: <Lightbulb size={16} />, border: 'border-emerald-500/40', bg: 'bg-emerald-500/5' },
  important: { icon: <AlertCircle size={16} />, border: 'border-violet-500/40', bg: 'bg-violet-500/5' },
  warning: { icon: <AlertTriangle size={16} />, border: 'border-amber-500/40', bg: 'bg-amber-500/5' },
  caution: { icon: <AlertTriangle size={16} />, border: 'border-red-500/40', bg: 'bg-red-500/5' },
}

// --- Main Renderer ---

interface MarkdownRendererProps {
  content: string
  className?: string
  resolveWikilink?: (name: string) => string | null
}

export function MarkdownRenderer({ content, className, resolveWikilink }: MarkdownRendererProps) {
  // Pre-process markdown
  let processed = content
  processed = processCallouts(processed)
  processed = processWikilinks(processed, resolveWikilink)
  processed = processToc(processed)

  // Custom component overrides for ReactMarkdown
  const components = useCallback(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    div: ({ node, ...props }: any) => {
      const calloutType = props['data-callout']
      if (calloutType && calloutStyles[calloutType]) {
        const style = calloutStyles[calloutType]
        return (
          <div className={`my-3 rounded-lg border-l-4 ${style.border} ${style.bg} px-4 py-3`}>
            <div className="flex items-start gap-2 [&>p]:my-0 [&>strong]:flex [&>strong]:items-center [&>strong]:gap-1.5">
              {style.icon}
              <div {...props} className="flex-1 [&>p]:my-1" />
            </div>
          </div>
        )
      }
      return <div {...props} />
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code: ({ node, className: codeClassName, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(codeClassName || '')
      if (match?.[1] === 'mermaid') {
        return <MermaidBlock code={String(children).trim()} />
      }
      if (match) {
        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        )
      }
      return <code {...props}>{children}</code>
    },
    // Add IDs to headings for TOC linking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h1: ({ children, ...props }: any) => {
      const id = getHeadingId(children)
      return <h1 id={id} {...props}>{children}</h1>
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h2: ({ children, ...props }: any) => {
      const id = getHeadingId(children)
      return <h2 id={id} {...props}>{children}</h2>
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h3: ({ children, ...props }: any) => {
      const id = getHeadingId(children)
      return <h3 id={id} {...props}>{children}</h3>
    },
  }), [])

  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={components()}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

function getHeadingId(children: React.ReactNode): string {
  const text = typeof children === 'string'
    ? children
    : Array.isArray(children)
      ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
      : ''
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
