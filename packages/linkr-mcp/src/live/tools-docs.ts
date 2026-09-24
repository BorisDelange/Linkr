/** The Linkr user documentation, searchable by agents (see docs.ts). */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { readFile } from 'node:fs/promises'
import { findPage, searchDocs, type DocsIndex } from './docs.js'
import { READ, failure, guard, text, type Server } from './shared.js'

const DEFAULT_INDEX = 'https://linkr.interhop.org/docs-index.json'
const REFRESH_MS = 60 * 60 * 1000
const MAX_PAGE_CHARS = 30_000

let cached: { index: DocsIndex; at: number } | null = null

/** The published index (or LINKR_DOCS_INDEX: another URL, or a local file such as
 *  a linkr-website build's dist/docs-index.json), cached for an hour. */
async function docsIndex(): Promise<DocsIndex> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.index
  const source = process.env.LINKR_DOCS_INDEX || DEFAULT_INDEX
  try {
    const raw = /^https?:\/\//.test(source)
      ? await (async () => {
        const res = await fetch(source)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })()
      : await readFile(source, 'utf8')
    const index = JSON.parse(raw) as DocsIndex
    if (!Array.isArray(index.pages)) throw new Error('no pages')
    cached = { index, at: Date.now() }
    return index
  } catch (e) {
    // A stale index beats none when the site is briefly unreachable.
    if (cached) return cached.index
    throw new Error(`The documentation index could not be loaded from ${source} (${(e as Error).message}).`)
  }
}

export function registerDocsTools(server: Server) {
  server.registerTool('search_docs', {
    description: 'Search the Linkr user documentation (linkr.interhop.org) — how a feature works, how to do something '
      + 'in the app. Returns the best pages with an excerpt; read one in full with read_doc. Cite the page URL to the user.',
    annotations: { ...READ, openWorldHint: true },
    inputSchema: fromJsonSchema<{ query: string; language?: 'en' | 'fr' | 'any'; limit?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, in the language of the pages you want.' },
        language: { type: 'string', enum: ['en', 'fr', 'any'], description: 'Default: any.' },
        limit: { type: 'number', description: 'Default 6, max 15.' },
      },
      required: ['query'],
    }),
  }, guard(async ({ query, language, limit = 6 }) => {
    const index = await docsIndex()
    const results = searchDocs(index, query, language, Math.min(Math.max(1, Math.floor(limit)), 15))
    if (results.length === 0) return text(`No documentation page matches "${query}". Try other keywords or the other language.`)
    return text(results.map(({ page, snippet }) =>
      `- ${page.title} (${page.section}, ${page.lang}) — ${index.baseUrl}${page.url}\n  ${page.description ? `${page.description}\n  ` : ''}${snippet}`,
    ).join('\n'))
  }))

  server.registerTool('read_doc', {
    description: 'One Linkr documentation page in full, as Markdown, by its URL (from search_docs).',
    annotations: { ...READ, openWorldHint: true },
    inputSchema: fromJsonSchema<{ url: string }>({
      type: 'object', properties: { url: { type: 'string', description: 'Page URL or path.' } }, required: ['url'],
    }),
  }, guard(async ({ url }) => {
    const index = await docsIndex()
    const page = findPage(index, url)
    if (!page) return failure(`No documentation page at ${url}. Use search_docs to find one.`)
    const body = page.text.length > MAX_PAGE_CHARS
      ? `${page.text.slice(0, MAX_PAGE_CHARS)}\n\n… (${page.text.length - MAX_PAGE_CHARS} more characters cut)`
      : page.text
    return text(`# ${page.title}\n${index.baseUrl}${page.url} · ${page.section} · ${page.lang}\n\n${body}`)
  }))
}
