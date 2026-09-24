/** The Linkr user documentation, searchable by agents (see docs.ts). */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { findPage, loadFirstIndex, searchDocs, type DocsIndex, type DocsSource } from './docs.js'
import { READ, failure, guard, text, type Server } from './shared.js'

const DEFAULT_INDEX = 'https://linkr.interhop.org/docs-index.json'
/** Refreshed with `npm run docs:snapshot`; used when the site cannot be reached. */
const BUNDLED_INDEX = new URL('../../data/docs-index.json.gz', import.meta.url)
const REFRESH_MS = 60 * 60 * 1000
// Offline instances retry the site less eagerly than a stale online copy would.
const BUNDLED_REFRESH_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
const MAX_PAGE_CHARS = 30_000

let cached: { index: DocsIndex; at: number; bundled: boolean } | null = null

async function readSource(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFile(source, 'utf8')
  const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** The published index (or LINKR_DOCS_INDEX: another URL, or a local file such as
 *  a linkr-website build's dist/docs-index.json), else the copy shipped with the
 *  MCP. Cached for an hour; a stale online copy beats the shipped one. */
async function docsIndex(): Promise<{ index: DocsIndex; bundled: boolean }> {
  if (cached && Date.now() - cached.at < (cached.bundled ? BUNDLED_REFRESH_MS : REFRESH_MS)) return cached
  const primary = process.env.LINKR_DOCS_INDEX || DEFAULT_INDEX
  const sources: DocsSource[] = [
    { label: primary, load: () => readSource(primary) },
    ...(cached && !cached.bundled ? [{ label: 'cache', load: async () => JSON.stringify(cached!.index) }] : []),
    { label: 'bundled copy', load: async () => gunzipSync(await readFile(BUNDLED_INDEX)).toString('utf8') },
  ]
  try {
    const { index, source } = await loadFirstIndex(sources)
    const bundled = source.label === 'bundled copy'
    cached = { index, bundled, at: Date.now() }
    return cached
  } catch (e) {
    throw new Error(`The documentation index could not be loaded (${(e as Error).message}).`)
  }
}

const offlineNote = (index: DocsIndex) =>
  `(Offline copy of the documentation, ${index.generatedAt.slice(0, 10)}: the site could not be reached.)\n`

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
    const { index, bundled } = await docsIndex()
    const results = searchDocs(index, query, language, Math.min(Math.max(1, Math.floor(limit)), 15))
    if (results.length === 0) return text(`No documentation page matches "${query}". Try other keywords or the other language.`)
    return text((bundled ? offlineNote(index) : '') + results.map(({ page, snippet }) =>
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
    const { index, bundled } = await docsIndex()
    const page = findPage(index, url)
    if (!page) return failure(`No documentation page at ${url}. Use search_docs to find one.`)
    const body = page.text.length > MAX_PAGE_CHARS
      ? `${page.text.slice(0, MAX_PAGE_CHARS)}\n\n… (${page.text.length - MAX_PAGE_CHARS} more characters cut)`
      : page.text
    return text(`${bundled ? offlineNote(index) : ''}# ${page.title}\n${index.baseUrl}${page.url} · ${page.section} · ${page.lang}\n\n${body}`)
  }))
}
