/**
 * Refreshes data/docs-index.json.gz, the documentation index shipped with the MCP
 * for instances that cannot reach linkr.interhop.org.
 *
 *   npm run docs:snapshot                     # from the live site
 *   npm run docs:snapshot -- <url-or-file>    # e.g. a local linkr-website build
 */
import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { parseDocsIndex } from './live/docs.js'

const source = process.argv[2] ?? 'https://linkr.interhop.org/docs-index.json'
const raw = /^https?:\/\//.test(source)
  ? await fetch(source).then((res) => {
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`)
    return res.text()
  })
  : await readFile(source, 'utf8')
const index = parseDocsIndex(raw)
const out = new URL('../data/docs-index.json.gz', import.meta.url)
const gz = gzipSync(JSON.stringify(index), { level: 9 })
await writeFile(out, gz)
console.log(`${index.pages.length} pages (generated ${index.generatedAt}) → data/docs-index.json.gz, ${Math.round(gz.length / 1024)} KB`)
