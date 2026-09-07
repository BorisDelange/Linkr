import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import type { Element, Root } from 'hast'
import { processCallouts } from './markdown-components'
import { sanitizeSchema } from './MarkdownRenderer'

/**
 * The callout pipeline has two halves that must agree: `processCallouts` emits
 * `<div data-callout="…">`, and the sanitizer has to let that marker through so
 * the `div` renderer can style it.
 *
 * They disagreed silently for a long time. rehype-raw turns the attribute into
 * the hast property `dataCallout` before the sanitizer runs, so a schema
 * whitelisting the hyphenated `data-callout` stripped it and every alert
 * rendered as an unstyled div. Nothing failed — the text was all there, just
 * grey. Hence this test.
 */
function findByTag(node: Root | Element, tagName: string): Element | null {
  if ('tagName' in node && node.tagName === tagName) return node
  for (const child of node.children ?? []) {
    if (child.type !== 'element') continue
    const found = findByTag(child, tagName)
    if (found) return found
  }
  return null
}

async function renderToHast(markdown: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
  return processor.run(processor.parse(markdown)) as Promise<Root>
}

describe('processCallouts', () => {
  it('turns a GitHub alert into a marked div', () => {
    const out = processCallouts('> [!WARNING]\n> Do not do that.\n')
    expect(out).toContain('<div data-callout="warning">')
    expect(out).toContain('Do not do that.')
  })

  it('lowercases the type and strips the quote markers', () => {
    expect(processCallouts('> [!NOTE]\n> One.\n> Two.\n')).toContain('data-callout="note"')
    expect(processCallouts('> [!NOTE]\n> One.\n> Two.\n')).not.toContain('> One.')
  })

  it('leaves an ordinary blockquote alone', () => {
    const input = '> Just a quotation.\n'
    expect(processCallouts(input)).toBe(input)
  })

  it('handles every supported type', () => {
    for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      expect(processCallouts(`> [!${type}]\n> Body.\n`)).toContain(`data-callout="${type.toLowerCase()}"`)
    }
  })
})

describe('the sanitize schema', () => {
  it('keeps the callout marker the div renderer needs', async () => {
    const tree = await renderToHast(processCallouts('> [!WARNING]\n> Body.\n'))
    expect(findByTag(tree, 'div')?.properties?.dataCallout).toBe('warning')
  })

  it('still strips attributes that are not whitelisted', async () => {
    const tree = await renderToHast('<div data-callout="warning" onclick="steal()">\n\nBody.\n\n</div>\n')
    expect(findByTag(tree, 'div')?.properties?.onclick).toBeUndefined()
  })
})
