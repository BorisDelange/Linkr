/**
 * Search over the Linkr user documentation. The website publishes every doc
 * page as plain Markdown in `/docs-index.json` at build time (linkr-website,
 * src/lib/docs-index); at ~140 pages a keyword ranking is enough — no embeddings.
 */

export interface DocPage {
  url: string
  lang: string
  title: string
  section: string
  description: string
  text: string
}

export interface DocsIndex {
  generatedAt: string
  baseUrl: string
  pages: DocPage[]
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Query words worth matching: accents and case folded, very short words dropped. */
export function queryTerms(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))]
}

function occurrences(haystack: string, term: string): number {
  let n = 0
  for (let i = haystack.indexOf(term); i >= 0; i = haystack.indexOf(term, i + term.length)) n++
  return n
}

/**
 * A page's relevance: title and description hits weigh most, body hits add
 * with diminishing returns, and a page holding every term outranks one that
 * repeats a single term.
 */
export function scorePage(page: DocPage, terms: string[]): number {
  if (terms.length === 0) return 0
  const title = fold(page.title)
  const head = fold(`${page.section} ${page.description}`)
  const body = fold(page.text)
  let score = 0
  let matched = 0
  for (const term of terms) {
    const inTitle = title.includes(term)
    const inHead = head.includes(term)
    const inBody = occurrences(body, term)
    if (inTitle || inHead || inBody) matched++
    score += (inTitle ? 8 : 0) + (inHead ? 3 : 0) + Math.log2(1 + inBody)
  }
  return matched === 0 ? 0 : score * (matched / terms.length) ** 2
}

/** A few words around the first place the page mentions a term. */
export function snippet(text: string, terms: string[], radius = 160): string {
  const folded = fold(text)
  const at = terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (at === undefined) return clean(text.slice(0, radius * 2))
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${clean(text.slice(start, end))}${end < text.length ? '…' : ''}`
}

export function searchDocs(index: DocsIndex, query: string, language: string | undefined, limit: number) {
  const terms = queryTerms(query)
  return index.pages
    .filter((p) => !language || language === 'any' || p.lang === language)
    .map((page) => ({ page, score: scorePage(page, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({ ...r, snippet: snippet(r.page.text, terms) }))
}

/** A page by its URL — absolute, a path, with or without the trailing slash. */
export function findPage(index: DocsIndex, ref: string): DocPage | undefined {
  const path = ref.trim().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '')
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`)
  return index.pages.find((p) => norm(p.url) === norm(path.startsWith('/') ? path : `/${path}`))
}
