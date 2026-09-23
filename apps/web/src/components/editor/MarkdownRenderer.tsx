import { useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
import { ExternalLink } from 'lucide-react'
import { markdownComponents, processCallouts } from '@/components/editor/markdown-components'
import { foldAccents } from '@/lib/fold-accents'

export { markdownComponents, processCallouts } from '@/components/editor/markdown-components'

// --- Shared config (also used by SummaryReadmeTab) ---

export const remarkPlugins = [remarkGfm, remarkMath]

export const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'alt', 'width', 'height'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    // hast property names, not HTML attribute names: rehype-raw has already
    // turned `data-callout` into `dataCallout` by the time the sanitizer runs,
    // so whitelisting the hyphenated spelling silently stripped both — which is
    // why callouts and mermaid blocks rendered as bare divs.
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'style', 'dataCallout', 'dataMermaid'],
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
      const id = foldAccents(text)
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
        // Dynamic import for mermaid (loaded from CDN if not available).
        // @ts-expect-error — remote URL import has no local type declarations
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

// --- Read-only README renderer ---

/**
 * The plain markdown view a dozen pages show for a stored README: a plugin, a
 * database, a workspace home, a catalog entry.
 *
 * It exists so those pages cannot each assemble the config slightly differently
 * — passing the plugins but forgetting `components`, or the components but not
 * `processCallouts`, which is exactly how `> [!WARNING]` came to render as a
 * grey quote everywhere except the editor preview. Callers own the `.prose`
 * wrapper, since the surrounding layout differs; everything below it is fixed.
 */
export function ReadmeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={markdownComponents}
    >
      {processCallouts(children)}
    </ReactMarkdown>
  )
}

// --- Main Renderer ---

interface MarkdownRendererProps {
  content: string
  className?: string
  resolveWikilink?: (name: string) => string | null
  /**
   * Renderer overrides merged over the defaults, for a caller whose blocks need
   * more than prose styling — e.g. the IDE documentation dialog rendering fenced
   * code through Monaco. Merged last, so an override wins for the tags it names
   * and every other tag keeps the shared behaviour (callouts, mermaid, heading
   * anchors).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraComponents?: Record<string, any>
}

export function MarkdownRenderer({
  content,
  className,
  resolveWikilink,
  extraComponents,
}: MarkdownRendererProps) {
  // Pre-process markdown
  let processed = content
  processed = processCallouts(processed)
  processed = processWikilinks(processed, resolveWikilink)
  processed = processToc(processed)

  // Custom component overrides for ReactMarkdown
  const components = useCallback(() => ({
    // Callouts come from the shared `markdownComponents` (spread below), so a
    // `> [!WARNING]` renders the same here and on every raw-ReactMarkdown page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code: ({ node: _node, className: codeClassName, children, ...props }: any) => {
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
    // An off-site link opens in a new tab and says so, so following a reference
    // never loses the page underneath. In-page anchors (the TOC, heading links)
    // and app-relative links keep navigating in place.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ node: _node, href, children, ...props }: any) => {
      const isExternal = typeof href === 'string' && /^(https?|mailto):/i.test(href)
      if (!isExternal) return <a href={href} {...props}>{children}</a>
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-baseline gap-1"
          {...props}
        >
          {children}
          <ExternalLink size={11} className="ml-px shrink-0 translate-y-px opacity-70" aria-hidden />
        </a>
      )
    },
    // Images come from the shared `markdownComponents` (spread below), so the
    // click-to-enlarge and the width cap stay defined in exactly one place.
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

  // `prose-a:` rather than a class on the anchor: Tailwind Typography styles
  // links as `.prose a`, which outranks a plain utility class.
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none prose-a:transition-colors hover:prose-a:text-muted-foreground ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={{ ...markdownComponents, ...components(), ...extraComponents }}
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
  return foldAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
