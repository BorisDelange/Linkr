/**
 * The language and source of a fenced code block, read off the hast node that
 * react-markdown hands a `pre` renderer.
 *
 * Read from the AST rather than from the rendered `children`: reconstructing the
 * text from React elements loses the newlines, which turns a multi-line example
 * into one line in the editor.
 *
 * Returns null for anything that should keep the default `<pre>` — an unfenced
 * block (no language), an empty one, and mermaid, which the shared renderer
 * draws as a diagram.
 */
export interface Fence {
  language: string
  source: string
}

interface HastNode {
  children?: {
    properties?: { className?: unknown }
    children?: { value?: unknown }[]
  }[]
}

export function readFence(node: unknown): Fence | null {
  const code = (node as HastNode | undefined)?.children?.[0]
  if (!code) return null

  const raw = code.properties?.className
  // hast gives className as an array; a sanitizer or a hand-built node may leave
  // it a plain string.
  const className = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : ''
  const language = /language-(\w+)/.exec(className)?.[1]
  if (!language || language === 'mermaid') return null

  const value = code.children?.[0]?.value
  const source = typeof value === 'string' ? value.replace(/\n$/, '') : ''
  if (!source.trim()) return null

  return { language, source }
}
