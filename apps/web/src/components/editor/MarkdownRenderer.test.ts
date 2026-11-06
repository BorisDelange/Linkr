import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { sanitizeSchema } from './MarkdownRenderer'

const render = (markdown: string) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
  return JSON.stringify(processor.runSync(processor.parse(markdown)), (key, value) => (key === 'position' ? undefined : value))
}

describe('stored markdown keeps to its own box', () => {
  it('drops a style that takes the element out of the page flow', () => {
    const html = render('<div style="position:fixed;inset:0;z-index:99">x</div>')
    expect(html).not.toMatch(/position|inset|z-index/)
    expect(html).toContain('x')
  })

  it("drops the app's classes from raw HTML", () => {
    for (const tag of ['div', 'span', 'code']) {
      expect(render(`<${tag} class="fixed inset-0 z-50">x</${tag}>`)).not.toMatch(/fixed|z-50/)
    }
  })

  it('keeps a plain formatting style', () => {
    expect(render('<div style="text-align:center;color:#336699">x</div>')).toContain('text-align:center;color:#336699')
  })

  it('keeps what math and fenced code need', () => {
    expect(render('$a$')).toContain('math-inline')
    expect(render('$$\na\n$$')).toContain('math-display')
    expect(render('```sql\nselect 1\n```')).toContain('language-sql')
  })

  it('keeps callouts and mermaid markers', () => {
    expect(render('<div data-callout="note">x</div>')).toContain('"dataCallout":"note"')
  })
})

describe('Mermaid', () => {
  it('runs the bundled package, never code fetched at runtime', () => {
    const source = readFileSync(resolve(__dirname, 'MarkdownRenderer.tsx'), 'utf-8')
    expect(source).not.toMatch(/import\(\s*['"`]https?:/)
    expect(source).toMatch(/import\(\s*['"]mermaid['"]\s*\)/)
  })

  it('resolves from the lockfile', async () => {
    const mermaid = await import('mermaid')
    expect(typeof mermaid.default.render).toBe('function')
  })
})
