import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { readFence } from './read-fence'
import { remarkPlugins, rehypePlugins } from '@/components/editor/MarkdownRenderer'

function fenceNode(className: unknown, value: unknown) {
  return { children: [{ properties: { className }, children: [{ value }] }] }
}

/** The `pre` nodes a real markdown string produces through the app's own plugin
 *  chain — the sanitizer included, since it is what could strip the language. */
function preNodesOf(markdown: string) {
  const tree = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .use(rehypePlugins as any)
    .runSync(unified().use(remarkParse).parse(markdown))
  const found: unknown[] = []
  const walk = (node: { tagName?: string; children?: unknown[] }) => {
    if (node.tagName === 'pre') found.push(node)
    for (const child of node.children ?? []) walk(child as typeof node)
  }
  walk(tree as never)
  return found
}

describe('readFence', () => {
  it('reads the language and source of a fenced block', () => {
    expect(readFence(fenceNode(['language-r'], 'x <- 1\ny <- 2\n'))).toEqual({
      language: 'r',
      source: 'x <- 1\ny <- 2',
    })
  })

  it('accepts className as a plain string', () => {
    expect(readFence(fenceNode('language-python', 'import linkr'))).toEqual({
      language: 'python',
      source: 'import linkr',
    })
  })

  it('keeps interior blank lines and strips only the trailing newline', () => {
    expect(readFence(fenceNode(['language-r'], 'a\n\nb\n'))?.source).toBe('a\n\nb')
  })

  it('declines a block with no language, so it stays prose', () => {
    expect(readFence(fenceNode([], 'plain text'))).toBeNull()
  })

  it('declines mermaid, which the shared renderer draws as a diagram', () => {
    expect(readFence(fenceNode(['language-mermaid'], 'graph TD;'))).toBeNull()
  })

  it('declines an empty block', () => {
    expect(readFence(fenceNode(['language-r'], '   \n'))).toBeNull()
  })

  it('declines a malformed node instead of throwing', () => {
    expect(readFence(undefined)).toBeNull()
    expect(readFence({})).toBeNull()
    expect(readFence({ children: [{}] })).toBeNull()
  })

  // The override reads the language off the AST *after* the plugin chain has
  // run, so what matters is the node shape that chain actually produces —
  // hast's array-valued className, and the sanitizer having left it alone.
  // (rehype-sanitize's default schema already allows `language-*` on `code`, so
  // this does not guard the app's explicit entry for it; swapping the plugins
  // or the markdown pipeline is what would break it.)
  it('survives the app’s real plugin chain, sanitizer included', () => {
    const [pre] = preNodesOf('```r\nlibrary(linkr)\n```\n')
    expect(readFence(pre)).toEqual({ language: 'r', source: 'library(linkr)' })
  })

  it('leaves a mermaid fence to the default renderer through that same chain', () => {
    const [pre] = preNodesOf('```mermaid\ngraph TD;\n```\n')
    expect(readFence(pre)).toBeNull()
  })
})
