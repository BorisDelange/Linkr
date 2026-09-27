/**
 * Standalone HTML export for concept catalogs: one self-contained page (inline
 * CSS, SVG and script, no network request) with the JSON-LD embedded for
 * machines, and four tabs — Explore, Metadata, Schema, Info. Same visual
 * language as the cohort report.
 *
 * Nothing unmasked reaches the page: the crossings come from
 * `buildPublishedCatalog` (masked cells carry no number), and concepts below
 * the threshold are capped (replace) or removed (suppress) before being inlined.
 */

import type { DataCatalog, CatalogResultCache, CatalogConceptRow, SchemaMapping, AnonymizationMode, CatalogCounts } from '@/types'
import { catalogCounts } from '@/lib/data-catalog/config'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { LINKR_LOGO_SVG } from '@/lib/cohort-report/render-html'
import { escapeXml as esc } from '@/lib/cohort-report/charts'
import { buildPublishedCatalog } from '@/lib/data-catalog/publish'
import { buildJsonLd } from './jsonld'
import { mappedTableDocs } from './mapped-tables'
import { localized } from '@/lib/localized'
import { DCAT_FIELDS, DCAT_VOCABULARIES, HEALTHDCATAP_RELEASE, HEALTHDCATAP_SPEC_URL, normalizeDcatMetadata, type DcatClass } from './schema'
import en from '@/locales/en.json'
import { CATALOG_CSS, icon, type IconName } from './export-html-style'
import { CATALOG_SCRIPT } from './export-html-script'
import { mappingColumnRoles, mappingTableTypes, renderSchemaErd, TABLE_TYPE_ICON, type ColumnRole, type TableType } from './export-html-erd'

export interface ExportHtmlOptions {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping?: SchemaMapping | null
  /** Full introspected schema (all tables + columns from information_schema). */
  fullSchema?: IntrospectedTable[] | null
}

type Counted = { patientCount: number; recordCount: number; visitCount?: number }
export type Anonymized<T> = T & { _anonymized?: boolean }

function anonymize<T extends Counted>(rows: T[], threshold: number, mode: AnonymizationMode): Anonymized<T>[] {
  if (mode === 'suppress') return rows.filter((r) => r.patientCount >= threshold)
  return rows.map((r) => (r.patientCount < threshold
    ? { ...r, patientCount: threshold, recordCount: threshold, ...(r.visitCount != null ? { visitCount: threshold } : {}), _anonymized: true }
    : r))
}

/** JSON safe to inline in a `<script>`: a `</script>` in a concept name cannot close it. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const fmt = (n: number) => n.toLocaleString('en')

export function generateCatalogHtml(opts: ExportHtmlOptions): string {
  const { catalog, cache, schemaMapping, fullSchema } = opts
  const threshold = catalog.anonymization.threshold
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'

  const concepts = anonymize(cache.concepts, threshold, mode).sort((a, b) => b.patientCount - a.patientCount)
  const published = buildPublishedCatalog(catalog, cache)

  const metadata = catalog.dcatApMetadata ?? {}
  const jsonLd = JSON.stringify(buildJsonLd({ metadata, schemaMapping, fullSchema, cache, catalog }), null, 2)

  const catalogTitle = (metadata['catalog.title'] as string) || localized(catalog.name, 'en')
  const catalogDesc = (metadata['catalog.description'] as string) || localized(catalog.description, 'en') || ''
  const publisher = (metadata['publisher.name'] as string) || (metadata['agent.name'] as string) || ''
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const table = buildConceptTable(concepts)
  const schema = buildSchemaSection(fullSchema, schemaMapping)
  const counts = catalogCounts(catalog)
  const totals = {
    patients: cache.totalPatients,
    ...(counts.visits ? { stays: cache.totalVisits } : {}),
    ...(counts.unitStays && cache.grandTotal.totalUnitStays != null ? { unitStays: cache.grandTotal.totalUnitStays } : {}),
    concepts: new Set(concepts.map((r) => r.conceptId)).size,
    records: cache.grandTotal.totalRecords,
  }

  const tab = (id: string, label: string, ico: IconName, count?: number, active = false) =>
    `<button class="tab${active ? ' active' : ''}" data-tab="${id}" role="tab" aria-selected="${active}">${icon(ico)}${label}${count != null ? `<span class="count num">${fmt(count)}</span>` : ''}</button>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(catalogTitle)} — Concept catalog</title>
<script type="application/ld+json">
${jsonLd.replace(/</g, '\\u003c')}
</script>
<style>${CATALOG_CSS}</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="brand">${LINKR_LOGO_SVG}<div class="brand-t"><h1>${esc(catalogTitle)}</h1><div class="eyebrow">Concept catalog</div></div></div>
    ${catalogDesc ? `<p class="desc">${esc(catalogDesc)}</p>` : ''}
    <nav class="tabs" role="tablist">
      ${tab('explore', 'Explore', 'barChart', undefined, true)}
      ${tab('metadata', 'Metadata', 'fileText')}
      ${tab('schema', 'Schema', 'table', schema.tableCount || undefined)}
      ${tab('info', 'Info', 'info')}
    </nav>
  </header>

  <section id="tab-explore" class="tab-content active">
    <div class="explore">
      <aside class="card xp-side" id="xp-side" aria-label="Display and filters"></aside>
      <div class="xp-main" id="xp-main"></div>
    </div>
  </section>

  <section id="tab-metadata" class="tab-content">
    <div class="section-head">
      <h2>Metadata</h2><span class="sub">Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE} · EHDS Regulation (EU) 2025/327</span><span class="spacer"></span>
      <button class="btn" id="open-jsonld" type="button" title="View the raw JSON-LD source">${icon('code')}JSON-LD</button>
    </div>
${buildMetadataHtml(metadata)}
  </section>

  <div id="jsonld-overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="jsonld-title">
    <div class="dialog">
      <div class="dialog-head">
        <div class="dialog-title" id="jsonld-title">${icon('code', 16)}JSON-LD source</div>
        <button class="btn" id="copy-jsonld" type="button">${icon('copy', 13)}<span>Copy</span></button>
        <button class="btn" id="download-jsonld" type="button">${icon('download', 13)}Download</button>
        <button class="btn icon-only" id="close-jsonld" type="button" title="Close" aria-label="Close">${icon('x', 16)}</button>
      </div>
      <pre class="dialog-body"><code id="jsonld-code">${syntaxHighlight(jsonLd)}</code></pre>
    </div>
  </div>

  <section id="tab-schema" class="tab-content">
    <div class="section-head">
      <h2>Data schema</h2><span class="sub">${[schemaMapping?.presetLabel ? localized(schemaMapping.presetLabel, 'en') : '', schema.tableCount ? `${schema.tableCount} tables` : ''].filter(Boolean).map(esc).join(' · ') || 'Source warehouse structure'}</span>
    </div>
${schema.html}
  </section>

  <section id="tab-info" class="tab-content">
${buildInfoHtml({ threshold, mode, counts, crossings: published.crossings.map((c) => c.vars.map((v) => published.variables[v]?.label ?? v)), variables: Object.values(published.variables).map((v) => v!.label) })}
  </section>

  <footer>
    <span>${[`Generated on ${generated}`, publisher].filter(Boolean).map(esc).join(' · ')}</span>
    <span>${icon('shield', 12)}Counts below ${threshold} patients are masked, and cells that would reveal them by subtraction too</span>
    <span>Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE} · EHDS Regulation (EU) 2025/327</span>
    <span>Generated with <a href="${LINKR_DOC_URL}" target="_blank" rel="noopener">Linkr</a></span>
  </footer>
</div>

<script>
var DATA = ${inlineJson({
    threshold,
    variables: published.variables,
    crossings: published.crossings,
    concepts: table,
    totals,
  })};
var META = ${inlineJson({
    fileBase: fileSlug(catalogTitle),
    conceptNote: icon('shield', 13) + (mode === 'suppress' ? `Concepts with fewer than ${threshold} patients are not listed` : `Counts below ${threshold} patients are shown as &lt; ${threshold}`),
  })};
var L = ${inlineJson({ charts: 'Charts', table: 'Table', download_csv: 'Download as CSV' })};
var ICONS = ${inlineJson({
    up: icon('arrowUp', 11), down: icon('arrowDown', 11), both: icon('arrowUpDown', 11),
    search: icon('search', 14), x: icon('x', 13), download: icon('download', 13),
    left: icon('chevronLeft', 14), right: icon('chevronRight', 14), shield: icon('shield', 13),
    user: icon('user', 16), stethoscope: icon('stethoscope', 16), activity: icon('activity', 16), tags: icon('tags', 16),
    layers: icon('layers', 16), trendingUp: icon('trendingUp', 16), barChart: icon('barChart', 16), sigma: icon('sigma', 16), table: icon('table', 16),
  })};
${CATALOG_SCRIPT}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

const LINKR_DOC_URL = 'https://linkr.interhop.org/en/docs/warehouse/data-catalog'
const EHDS_URL = 'https://eur-lex.europa.eu/eli/reg/2025/327/oj'

/** What the page is, how its numbers were made and protected, and where to read more. */
function buildInfoHtml({ threshold, mode, counts, crossings, variables }: {
  threshold: number
  mode: AnonymizationMode
  counts: CatalogCounts
  crossings: string[][]
  variables: string[]
}): string {
  const multi = crossings.filter((c) => c.length > 1)
  const card = (ico: IconName, title: string, body: string) =>
    `    <div class="card info-card"><div class="meta-card-head">${icon(ico, 15)}${title}</div><div class="info-body">${body}</div></div>`
  return [
    card('bookOpen', 'About this catalog', `<p>This page describes the content of a clinical data warehouse without giving access to it: how many patients, hospitalizations and records it holds, for which concepts, over which periods and populations. Every number is an aggregate count; no row about a patient ever leaves the warehouse.</p>
<p><b>Explore</b> reads the counts. Pick one, two or three variables in the sidebar, filter each of them, and the charts, key figures and table follow. <b>Metadata</b> describes the dataset in the Health-DCAT-AP vocabulary, and <b>Schema</b> the structure of the source warehouse.</p>`),
    card('barChart', 'How the counts are made', `<p>The warehouse is counted along ${variables.length ? variables.map((v) => `<b>${esc(v.toLowerCase())}</b>`).join(', ') : 'its concepts'}. Each variable is counted on its own${multi.length ? `, and these crossings were computed: ${multi.map((c) => esc(c.join(' × '))).join(', ')}` : ''}.</p>
<ul><li><b>Patients</b> are distinct patients: one seen in two periods counts once in each, so patients never add up across the values of a variable.</li>
${counts.visits ? '<li><b>Hospitalizations</b> are hospital stays (visits).</li>' : ''}
${counts.unitStays ? '<li><b>Unit stays</b> are the stays in a care unit within those hospitalizations.</li>' : ''}
<li><b>Records</b> are event rows (measurements, drugs, diagnoses…), counted when the concept variable is part of a crossing.</li>
<li>Period and age are taken at the start of the hospitalization, or at the date of the record.</li></ul>
<p>Cells are never summed on this page: every figure shown is one computed cell.</p>`),
    card('shield', 'Anonymisation', `<p>Any count below <b>${threshold} patients</b> is ${mode === 'suppress' ? 'removed' : 'masked (shown as &lt; ' + threshold + ')'}. That alone is not enough when a total is published: a hidden cell could be recovered by subtracting the other cells from the total. So one more cell of that group is masked too (<em>secondary suppression</em>). Masked cells carry no number in any published file.</p>
<p>Periods before the first and after the last one reaching the threshold are left out.</p>`),
    card('package', 'Standards and files', `<p>The metadata follows <a href="${HEALTHDCATAP_SPEC_URL}" target="_blank" rel="noopener">Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE}</a>, the European profile for describing health datasets under the <a href="${EHDS_URL}" target="_blank" rel="noopener">European Health Data Space regulation (EU) 2025/327</a>. It is embedded in this page as JSON-LD, readable by catalogues and search engines (Metadata › JSON-LD).</p>
<p>The published site holds this page, <code>concepts.csv</code> (one row per concept), one CSV per crossing under <code>crossings/</code>, and <code>metadata.jsonld</code>.</p>`),
    card('info', 'Made with Linkr', `<p>This catalog was computed and published with <a href="https://linkr.interhop.org" target="_blank" rel="noopener">Linkr</a>, an open-source platform for clinical data warehouses. How it is configured and computed: <a href="${LINKR_DOC_URL}" target="_blank" rel="noopener">Linkr documentation — Data catalog</a>.</p>`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Concepts table
// ---------------------------------------------------------------------------

/** Column spec of the page script's `createDataTable` (see export-html-script.ts). */
interface ConceptCol {
  key: string
  label: string
  type: 'text' | 'number'
  filter: 'text' | 'select' | 'min'
  width: number
  className?: string
}

export function buildConceptTable(concepts: Anonymized<CatalogConceptRow>[]) {
  const hasDictionary = new Set(concepts.map((r) => r.dictionaryKey).filter(Boolean)).size > 1
  const select = (key: string, label: string): ConceptCol => ({ key, label, type: 'text', filter: 'select', width: 150 })
  const count = (key: string, label: string): ConceptCol => ({ key, label, type: 'number', filter: 'min', width: 130 })
  const cols: ConceptCol[] = [
    { key: 'conceptId', label: 'Concept ID', type: 'text', filter: 'text', width: 130, className: 'id' },
    { key: 'conceptName', label: 'Concept name', type: 'text', filter: 'text', width: 380, className: 'name' },
    ...(hasDictionary ? [select('dictionaryKey', 'Vocabulary')] : []),
    ...(concepts.some((r) => r.category != null) ? [select('category', 'Category')] : []),
    ...(concepts.some((r) => r.subcategory != null) ? [select('subcategory', 'Subcategory')] : []),
    { ...count('patientCount', 'Patients'), className: 'p' },
    ...(concepts.some((r) => r.visitCount != null) ? [count('visitCount', 'Hospitalizations')] : []),
    count('recordCount', 'Records'),
  ]
  const rows = concepts.map((r) => [
    ...cols.map((c) => (r[c.key as keyof CatalogConceptRow] ?? '') as string | number),
    r._anonymized === true,
  ])
  return { cols, rows }
}

function fileSlug(title: string): string {
  return title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'catalog'
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface SchemaTable {
  name: string
  type?: TableType
  role?: string
  columns: { name: string; datatype?: string; role?: ColumnRole }[]
}

const TYPE_ORDER: TableType[] = ['patient', 'visit', 'concept', 'event']

const anchorId = (table: string) => `tbl-${table.replace(/[^a-zA-Z0-9_-]/g, '_')}`

function mappingRoleLabels(mapping: SchemaMapping): Map<string, string> {
  const labels = new Map<string, string>()
  // The first relation reading a table names its role (patient before visit before events).
  for (const t of mappedTableDocs(mapping)) if (!labels.has(t.table)) labels.set(t.table, t.role)
  return labels
}

/** The mapped columns only, for a source whose full schema was not introspected. */
function tablesFromMapping(m: SchemaMapping): SchemaTable[] {
  const byTable = new Map<string, SchemaTable>()
  for (const t of mappedTableDocs(m)) {
    const table = byTable.get(t.table) ?? { name: t.table, columns: [] }
    for (const c of t.columns) if (!table.columns.some((x) => x.name === c.name)) table.columns.push({ name: c.name })
    byTable.set(t.table, table)
  }
  return [...byTable.values()]
}

function buildSchemaSection(fullSchema?: IntrospectedTable[] | null, mapping?: SchemaMapping | null): { html: string; tableCount: number } {
  const types = mapping ? mappingTableTypes(mapping) : new Map<string, TableType>()
  const roles = mapping ? mappingColumnRoles(mapping) : new Map<string, Map<string, ColumnRole>>()
  const roleLabels = mapping ? mappingRoleLabels(mapping) : new Map<string, string>()

  const source: SchemaTable[] = fullSchema?.length
    ? fullSchema.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, datatype: c.type })) }))
    : mapping ? tablesFromMapping(mapping) : []
  const seen = new Set<string>()
  const tables = source
    .filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
    .map((t) => ({
      ...t,
      type: types.get(t.name),
      role: roleLabels.get(t.name),
      columns: t.columns.map((c) => ({ ...c, role: roles.get(t.name)?.get(c.name) })),
    }))
  const rank = (t: SchemaTable) => (t.type ? TYPE_ORDER.indexOf(t.type) : TYPE_ORDER.length)
  tables.sort((a, b) => rank(a) - rank(b))

  const erd = mapping ? renderSchemaErd(mapping, anchorId) : ''
  const erdHtml = erd ? `    <div class="card erd-card">
      <h3 class="eyebrow">Mapped tables</h3>
      <div class="erd-scroll">${erd}</div>
      <div class="legend">${TYPE_ORDER.map((t) => `<span><i class="swatch t-${t}"></i>${{ patient: 'Patients', visit: 'Visits', concept: 'Concept dictionaries', event: 'Event tables' }[t]}</span>`).join('')}${(['pk', 'fk', 'value', 'date'] as const).map((r) => `<span><i class="role r-${r}">${r}</i>${{ pk: 'Primary key', fk: 'Foreign key', value: 'Value', date: 'Date' }[r]}</span>`).join('')}<span>Click a table to see all its columns</span></div>
    </div>` : ''

  if (!tables.length) {
    return { html: erdHtml || '    <div class="card empty">No schema available.</div>', tableCount: 0 }
  }

  const toc = tables.map((t) =>
    `<a class="toc-item${t.type ? ` t-${t.type}` : ''}" href="#${anchorId(t.name)}" data-target="${anchorId(t.name)}" data-name="${esc(t.name.toLowerCase())}">${icon(t.type ? TABLE_TYPE_ICON[t.type] : 'table', 12)}<span class="name">${esc(t.name)}</span><span class="n num">${t.columns.length}</span></a>`,
  ).join('\n')

  const cards = tables.map((t) => {
    const withRoles = t.columns.some((c) => c.role)
    const rows = t.columns.map((c) =>
      `<tr><td class="c-name">${withRoles ? `<span class="role ${c.role ? `r-${c.role}` : 'none'}">${c.role ?? ''}</span>` : ''}<code>${esc(c.name)}</code></td><td class="c-type">${c.datatype ? `<code>${esc(c.datatype)}</code>` : ''}</td></tr>`,
    ).join('')
    return `      <div class="card tbl${t.type ? ` t-${t.type}` : ''}" id="${anchorId(t.name)}">
        <div class="tbl-head">${icon(t.type ? TABLE_TYPE_ICON[t.type] : 'table', 14)}<span class="tbl-name" title="${esc(t.name)}">${esc(t.name)}</span><span class="tbl-count num">${t.columns.length} col${t.columns.length === 1 ? '' : 's'}</span></div>
        ${t.role ? `<div class="tbl-role">${esc(t.role)}</div>` : ''}
        <table class="cols"><tbody>${rows}</tbody></table>
      </div>`
  }).join('\n')

  return {
    tableCount: tables.length,
    html: `${erdHtml}
    <div class="schema-layout">
      <aside class="card toc">
        <label class="toc-search">${icon('search', 13)}<input type="search" id="toc-filter" class="input" placeholder="Filter tables…" autocomplete="off"></label>
        <nav class="toc-list">
${toc}
        </nav>
      </aside>
      <div class="schema-main">
${cards}
      </div>
    </div>`,
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const CLASS_LABELS: Record<DcatClass, { title: string; icon: IconName }> = {
  catalog: { title: 'Catalog', icon: 'folderOpen' },
  dataset: { title: 'Dataset', icon: 'database' },
  distribution: { title: 'Distribution', icon: 'package' },
  agent: { title: 'Contacts and organisations', icon: 'building' },
}

const CLASS_ORDER: DcatClass[] = ['catalog', 'dataset', 'distribution', 'agent']

/** The field's English label — the published page is English, whatever the app's language. */
// Widened on purpose: handing the JSON's literal type (thousands of keys) to
// reduce() made every overload check compare against it — minutes of tsc time.
const EN_BUNDLE: unknown = en
const enLabel = (labelKey: string): string => {
  let leaf: unknown = EN_BUNDLE
  for (const k of labelKey.split('.')) leaf = (leaf as Record<string, unknown> | undefined)?.[k]
  return typeof leaf === 'string' ? leaf : labelKey
}

function buildMetadataHtml(raw: Record<string, unknown>): string {
  const metadata = normalizeDcatMetadata(raw)
  const sections = CLASS_ORDER.flatMap((cls) => {
    const filled = DCAT_FIELDS.filter((f) => f.dcatClass === cls && metadata[f.key] != null && metadata[f.key] !== '')
    if (!filled.length) return []
    const rows = filled.map((f) => `        <div class="meta-row">
          <div class="meta-label">${esc(enLabel(f.labelKey))}</div>
          <div class="meta-value">${resolveFieldDisplay(f.key, metadata[f.key], f.type, f.vocabularyKey)}</div>
          <div class="meta-uri">${esc(f.uri)}</div>
        </div>`).join('\n')
    const { title, icon: ico } = CLASS_LABELS[cls]
    return [`    <div class="card meta-card">
      <div class="meta-card-head">${icon(ico, 15)}${title}</div>
${rows}
    </div>`]
  })
  return sections.length ? sections.join('\n') : '    <div class="card empty">No Health-DCAT-AP metadata has been filled in for this catalog.</div>'
}

function resolveFieldDisplay(key: string, raw: unknown, type: string, vocabKey?: string): string {
  if (vocabKey && DCAT_VOCABULARIES[vocabKey]) {
    const vocab = DCAT_VOCABULARIES[vocabKey]
    const values = typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw.map(String) : [String(raw)]
    return values.map((v) => {
      const opt = vocab.find((o) => o.value === v)
      return `<span class="pill">${esc(opt ? opt.label : v)}</span>`
    }).join('')
  }

  if (type === 'uri') {
    const url = String(raw)
    const safe = /^(https?:|mailto:)/i.test(url)
    return safe ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : esc(url)
  }

  // Keywords are semicolon-separated; older catalogs used commas.
  if (key.endsWith('.keyword')) {
    const str = String(raw)
    const sep = str.includes(';') ? ';' : ','
    return str.split(sep).map((s) => s.trim()).filter(Boolean).map((k) => `<span class="pill">${esc(k)}</span>`).join('')
  }

  if (type === 'boolean') return raw === true || raw === 'true' ? 'Yes' : 'No'

  if (type === 'tags' && Array.isArray(raw)) {
    return raw.map((k) => `<span class="pill">${esc(String(k))}</span>`).join('')
  }

  if (type === 'number') {
    const n = Number(raw)
    return isNaN(n) ? esc(String(raw)) : `<strong class="num">${n.toLocaleString('en')}</strong>`
  }

  return esc(String(raw))
}

/** JSON coloured for the viewer. Works on the escaped text, so quotes are `&quot;`. */
function syntaxHighlight(json: string): string {
  return esc(json)
    .replace(/&quot;([^&]*)&quot;(\s*:)/g, '<span class="json-key">&quot;$1&quot;</span>$2')
    .replace(/:\s*&quot;([^&]*)&quot;/g, ': <span class="json-str">&quot;$1&quot;</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)\b/g, ': <span class="json-num">$1</span>')
    .replace(/:\s*(true|false|null)\b/g, ': <span class="json-bool">$1</span>')
}

// ---------------------------------------------------------------------------
// CSV export builders
// ---------------------------------------------------------------------------

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Build CSV string from concept rows with anonymization applied. */
export function buildConceptsCsv(
  concepts: CatalogConceptRow[],
  catalog: DataCatalog,
): string {
  const threshold = catalog.anonymization.threshold
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'

  const withVisits = concepts.some((r) => r.visitCount != null)
  const header = ['concept_id', 'concept_name', 'vocabulary', 'category', 'subcategory',
    'patient_count', ...(withVisits ? ['visit_count'] : []), 'record_count']
  const rows: string[] = [header.join(',')]

  for (const r of concepts) {
    if (mode === 'suppress' && r.patientCount < threshold) continue
    const belowThreshold = r.patientCount < threshold
    const pc = mode === 'replace' && belowThreshold ? threshold : r.patientCount
    const vc = mode === 'replace' && belowThreshold ? threshold : r.visitCount
    const rc = mode === 'replace' && belowThreshold ? threshold : r.recordCount
    rows.push([
      csvEscape(r.conceptId), csvEscape(r.conceptName),
      csvEscape(r.dictionaryKey ?? ''), csvEscape(r.category ?? ''), csvEscape(r.subcategory ?? ''),
      String(pc), ...(withVisits ? [String(vc ?? 0)] : []), String(rc),
    ].join(','))
  }

  return rows.join('\n')
}
