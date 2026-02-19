/**
 * Standalone HTML export for concept catalogs.
 *
 * Generates a self-contained HTML page with:
 * - Embedded JSON-LD (machine-readable metadata, always included)
 * - Four tabs: Metadata (JSON-LD), Schema (data dictionary), Dashboard (stats + charts), Data Table (paginated)
 * - Data Table has two sub-tabs: Concepts and Dimensions
 * - Anonymization: rows below threshold are either capped (replace) or removed (suppress)
 */

import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogDimensionRow, SchemaMapping, AnonymizationMode } from '@/types'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { buildJsonLd } from './jsonld'
import { DCAT_FIELDS, DCAT_VOCABULARIES, type DcatClass } from './schema'

export interface ExportHtmlOptions {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping?: SchemaMapping | null
  /** Full introspected schema (all tables + columns from information_schema). */
  fullSchema?: IntrospectedTable[] | null
}

export function generateCatalogHtml(opts: ExportHtmlOptions): string {
  const { catalog, cache, schemaMapping, fullSchema } = opts
  const threshold = catalog.anonymization.threshold
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'

  // Apply anonymization to concept rows
  let concepts: CatalogConceptRow[]
  let anonConceptCount = 0
  if (mode === 'suppress') {
    concepts = cache.concepts.filter((r) => r.patientCount >= threshold)
    anonConceptCount = cache.concepts.length - concepts.length
  } else {
    concepts = cache.concepts.map((r) => {
      if (r.patientCount < threshold) {
        anonConceptCount++
        return { ...r, patientCount: threshold, recordCount: threshold, visitCount: threshold, _anonymized: true }
      }
      return r
    })
  }

  // Apply anonymization to dimension rows
  let dimensions: CatalogDimensionRow[]
  let anonDimCount = 0
  if (mode === 'suppress') {
    dimensions = cache.dimensions.filter((r) => r.patientCount >= threshold)
    anonDimCount = cache.dimensions.length - dimensions.length
  } else {
    dimensions = cache.dimensions.map((r) => {
      if (r.patientCount < threshold) {
        anonDimCount++
        return { ...r, patientCount: threshold, recordCount: threshold, visitCount: threshold, _anonymized: true }
      }
      return r
    })
  }

  const totalAnonymized = anonConceptCount + anonDimCount

  // Check for multiple dictionaries
  const dictionaryKeys = new Set(concepts.map((r) => r.dictionaryKey).filter(Boolean))
  const hasDictionary = dictionaryKeys.size > 1

  // Summary stats
  const totalConcepts = new Set(concepts.map((r) => r.conceptId)).size
  const totalPatients = cache.totalPatients
  const totalVisits = cache.totalVisits

  // Collect enabled dimension IDs for charts + sub-tables
  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimIds = enabledDims.map((d) => d.id)

  // JSON-LD
  const metadata = catalog.dcatApMetadata ?? {}
  const jsonLdObj = buildJsonLd({ metadata, schemaMapping, fullSchema, cache, catalog })
  const jsonLd = JSON.stringify(jsonLdObj, null, 2)

  const catalogTitle = (metadata['catalog.title'] as string) || catalog.name
  const catalogDesc = (metadata['catalog.description'] as string) || catalog.description || ''
  const publisher = (metadata['agent.name'] as string) || (metadata['catalog.publisher'] as string) || ''

  // Build concept filter columns info for JS
  const conceptFilterCols: FilterColInfo[] = []
  if (hasDictionary) conceptFilterCols.push({ key: 'dictionaryKey', label: 'Vocabulary' })
  if (catalog.categoryColumn) conceptFilterCols.push({ key: 'category', label: 'Category' })
  if (catalog.subcategoryColumn) conceptFilterCols.push({ key: 'subcategory', label: 'Subcategory' })

  // Build chart definitions from dimension data
  const chartDefs: ChartDef[] = []
  for (const dim of enabledDims) {
    const isDate = dim.type === 'admission_date'
    chartDefs.push({
      dimId: dim.id,
      title: `${titleCase(dim.id)} distribution`,
      type: isDate ? 'vertical' : 'horizontal',
      limit: isDate ? 60 : 30,
    })
  }

  // Build concept filter HTML — dropdowns
  const conceptFilterHtml = conceptFilterCols.map((f) =>
    `      <select id="filter-${f.key}" class="filter-select" data-col="${f.key}"><option value="">All ${esc(f.label)}</option></select>`,
  ).join('\n')

  // Build schema HTML from SchemaMapping
  const schemaHtml = buildSchemaHtml(fullSchema, schemaMapping)

  // Build metadata rendered UI + raw JSON-LD
  const metadataRenderedHtml = buildMetadataRenderedHtml(metadata)
  const jsonLdHighlighted = syntaxHighlight(jsonLd)

  // Build concept table headers
  const conceptThs = [
    '            <th data-col="conceptId" class="sortable">Concept ID</th>',
    '            <th data-col="conceptName" class="sortable">Concept Name</th>',
    ...(hasDictionary ? ['            <th data-col="dictionaryKey" class="sortable">Vocabulary</th>'] : []),
    ...(catalog.categoryColumn ? ['            <th data-col="category" class="sortable">Category</th>'] : []),
    ...(catalog.subcategoryColumn ? ['            <th data-col="subcategory" class="sortable">Subcategory</th>'] : []),
    '            <th data-col="patientCount" class="sortable num">Patients</th>',
    '            <th data-col="visitCount" class="sortable num">Visits</th>',
    '            <th data-col="recordCount" class="sortable num">Records</th>',
  ].join('\n')

  // Build dimension sub-tables HTML (one per enabled dimension)
  const dimTablesHtml = enabledDims.map((dim) => `
        <div class="dim-section" id="dim-section-${dim.id}">
          <h3 class="dim-title">${esc(titleCase(dim.id))}</h3>
          <div class="table-wrapper">
            <table class="dim-table" id="dim-table-${dim.id}">
              <thead>
                <tr>
                  <th class="sortable" data-col="value">Value</th>
                  <th class="sortable num" data-col="patientCount">Patients</th>
                  <th class="sortable num" data-col="visitCount">Visits</th>
                  <th class="sortable num" data-col="recordCount">Records</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>`).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(catalogTitle)} — Concept Catalog</title>
<script type="application/ld+json">
${esc(jsonLd)}
</script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer" />
<style>
${CSS}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${esc(catalogTitle)}</h1>
    ${catalogDesc ? `<p class="description">${esc(catalogDesc)}</p>` : ''}
    ${publisher ? `<p class="publisher">${esc(publisher)}</p>` : ''}
    <p class="generated">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} by Linkr</p>
  </header>

  <!-- Tab navigation -->
  <div class="tabs">
    <button class="tab active" data-tab="metadata">Metadata</button>
    <button class="tab" data-tab="schema">Schema</button>
    <button class="tab" data-tab="dashboard">Dashboard</button>
    <button class="tab" data-tab="datatable">Data Table</button>
  </div>

  <!-- Metadata tab: rendered UI + JSON-LD viewer button -->
  <div id="tab-metadata" class="tab-content active">
    <div class="metadata-section">
      <div class="metadata-header">
        <h2 class="metadata-title">Health-DCAT-AP Release 6</h2>
        <p class="metadata-subtitle">EHDS Regulation (EU) 2025/327</p>
        <button class="jsonld-view-btn" id="open-jsonld" title="View raw JSON-LD source"><i class="fa-solid fa-code"></i> JSON-LD</button>
      </div>
${metadataRenderedHtml}
    </div>
  </div>

  <!-- JSON-LD fullscreen overlay -->
  <div id="jsonld-overlay" class="jsonld-overlay" style="display:none">
    <div class="jsonld-overlay-header">
      <span class="jsonld-overlay-title"><i class="fa-solid fa-code"></i> JSON-LD Source</span>
      <div class="jsonld-overlay-actions">
        <button class="copy-btn" id="copy-jsonld" title="Copy to clipboard">Copy</button>
        <button class="jsonld-close-btn" id="close-jsonld" title="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <pre class="json-block jsonld-overlay-code"><code id="jsonld-code">${jsonLdHighlighted}</code></pre>
  </div>

  <!-- Schema tab: data dictionary -->
  <div id="tab-schema" class="tab-content" style="display:none">
    <div class="schema-section">
      <h2 class="metadata-title">Data Schema${schemaMapping?.presetLabel ? ` — ${esc(schemaMapping.presetLabel)}` : ''}${fullSchema ? ` — ${fullSchema.length} tables` : ''}</h2>
      <p class="metadata-subtitle">Source warehouse structure · tables and columns</p>
${schemaHtml}
    </div>
  </div>

  <!-- Dashboard tab -->
  <div id="tab-dashboard" class="tab-content" style="display:none">
    <div class="stats-grid" id="stats-grid"></div>
    <div class="charts-grid" id="charts-grid"></div>
  </div>

  <!-- Data Table tab -->
  <div id="tab-datatable" class="tab-content" style="display:none">
    <!-- Sub-tabs: Concepts / Dimensions -->
    <div class="subtabs">
      <button class="subtab active" data-subtab="concepts">Concepts</button>
      <button class="subtab" data-subtab="dimensions">Dimensions</button>
    </div>

    <!-- Concepts sub-tab -->
    <div id="subtab-concepts" class="subtab-content active">
      <div class="filters-bar" id="concept-filters">
        <input type="text" id="concept-search" placeholder="Search concepts..." class="search-input" />
${conceptFilterHtml}
        <button id="concept-clear-filters" class="clear-btn" title="Clear all filters"><i class="fa-solid fa-xmark"></i> Clear</button>
        <span id="concept-row-count" class="row-count"></span>
      </div>
      <div class="table-wrapper">
        <table id="concept-table">
          <thead>
            <tr>
${conceptThs}
            </tr>
          </thead>
          <tbody id="concept-tbody"></tbody>
        </table>
      </div>
      <div class="pagination" id="concept-pagination">
        <button id="concept-page-prev" class="page-btn" disabled>&laquo; Prev</button>
        <span id="concept-page-info" class="page-info">Page 1</span>
        <button id="concept-page-next" class="page-btn">Next &raquo;</button>
        <select id="concept-page-size" class="filter-select">
          <option value="100">100 rows</option>
          <option value="250">250 rows</option>
          <option value="500">500 rows</option>
          <option value="1000">1000 rows</option>
        </select>
      </div>
    </div>

    <!-- Dimensions sub-tab -->
    <div id="subtab-dimensions" class="subtab-content" style="display:none">
${dimTablesHtml || '      <p class="schema-empty">No dimensions enabled.</p>'}
    </div>
  </div>

  <footer>
    <p>Anonymization: threshold = ${threshold} patients · mode = ${mode === 'suppress' ? 'suppress (rows removed)' : 'replace (counts capped)'} · ${totalAnonymized} row${totalAnonymized !== 1 ? 's' : ''} affected.</p>
    <p>Health-DCAT-AP Release 6 · EHDS Regulation (EU) 2025/327</p>
  </footer>
</div>

<script>
var CONCEPTS = ${buildConceptsJson(concepts as (CatalogConceptRow & { _anonymized?: boolean })[], hasDictionary, !!catalog.categoryColumn, !!catalog.subcategoryColumn)};
var DIMENSIONS = ${JSON.stringify(buildDimensionsJson(dimensions as (CatalogDimensionRow & { _anonymized?: boolean })[]))};
var CATALOG_META = ${JSON.stringify({ totalConcepts, totalPatients, totalVisits, totalRecords: cache.grandTotal.totalRecords, anonymizedConcepts: anonConceptCount, anonymizedDimensions: anonDimCount, threshold, mode })};
var CHART_DEFS = ${JSON.stringify(chartDefs)};
var DIM_IDS = ${JSON.stringify(dimIds)};
${buildJS(conceptFilterCols)}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Schema HTML builder
// ---------------------------------------------------------------------------

function buildSchemaHtml(fullSchema?: IntrospectedTable[] | null, schemaMapping?: SchemaMapping | null): string {
  if (!fullSchema?.length && !schemaMapping) {
    return '      <p class="schema-empty">No schema available.</p>'
  }

  // Build a set of mapped table names + semantic descriptions from SchemaMapping
  const mappedTableRoles = new Map<string, string>()
  if (schemaMapping) {
    if (schemaMapping.patientTable) mappedTableRoles.set(schemaMapping.patientTable.table, 'Patient demographics')
    if (schemaMapping.visitTable) mappedTableRoles.set(schemaMapping.visitTable.table, 'Visit / encounter records')
    if (schemaMapping.visitDetailTable) mappedTableRoles.set(schemaMapping.visitDetailTable.table, 'Visit detail / unit stays')
    if (schemaMapping.conceptTables) {
      for (const cd of schemaMapping.conceptTables) mappedTableRoles.set(cd.table, 'Concept dictionary')
    }
    if (schemaMapping.eventTables) {
      for (const [label, et] of Object.entries(schemaMapping.eventTables)) mappedTableRoles.set(et.table, label)
    }
  }

  // If full schema is available, render all introspected tables
  if (fullSchema && fullSchema.length > 0) {
    return fullSchema.map((t) => {
      const role = mappedTableRoles.get(t.name) ?? ''
      const rows = t.columns.map((c) =>
        `            <tr><td class="col-name"><code>${esc(c.name)}</code></td><td class="col-type"><code>${esc(c.type)}</code></td><td class="col-desc">${c.nullable ? 'NULL' : 'NOT NULL'}</td></tr>`,
      ).join('\n')
      return `      <div class="schema-table-card">
        <div class="schema-table-header">
          <span class="schema-table-name">${esc(t.name)}</span>
          ${role ? `<span class="schema-table-desc">${esc(role)}</span>` : ''}
          <span class="schema-table-count">${t.columns.length} columns</span>
        </div>
        <table class="schema-cols">
          <thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`
    }).join('\n')
  }

  // Fallback: render only mapped tables from SchemaMapping (legacy)
  const tables: { name: string; description: string; columns: { name: string; datatype: string }[] }[] = []

  if (schemaMapping!.patientTable) {
    const pt = schemaMapping!.patientTable
    const cols = [{ name: pt.idColumn, datatype: 'integer' }]
    if (pt.birthDateColumn) cols.push({ name: pt.birthDateColumn, datatype: 'date' })
    if (pt.birthYearColumn) cols.push({ name: pt.birthYearColumn, datatype: 'integer' })
    if (pt.genderColumn) cols.push({ name: pt.genderColumn, datatype: 'string' })
    tables.push({ name: pt.table, description: 'Patient demographics', columns: cols })
  }
  if (schemaMapping!.visitTable) {
    const vt = schemaMapping!.visitTable
    const cols = [{ name: vt.idColumn, datatype: 'integer' }, { name: vt.patientIdColumn, datatype: 'integer' }, { name: vt.startDateColumn, datatype: 'datetime' }]
    if (vt.endDateColumn) cols.push({ name: vt.endDateColumn, datatype: 'datetime' })
    if (vt.typeColumn) cols.push({ name: vt.typeColumn, datatype: 'string' })
    tables.push({ name: vt.table, description: 'Visit / encounter records', columns: cols })
  }
  if (schemaMapping!.conceptTables) {
    for (const cd of schemaMapping!.conceptTables) {
      const cols = [{ name: cd.idColumn, datatype: 'integer' }, { name: cd.nameColumn, datatype: 'string' }]
      if (cd.codeColumn) cols.push({ name: cd.codeColumn, datatype: 'string' })
      if (cd.vocabularyColumn) cols.push({ name: cd.vocabularyColumn, datatype: 'string' })
      tables.push({ name: cd.table, description: 'Concept dictionary', columns: cols })
    }
  }
  if (schemaMapping!.eventTables) {
    for (const [label, et] of Object.entries(schemaMapping!.eventTables)) {
      const cols = [{ name: et.conceptIdColumn, datatype: 'integer' }]
      if (et.patientIdColumn) cols.push({ name: et.patientIdColumn, datatype: 'integer' })
      if (et.dateColumn) cols.push({ name: et.dateColumn, datatype: 'datetime' })
      tables.push({ name: et.table, description: label, columns: cols })
    }
  }

  if (tables.length === 0) return '      <p class="schema-empty">No tables defined in schema mapping.</p>'

  return tables.map((t) => {
    const rows = t.columns.map((c) =>
      `            <tr><td class="col-name"><code>${esc(c.name)}</code></td><td class="col-type"><code>${esc(c.datatype)}</code></td><td></td></tr>`,
    ).join('\n')
    return `      <div class="schema-table-card">
        <div class="schema-table-header">
          <span class="schema-table-name">${esc(t.name)}</span>
          <span class="schema-table-desc">${esc(t.description)}</span>
          <span class="schema-table-count">${t.columns.length} columns</span>
        </div>
        <table class="schema-cols">
          <thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`
  }).join('\n')
}

// ---------------------------------------------------------------------------
// Metadata rendered UI builder
// ---------------------------------------------------------------------------

const CLASS_LABELS: Record<DcatClass, { title: string; icon: string }> = {
  catalog: { title: 'Catalog', icon: '<i class="fa-solid fa-folder-open"></i>' },
  dataset: { title: 'Dataset', icon: '<i class="fa-solid fa-chart-bar"></i>' },
  distribution: { title: 'Distribution', icon: '<i class="fa-solid fa-cube"></i>' },
  agent: { title: 'Publisher / Agent', icon: '<i class="fa-solid fa-building"></i>' },
}

const CLASS_ORDER: DcatClass[] = ['catalog', 'dataset', 'distribution', 'agent']

function buildMetadataRenderedHtml(metadata: Record<string, unknown>): string {
  const sections: string[] = []

  for (const cls of CLASS_ORDER) {
    const fields = DCAT_FIELDS.filter((f) => f.dcatClass === cls)
    // Only show fields that have a value
    const filledFields = fields.filter((f) => {
      const val = metadata[f.key]
      return val != null && val !== ''
    })
    if (filledFields.length === 0) continue

    const { title, icon } = CLASS_LABELS[cls]
    const rows = filledFields.map((f) => {
      const raw = metadata[f.key]
      const display = resolveFieldDisplay(f.key, raw, f.type, f.vocabularyKey)
      const obligationBadge = f.obligation === 'mandatory'
        ? '<span class="meta-badge meta-badge-m">mandatory</span>'
        : f.obligation === 'recommended'
          ? '<span class="meta-badge meta-badge-r">recommended</span>'
          : ''
      const rdfProp = `<span class="meta-rdf">${esc(f.uri)}</span>`
      return `          <div class="meta-row">
            <div class="meta-label">${esc(f.labelKey.replace(/^dcat\./, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))} ${obligationBadge}</div>
            <div class="meta-value">${display}</div>
            <div class="meta-uri">${rdfProp}</div>
          </div>`
    }).join('\n')

    sections.push(`      <div class="meta-card">
        <div class="meta-card-header"><span class="meta-icon">${icon}</span> ${title}</div>
${rows}
      </div>`)
  }

  return sections.join('\n')
}

function resolveFieldDisplay(key: string, raw: unknown, type: string, vocabKey?: string): string {
  if (raw == null || raw === '') return '<span class="meta-empty">—</span>'

  // Multiselect / select with vocabulary
  if (vocabKey && DCAT_VOCABULARIES[vocabKey]) {
    const vocab = DCAT_VOCABULARIES[vocabKey]
    const values = typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw.map(String) : [String(raw)]

    const labels = values.map((v) => {
      const opt = vocab.find((o) => o.value === v)
      // Resolve labelKey to readable text: strip 'dcat.' prefix, replace _ with space, title case
      const label = opt
        ? opt.labelKey.replace(/^dcat\./, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : v
      return `<span class="meta-tag">${esc(label)}</span>`
    })
    return labels.join(' ')
  }

  // URI
  if (type === 'uri') {
    const url = String(raw)
    return `<a href="${esc(url)}" class="meta-link" target="_blank" rel="noopener">${esc(url)}</a>`
  }

  // Keywords (semicolon-separated, also accepts comma for backward compat)
  if (key.endsWith('.keyword')) {
    const str = String(raw)
    const sep = str.includes(';') ? ';' : ','
    const kws = str.split(sep).map((s) => s.trim()).filter(Boolean)
    return kws.map((k) => `<span class="meta-tag">${esc(k)}</span>`).join(' ')
  }

  // Number
  if (type === 'number') {
    const n = Number(raw)
    return isNaN(n) ? esc(String(raw)) : `<strong>${n.toLocaleString()}</strong>`
  }

  return esc(String(raw))
}

// ---------------------------------------------------------------------------
// Syntax highlighting for JSON (pure string manipulation, no deps)
// ---------------------------------------------------------------------------

function syntaxHighlight(json: string): string {
  // Escape HTML entities first
  const escaped = esc(json)
  // After esc(), " becomes &quot; — work with escaped entities
  return escaped
    // Keys: &quot;key&quot; followed by :
    .replace(/&quot;([^&]*)&quot;(\s*:)/g, '<span class="json-key">&quot;$1&quot;</span>$2')
    // String values: : &quot;value&quot;
    .replace(/:\s*&quot;([^&]*)&quot;/g, ': <span class="json-str">&quot;$1&quot;</span>')
    // Numbers
    .replace(/:\s*(\d+(?:\.\d+)?)\b/g, ': <span class="json-num">$1</span>')
    // Booleans and null
    .replace(/:\s*(true|false|null)\b/g, ': <span class="json-bool">$1</span>')
}

// ---------------------------------------------------------------------------
// Row data as JSON (for client-side rendering)
// ---------------------------------------------------------------------------

function buildConceptsJson(
  rows: (CatalogConceptRow & { _anonymized?: boolean })[],
  hasDictionary: boolean,
  hasCategory: boolean,
  hasSubcategory: boolean,
): string {
  const data = rows.map((r) => {
    const isAnonymized = r._anonymized === true
    const row: (string | number | boolean)[] = [
      r.conceptId,
      r.conceptName,
    ]
    if (hasDictionary) row.push(r.dictionaryKey ?? '')
    if (hasCategory) row.push(r.category ?? '')
    if (hasSubcategory) row.push(r.subcategory ?? '')
    row.push(r.patientCount)
    row.push(r.visitCount)
    row.push(r.recordCount)
    row.push(isAnonymized)
    return row
  })
  return JSON.stringify(data)
}

/** Build dimension data grouped by dimensionId: { dimId: [[value, patients, visits, records, isAnon], ...] } */
function buildDimensionsJson(
  rows: (CatalogDimensionRow & { _anonymized?: boolean })[],
): Record<string, (string | number | boolean)[][]> {
  const result: Record<string, (string | number | boolean)[][]> = {}
  for (const r of rows) {
    if (!result[r.dimensionId]) result[r.dimensionId] = []
    result[r.dimensionId].push([r.value, r.patientCount, r.visitCount, r.recordCount, r._anonymized === true])
  }
  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilterColInfo {
  key: string
  label: string
}

interface ChartDef {
  dimId: string
  title: string
  type: 'horizontal' | 'vertical'
  limit: number
}

// ---------------------------------------------------------------------------
// Embedded CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #ffffff;
  --fg: #1a1a2e;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card-bg: #f9fafb;
  --accent: #0d9488;
  --accent-light: #ccfbf1;
  --accent-20: rgba(13,148,136,0.2);
  --warn: #f59e0b;
  --warn-light: rgba(245,158,11,0.1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --fg: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
    --card-bg: #1e293b;
    --accent: #2dd4bf;
    --accent-light: #134e4a;
    --accent-20: rgba(45,212,191,0.2);
    --warn: #fbbf24;
    --warn-light: rgba(251,191,36,0.1);
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; }
.container { max-width: 1400px; margin: 0 auto; padding: 2rem 1.5rem; }

header { margin-bottom: 1.5rem; }
header h1 { font-size: 1.5rem; font-weight: 700; }
header .description { margin-top: 0.25rem; color: var(--muted); font-size: 0.875rem; }
header .publisher { margin-top: 0.25rem; color: var(--accent); font-size: 0.8125rem; font-weight: 500; }
header .generated { margin-top: 0.5rem; color: var(--muted); font-size: 0.75rem; }

/* Shared filters bar */
.filters-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 1rem; padding: 0.75rem; background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; }
.search-input { flex: 0 0 220px; padding: 0.4rem 0.75rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.8125rem; background: var(--bg); color: var(--fg); outline: none; }
.search-input:focus { border-color: var(--accent); }
.filter-select { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.75rem; background: var(--bg); color: var(--fg); outline: none; max-width: 180px; }
.filter-select:focus { border-color: var(--accent); }
.clear-btn { padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.6875rem; background: var(--bg); color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
.clear-btn:hover { border-color: var(--accent); color: var(--accent); }
.row-count { font-size: 0.75rem; color: var(--muted); margin-left: auto; }

/* Tabs */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; }
.tab { padding: 0.5rem 1.25rem; font-size: 0.875rem; font-weight: 500; color: var(--muted); background: none; border: none; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
.tab:hover { color: var(--fg); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Sub-tabs (inside Data Table) */
.subtabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
.subtab { padding: 0.4rem 1rem; font-size: 0.8125rem; font-weight: 500; color: var(--muted); background: none; border: none; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
.subtab:hover { color: var(--fg); }
.subtab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Metadata tab */
.metadata-section { }
.metadata-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.75rem; margin-bottom: 1rem; }
.metadata-title { font-size: 1rem; font-weight: 600; }
.metadata-subtitle { font-size: 0.75rem; color: var(--muted); }

/* Metadata cards */
.meta-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; margin-bottom: 1rem; overflow: hidden; }
.meta-card-header { padding: 0.6rem 1rem; font-weight: 600; font-size: 0.875rem; border-bottom: 1px solid var(--border); background: var(--bg); }
.meta-icon { margin-right: 0.35rem; color: var(--accent); font-size: 0.8125rem; }
.meta-row { display: grid; grid-template-columns: 180px 1fr auto; gap: 0.5rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); align-items: baseline; }
.meta-row:last-child { border-bottom: none; }
.meta-label { font-size: 0.8125rem; font-weight: 500; color: var(--fg); display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
.meta-value { font-size: 0.8125rem; color: var(--fg); }
.meta-value strong { color: var(--accent); font-weight: 700; }
.meta-uri { font-size: 0.6875rem; color: var(--muted); text-align: right; }
.meta-rdf { font-family: 'SF Mono', Menlo, monospace; font-size: 0.625rem; }
.meta-empty { color: var(--muted); font-style: italic; }
.meta-tag { display: inline-block; padding: 0.1rem 0.5rem; margin: 0.1rem 0.15rem; background: var(--accent-20); color: var(--accent); border-radius: 0.25rem; font-size: 0.75rem; font-weight: 500; }
.meta-badge { display: inline-block; padding: 0 0.3rem; border-radius: 0.2rem; font-size: 0.5625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; vertical-align: middle; }
.meta-badge-m { background: var(--accent-20); color: var(--accent); }
.meta-badge-r { background: var(--warn-light); color: var(--warn); }
.meta-link { color: var(--accent); text-decoration: none; font-size: 0.8125rem; word-break: break-all; }
.meta-link:hover { text-decoration: underline; }

/* JSON-LD view button */
.jsonld-view-btn { padding: 0.3rem 0.75rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.75rem; font-weight: 500; background: var(--bg); color: var(--muted); cursor: pointer; margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem; transition: all 0.15s; }
.jsonld-view-btn:hover { border-color: var(--accent); color: var(--accent); }

/* JSON-LD fullscreen overlay */
.jsonld-overlay { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: flex; flex-direction: column; }
.jsonld-overlay-header { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.jsonld-overlay-title { font-size: 0.875rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem; }
.jsonld-overlay-actions { display: flex; align-items: center; gap: 0.5rem; }
.jsonld-close-btn { padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.875rem; background: var(--bg); color: var(--fg); cursor: pointer; }
.jsonld-close-btn:hover { border-color: var(--accent); color: var(--accent); }
.jsonld-overlay-code { flex: 1; overflow: auto; margin: 0; border: none; border-radius: 0; }

.copy-btn { padding: 0.25rem 0.6rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.6875rem; background: var(--bg); color: var(--fg); cursor: pointer; }
.copy-btn:hover { border-color: var(--accent); color: var(--accent); }

.json-block { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; overflow-x: auto; font-size: 0.8125rem; line-height: 1.6; tab-size: 2; margin-top: 0.5rem; }
.json-block code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace; white-space: pre; }
.json-key { color: #0d9488; }
.json-str { color: #059669; }
.json-num { color: #d97706; }
.json-bool { color: #7c3aed; }

@media (prefers-color-scheme: dark) {
  .json-key { color: #2dd4bf; }
  .json-str { color: #34d399; }
  .json-num { color: #fbbf24; }
  .json-bool { color: #a78bfa; }
}

/* Schema tab */
.schema-section { }
.schema-empty { color: var(--muted); font-size: 0.875rem; font-style: italic; }
.schema-table-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; margin-bottom: 1rem; overflow: hidden; }
.schema-table-header { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
.schema-table-name { font-weight: 600; font-size: 0.875rem; font-family: 'SF Mono', Menlo, monospace; color: var(--accent); }
.schema-table-desc { font-size: 0.8125rem; color: var(--muted); }
.schema-table-count { margin-left: auto; font-size: 0.6875rem; color: var(--muted); }
.schema-cols { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
.schema-cols th { padding: 0.4rem 0.75rem; text-align: left; font-weight: 600; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); }
.schema-cols td { padding: 0.35rem 0.75rem; border-bottom: 1px solid var(--border); }
.schema-cols tr:last-child td { border-bottom: none; }
.schema-cols .col-name code { font-family: 'SF Mono', Menlo, monospace; font-size: 0.8125rem; color: var(--accent); }
.schema-cols .col-desc { color: var(--muted); font-size: 0.75rem; }
.schema-cols .col-type code { font-family: 'SF Mono', Menlo, monospace; font-size: 0.75rem; color: var(--muted); }

/* Stats */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; text-align: center; }
.stat-value { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }

/* Charts */
.charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 1rem; }
.chart-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; }
.chart-title { font-size: 0.8125rem; font-weight: 600; margin-bottom: 0.75rem; }

/* Horizontal bar chart */
.bar-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
.bar-label { width: 120px; font-size: 0.6875rem; color: var(--muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.bar-track { flex: 1; height: 16px; background: var(--accent-20); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
.bar-value { width: 60px; font-size: 0.6875rem; font-weight: 500; text-align: right; flex-shrink: 0; }

/* Vertical bar chart (for dates) */
.vchart-bars { display: flex; align-items: flex-end; gap: 1px; height: 140px; padding-bottom: 2px; }
.vchart-bar { flex: 1; min-width: 3px; max-width: 24px; background: var(--accent); border-radius: 2px 2px 0 0; position: relative; transition: height 0.3s; cursor: default; }
.vchart-bar:hover { background: var(--accent-light); outline: 1px solid var(--accent); }
.vchart-bar:hover::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); font-size: 0.625rem; padding: 2px 6px; border-radius: 3px; white-space: nowrap; z-index: 10; margin-bottom: 4px; pointer-events: none; }
.vchart-labels { display: flex; gap: 1px; margin-top: 4px; overflow: hidden; }
.vchart-labels span { flex: 1; min-width: 3px; max-width: 24px; font-size: 0.5625rem; color: var(--muted); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vchart-axis { display: flex; justify-content: space-between; font-size: 0.625rem; color: var(--muted); margin-top: 2px; }

/* Dimension sub-tables */
.dim-section { margin-bottom: 1.5rem; }
.dim-title { font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; }

/* Table */
.table-wrapper { overflow-x: auto; border: 1px solid var(--border); border-radius: 0.5rem; }
table:not(.schema-cols) { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
table:not(.schema-cols) thead { background: var(--card-bg); position: sticky; top: 0; }
table:not(.schema-cols) th { padding: 0.5rem 0.75rem; text-align: left; font-weight: 600; font-size: 0.75rem; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; user-select: none; }
th.sortable { cursor: pointer; }
th.sortable:hover { color: var(--fg); }
th.num, td.num { text-align: right; }
table:not(.schema-cols) td { padding: 0.375rem 0.75rem; border-bottom: 1px solid var(--border); }
table:not(.schema-cols) tr:hover { background: var(--accent-light); }
tr.anonymized { background: var(--warn-light); }
tr.anonymized td.num { color: var(--warn); font-style: italic; }

/* Pagination */
.pagination { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.75rem; padding: 0.5rem 0; }
.page-btn { padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.8125rem; background: var(--bg); color: var(--fg); cursor: pointer; }
.page-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.page-btn:disabled { opacity: 0.4; cursor: default; }
.page-info { font-size: 0.8125rem; color: var(--muted); }

footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); }
footer p { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.25rem; }

@media print {
  .filters-bar, .tabs, .subtabs, .pagination { display: none; }
  .tab-content, .subtab-content { display: block !important; }
  .table-wrapper { border: none; overflow: visible; }
  footer { page-break-inside: avoid; }
}
`

// ---------------------------------------------------------------------------
// Embedded JavaScript
// ---------------------------------------------------------------------------

function buildJS(conceptFilterCols: FilterColInfo[]): string {
  return `
(function() {
  // --- Main tabs ---
  var tabs = document.querySelectorAll('.tab');
  var contents = document.querySelectorAll('.tab-content');

  function switchTab(tabName) {
    tabs.forEach(function(x) { x.classList.remove('active'); });
    contents.forEach(function(x) { x.style.display = 'none'; x.classList.remove('active'); });
    var btn = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (btn) btn.classList.add('active');
    var target = document.getElementById('tab-' + tabName);
    if (target) { target.style.display = ''; target.classList.add('active'); }
  }

  tabs.forEach(function(t) {
    t.addEventListener('click', function() { switchTab(t.dataset.tab); });
  });

  // --- Sub-tabs (Concepts / Dimensions) ---
  var subtabs = document.querySelectorAll('.subtab');
  var subtabContents = document.querySelectorAll('.subtab-content');

  function switchSubtab(name) {
    subtabs.forEach(function(x) { x.classList.remove('active'); });
    subtabContents.forEach(function(x) { x.style.display = 'none'; x.classList.remove('active'); });
    var btn = document.querySelector('.subtab[data-subtab="' + name + '"]');
    if (btn) btn.classList.add('active');
    var target = document.getElementById('subtab-' + name);
    if (target) { target.style.display = ''; target.classList.add('active'); }
  }

  subtabs.forEach(function(t) {
    t.addEventListener('click', function() { switchSubtab(t.dataset.subtab); });
  });

  // --- JSON-LD overlay ---
  var jsonldOverlay = document.getElementById('jsonld-overlay');
  var openBtn = document.getElementById('open-jsonld');
  var closeBtn = document.getElementById('close-jsonld');
  var copyBtn = document.getElementById('copy-jsonld');

  if (openBtn && jsonldOverlay) {
    openBtn.addEventListener('click', function() { jsonldOverlay.style.display = ''; });
  }
  if (closeBtn && jsonldOverlay) {
    closeBtn.addEventListener('click', function() { jsonldOverlay.style.display = 'none'; });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var code = document.getElementById('jsonld-code');
      if (!code) return;
      var text = code.textContent || '';
      navigator.clipboard.writeText(text).then(function() {
        copyBtn.textContent = 'Copied!';
        setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
  }

  // --- Concept data + state ---
  var allConcepts = CONCEPTS;
  var filteredConcepts = allConcepts;
  var conceptColCount = allConcepts.length > 0 ? allConcepts[0].length : 0;
  var page = 0;
  var pageSize = 100;
  var sortCol = -1, sortAsc = true;

  var tbody = document.getElementById('concept-tbody');
  var search = document.getElementById('concept-search');
  var rowCountEl = document.getElementById('concept-row-count');
  var prevBtn = document.getElementById('concept-page-prev');
  var nextBtn = document.getElementById('concept-page-next');
  var pageInfoEl = document.getElementById('concept-page-info');
  var pageSizeSel = document.getElementById('concept-page-size');
  var statsGrid = document.getElementById('stats-grid');
  var chartsGrid = document.getElementById('charts-grid');

  var filterCols = ${JSON.stringify(conceptFilterCols)};
  var chartDefs = CHART_DEFS;
  var meta = CATALOG_META;
  var dimData = DIMENSIONS;
  var dimIds = DIM_IDS;

  // Map column keys to indices in the concept row array (via <th data-col>)
  var colMap = {};
  var headers = document.querySelectorAll('#concept-table th');
  for (var i = 0; i < headers.length; i++) {
    var key = headers[i].dataset.col;
    if (key) colMap[key] = i;
  }

  // --- Populate concept filter dropdowns ---
  filterCols.forEach(function(fc) {
    var sel = document.getElementById('filter-' + fc.key);
    if (!sel) return;
    var idx = colMap[fc.key];
    if (idx == null) return;
    var vals = {};
    allConcepts.forEach(function(r) {
      var v = r[idx];
      if (v != null && v !== '') vals[v] = true;
    });
    Object.keys(vals).sort().forEach(function(v) {
      var opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function() { page = 0; applyConceptFilters(); });
  });

  // --- Concept filter logic ---
  function applyConceptFilters() {
    var q = search ? search.value.toLowerCase() : '';
    var selectFilters = {};

    filterCols.forEach(function(fc) {
      var sel = document.getElementById('filter-' + fc.key);
      if (sel && sel.value) selectFilters[fc.key] = sel.value;
    });

    filteredConcepts = allConcepts.filter(function(r) {
      if (q) {
        var haystack = (String(r[0]) + ' ' + String(r[1])).toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      for (var key in selectFilters) {
        var idx = colMap[key];
        if (idx != null && String(r[idx]) !== selectFilters[key]) return false;
      }
      return true;
    });

    renderConceptPage();
  }

  // Patient/visit/record column indices (last 4 columns: patients, visits, records, isAnonymized)
  var patientColIdx = conceptColCount - 4;
  var visitColIdx = conceptColCount - 3;
  var recordColIdx = conceptColCount - 2;

  // --- Dashboard rendering ---
  function renderDashboard() {
    statsGrid.innerHTML =
      statCard(meta.totalConcepts, 'Concepts') +
      statCard(meta.totalPatients, 'Unique patients') +
      statCard(meta.totalVisits, 'Unique visits') +
      statCard(meta.totalRecords, 'Records') +
      statCard(meta.anonymizedConcepts + meta.anonymizedDimensions, (meta.mode === 'suppress' ? 'Suppressed' : 'Anonymized') + ' rows');

    // Charts use dimension data directly (always accurate — no overcounting)
    var html = '';
    chartDefs.forEach(function(cd) {
      var rows = dimData[cd.dimId];
      if (!rows || rows.length === 0) return;

      // rows: [[value, patients, visits, records, isAnon], ...]
      var entries = rows.map(function(r) { return [String(r[0]), r[1]]; });

      if (cd.type === 'vertical') {
        entries.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      } else {
        entries.sort(function(a, b) { return b[1] - a[1]; });
      }
      if (cd.limit > 0 && entries.length > cd.limit) entries = entries.slice(0, cd.limit);

      if (cd.type === 'vertical') {
        html += buildVerticalChart(cd.title, entries);
      } else {
        html += buildHorizontalChart(cd.title, entries);
      }
    });
    chartsGrid.innerHTML = html;
  }

  function statCard(value, label) {
    return '<div class="stat-card"><div class="stat-value">' + Number(value).toLocaleString() + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function buildHorizontalChart(title, entries) {
    var maxVal = 0;
    entries.forEach(function(e) { if (e[1] > maxVal) maxVal = e[1]; });
    var bars = '';
    entries.forEach(function(e) {
      var pct = maxVal > 0 ? Math.round((e[1] / maxVal) * 100) : 0;
      var lbl = e[0].length > 30 ? e[0].slice(0, 28) + '\\u2026' : e[0];
      bars += '<div class="bar-row"><span class="bar-label" title="' + escAttr(e[0]) + '">' + escHtml(lbl) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div><span class="bar-value">' + e[1].toLocaleString() + '</span></div>';
    });
    return '<div class="chart-card"><h3 class="chart-title">' + escHtml(title) + '</h3>' + bars + '</div>';
  }

  function buildVerticalChart(title, entries) {
    var maxVal = 0;
    entries.forEach(function(e) { if (e[1] > maxVal) maxVal = e[1]; });
    var bars = '';
    var labels = '';
    var labelStep = entries.length > 20 ? Math.ceil(entries.length / 12) : 1;
    entries.forEach(function(e, i) {
      var pct = maxVal > 0 ? Math.round((e[1] / maxVal) * 100) : 0;
      var h = Math.max(1, pct * 1.4);
      bars += '<div class="vchart-bar" style="height:' + h + 'px" data-tip="' + escAttr(e[0]) + ': ' + e[1].toLocaleString() + '"></div>';
      var lbl = (i % labelStep === 0) ? escHtml(e[0]) : '';
      labels += '<span title="' + escAttr(e[0]) + '">' + lbl + '</span>';
    });
    var axis = '<div class="vchart-axis"><span>0</span><span>' + maxVal.toLocaleString() + '</span></div>';
    return '<div class="chart-card"><h3 class="chart-title">' + escHtml(title) + '</h3>' + axis + '<div class="vchart-bars">' + bars + '</div><div class="vchart-labels">' + labels + '</div></div>';
  }

  // --- Concept table rendering (paginated) ---
  function renderConceptPage() {
    var totalPages = Math.max(1, Math.ceil(filteredConcepts.length / pageSize));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    var start = page * pageSize;
    var end = Math.min(start + pageSize, filteredConcepts.length);
    var slice = filteredConcepts.slice(start, end);

    var html = '';
    for (var i = 0; i < slice.length; i++) {
      var r = slice[i];
      var isAnon = r[conceptColCount - 1] === true;
      var prefix = isAnon ? '&lt; ' : '';
      html += '<tr' + (isAnon ? ' class="anonymized"' : '') + '>';
      for (var c = 0; c < conceptColCount - 1; c++) {
        var val = r[c];
        if (c >= conceptColCount - 4) {
          html += '<td class="num">' + prefix + Number(val).toLocaleString() + '</td>';
        } else {
          html += '<td>' + escHtml(String(val != null ? val : '')) + '</td>';
        }
      }
      html += '</tr>';
    }
    tbody.innerHTML = html;

    if (rowCountEl) rowCountEl.textContent = filteredConcepts.length + ' concepts';
    if (pageInfoEl) pageInfoEl.textContent = 'Page ' + (page + 1) + ' / ' + totalPages;
    if (prevBtn) prevBtn.disabled = page === 0;
    if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
  }

  // --- Dimension table rendering ---
  function renderDimensionTables() {
    dimIds.forEach(function(dimId) {
      var tableEl = document.getElementById('dim-table-' + dimId);
      if (!tableEl) return;
      var dimTbody = tableEl.querySelector('tbody');
      if (!dimTbody) return;
      var rows = dimData[dimId] || [];

      // Sort by patient count descending
      rows.sort(function(a, b) { return b[1] - a[1]; });

      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var isAnon = r[4] === true;
        var prefix = isAnon ? '&lt; ' : '';
        html += '<tr' + (isAnon ? ' class="anonymized"' : '') + '>';
        html += '<td>' + escHtml(String(r[0])) + '</td>';
        html += '<td class="num">' + prefix + Number(r[1]).toLocaleString() + '</td>';
        html += '<td class="num">' + prefix + Number(r[2]).toLocaleString() + '</td>';
        html += '<td class="num">' + prefix + Number(r[3]).toLocaleString() + '</td>';
        html += '</tr>';
      }
      dimTbody.innerHTML = html;
    });
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Clear concept filters ---
  var clearBtn = document.getElementById('concept-clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      if (search) search.value = '';
      filterCols.forEach(function(fc) {
        var sel = document.getElementById('filter-' + fc.key);
        if (sel) sel.value = '';
      });
      page = 0;
      applyConceptFilters();
    });
  }

  // --- Concept search (debounced) ---
  var searchTimer;
  if (search) search.addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { page = 0; applyConceptFilters(); }, 200);
  });

  // --- Concept pagination ---
  if (prevBtn) prevBtn.addEventListener('click', function() { if (page > 0) { page--; renderConceptPage(); } });
  if (nextBtn) nextBtn.addEventListener('click', function() { page++; renderConceptPage(); });
  if (pageSizeSel) pageSizeSel.addEventListener('change', function() {
    pageSize = parseInt(this.value) || 100;
    page = 0;
    renderConceptPage();
  });

  // --- Concept sort ---
  headers.forEach(function(th) {
    if (!th.classList.contains('sortable')) return;
    th.addEventListener('click', function() {
      var colIdx = colMap[th.dataset.col];
      if (colIdx == null) return;
      var isNum = th.classList.contains('num');
      if (sortCol === colIdx) { sortAsc = !sortAsc; } else { sortCol = colIdx; sortAsc = true; }
      headers.forEach(function(h) {
        if (h.dataset.col) h.textContent = h.textContent.replace(/ [\\u25B2\\u25BC]/, '');
      });
      th.textContent += sortAsc ? ' \\u25B2' : ' \\u25BC';
      filteredConcepts.sort(function(a, b) {
        var va = a[colIdx], vb = b[colIdx];
        if (isNum) {
          va = typeof va === 'number' ? va : (parseFloat(String(va).replace(/[<,]/g, '')) || 0);
          vb = typeof vb === 'number' ? vb : (parseFloat(String(vb).replace(/[<,]/g, '')) || 0);
        } else {
          va = String(va || '').toLowerCase();
          vb = String(vb || '').toLowerCase();
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
      page = 0;
      renderConceptPage();
    });
  });

  // --- Initial render ---
  renderDashboard();
  applyConceptFilters();
  renderDimensionTables();
})();
`
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

  const header = ['concept_id', 'concept_name', 'vocabulary', 'category', 'subcategory',
    'patient_count', 'visit_count', 'record_count']
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
      String(pc), String(vc), String(rc),
    ].join(','))
  }

  return rows.join('\n')
}

/** Build CSV string from dimension rows with anonymization applied. */
export function buildDimensionsCsv(
  dimensions: CatalogDimensionRow[],
  catalog: DataCatalog,
): string {
  const threshold = catalog.anonymization.threshold
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'

  const header = ['dimension_id', 'dimension_type', 'value',
    'patient_count', 'visit_count', 'record_count']
  const rows: string[] = [header.join(',')]

  for (const r of dimensions) {
    if (mode === 'suppress' && r.patientCount < threshold) continue
    const belowThreshold = r.patientCount < threshold
    const pc = mode === 'replace' && belowThreshold ? threshold : r.patientCount
    const vc = mode === 'replace' && belowThreshold ? threshold : r.visitCount
    const rc = mode === 'replace' && belowThreshold ? threshold : r.recordCount
    rows.push([
      csvEscape(r.dimensionId), csvEscape(r.dimensionType), csvEscape(r.value),
      String(pc), String(vc), String(rc),
    ].join(','))
  }

  return rows.join('\n')
}
