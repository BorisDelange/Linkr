/**
 * Standalone HTML export for concept catalogs.
 *
 * Generates a self-contained HTML page with:
 * - Embedded JSON-LD (machine-readable metadata, always included)
 * - Four tabs: Metadata (JSON-LD), Schema (data dictionary with sidebar TOC), Overview (stats + charts + heatmaps), Concepts (paginated table)
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

  // Check for multiple dictionaries
  const dictionaryKeys = new Set(concepts.map((r) => r.dictionaryKey).filter(Boolean))
  const hasDictionary = dictionaryKeys.size > 1

  // Summary stats
  const totalConcepts = new Set(concepts.map((r) => r.conceptId)).size
  const totalPatients = cache.totalPatients
  const totalVisits = cache.totalVisits

  // Collect enabled dimension IDs for charts + sub-tables
  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  // Period data (merged into Overview tab)
  const periods = cache.periods ?? []
  const hasPeriods = periods.length > 0

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
    chartDefs.push({
      dimId: dim.id,
      dimType: dim.type,
      title: `${titleCase(dim.id)} distribution`,
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
    <button class="tab" data-tab="overview">Overview</button>
    <button class="tab" data-tab="concepts">Concepts</button>
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

  <!-- Schema tab: data dictionary with sidebar -->
  <div id="tab-schema" class="tab-content" style="display:none">
    <div class="schema-section">
      <h2 class="metadata-title">Data Schema${schemaMapping?.presetLabel ? ` — ${esc(schemaMapping.presetLabel)}` : ''}${fullSchema ? ` — ${fullSchema.length} tables` : ''}</h2>
      <p class="metadata-subtitle">Source warehouse structure · tables and columns</p>
      <div class="schema-layout">
        <aside class="schema-toc" id="schema-toc"></aside>
        <div class="schema-main" id="schema-main">
${schemaHtml}
        </div>
      </div>
    </div>
  </div>

  <!-- Overview tab (formerly Dashboard + Timeline) -->
  <div id="tab-overview" class="tab-content" style="display:none">
    ${hasPeriods ? `<div class="overview-controls">
      <span class="overview-label">Time period:</span>
      <div class="granularity-toggle" id="granularity-toggle">
        <button class="gran-btn active" data-gran="all">All</button>
        <button class="gran-btn" data-gran="month">Month</button>
        <button class="gran-btn" data-gran="quarter">Quarter</button>
        <button class="gran-btn" data-gran="year">Year</button>
      </div>
      <select id="period-filter" class="filter-select" style="min-width:140px"><option value="">All periods</option></select>
    </div>` : ''}
    <div class="stats-grid" id="stats-grid"></div>
    <div class="charts-grid" id="charts-grid"></div>
    ${hasPeriods ? '<div class="heatmaps-section" id="heatmaps-section"></div>' : ''}
  </div>

  <!-- Concepts tab -->
  <div id="tab-concepts" class="tab-content" style="display:none">
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

  <footer>
    <p>Anonymization: threshold = ${threshold} patients · mode = ${mode === 'suppress' ? 'suppress (rows removed)' : 'replace (counts capped)'}</p>
    <p>Health-DCAT-AP Release 6 · EHDS Regulation (EU) 2025/327</p>
  </footer>
</div>

<script>
var CONCEPTS = ${buildConceptsJson(concepts as (CatalogConceptRow & { _anonymized?: boolean })[], hasDictionary, !!catalog.categoryColumn, !!catalog.subcategoryColumn)};
var DIMENSIONS = ${JSON.stringify(buildDimensionsJson(dimensions as (CatalogDimensionRow & { _anonymized?: boolean })[]))};
var CATALOG_META = ${JSON.stringify({ totalConcepts, totalPatients, totalVisits, totalRecords: cache.grandTotal.totalRecords, threshold, mode })};
var CHART_DEFS = ${JSON.stringify(chartDefs)};
var PERIODS = ${JSON.stringify(periods)};
var PERIOD_THRESHOLD = ${threshold};
${buildJS(conceptFilterCols)}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Schema HTML builder — ERD-style table widgets
// ---------------------------------------------------------------------------

/** Map semantic roles to icons and colors */
const ROLE_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  'Patient demographics': { icon: 'fa-solid fa-user', color: '#0ea5e9', bg: 'rgba(14,165,233,0.1)' },
  'Visit / encounter records': { icon: 'fa-solid fa-bed', color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
  'Visit detail / unit stays': { icon: 'fa-solid fa-hospital', color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
  'Concept dictionary': { icon: 'fa-solid fa-book', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
}

function buildSchemaHtml(fullSchema?: IntrospectedTable[] | null, schemaMapping?: SchemaMapping | null): string {
  if (!fullSchema?.length && !schemaMapping) {
    return '      <p class="schema-empty">No schema available.</p>'
  }

  // Build a set of mapped table names + semantic descriptions from SchemaMapping
  const mappedTableRoles = new Map<string, string>()
  const keyColumns = new Map<string, Set<string>>() // table → set of PK/FK column names
  const fkColumns = new Map<string, Set<string>>()   // table → set of FK column names

  if (schemaMapping) {
    if (schemaMapping.patientTable) {
      mappedTableRoles.set(schemaMapping.patientTable.table, 'Patient demographics')
      addKey(keyColumns, schemaMapping.patientTable.table, schemaMapping.patientTable.idColumn)
    }
    if (schemaMapping.visitTable) {
      mappedTableRoles.set(schemaMapping.visitTable.table, 'Visit / encounter records')
      addKey(keyColumns, schemaMapping.visitTable.table, schemaMapping.visitTable.idColumn)
      addKey(fkColumns, schemaMapping.visitTable.table, schemaMapping.visitTable.patientIdColumn)
    }
    if (schemaMapping.visitDetailTable) {
      mappedTableRoles.set(schemaMapping.visitDetailTable.table, 'Visit detail / unit stays')
      if (schemaMapping.visitDetailTable.idColumn) addKey(keyColumns, schemaMapping.visitDetailTable.table, schemaMapping.visitDetailTable.idColumn)
      if (schemaMapping.visitDetailTable.visitIdColumn) addKey(fkColumns, schemaMapping.visitDetailTable.table, schemaMapping.visitDetailTable.visitIdColumn)
    }
    if (schemaMapping.conceptTables) {
      for (const cd of schemaMapping.conceptTables) {
        mappedTableRoles.set(cd.table, 'Concept dictionary')
        addKey(keyColumns, cd.table, cd.idColumn)
      }
    }
    if (schemaMapping.eventTables) {
      for (const [label, et] of Object.entries(schemaMapping.eventTables)) {
        mappedTableRoles.set(et.table, label)
        if (et.conceptIdColumn) addKey(fkColumns, et.table, et.conceptIdColumn)
        if (et.patientIdColumn) addKey(fkColumns, et.table, et.patientIdColumn)
      }
    }
  }

  // If full schema is available, render all introspected tables
  if (fullSchema && fullSchema.length > 0) {
    return `      <div class="schema-grid">\n` + fullSchema.map((t) => {
      const role = mappedTableRoles.get(t.name) ?? ''
      const style = role ? (ROLE_STYLES[role] ?? { icon: 'fa-solid fa-table', color: 'var(--accent)', bg: 'var(--accent-20)' }) : { icon: 'fa-solid fa-table', color: 'var(--muted)', bg: 'var(--card-bg)' }
      const pks = keyColumns.get(t.name)
      const fks = fkColumns.get(t.name)

      const rows = t.columns.map((c) => {
        const isPk = pks?.has(c.name)
        const isFk = fks?.has(c.name)
        const badge = isPk ? '<span class="col-badge pk">PK</span>' : isFk ? '<span class="col-badge fk">FK</span>' : ''
        return `            <tr><td class="col-name"><code>${esc(c.name)}</code>${badge}</td><td class="col-type"><code>${esc(c.type)}</code></td></tr>`
      }).join('\n')

      return `      <div class="erd-card" id="erd-${esc(t.name.replace(/[^a-zA-Z0-9_-]/g, '_'))}">
        <div class="erd-header" style="border-left-color:${style.color}">
          <span class="erd-icon" style="color:${style.color}"><i class="${style.icon}"></i></span>
          <span class="erd-table-name">${esc(t.name)}</span>
          <span class="erd-col-count">${t.columns.length}</span>
        </div>
        ${role ? `<div class="erd-role" style="background:${style.bg};color:${style.color}">${esc(role)}</div>` : ''}
        <table class="erd-cols">
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`
    }).join('\n') + '\n      </div>'
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

  return `      <div class="schema-grid">\n` + tables.map((t) => {
    const style = ROLE_STYLES[t.description] ?? { icon: 'fa-solid fa-table', color: 'var(--accent)', bg: 'var(--accent-20)' }
    const rows = t.columns.map((c) =>
      `            <tr><td class="col-name"><code>${esc(c.name)}</code></td><td class="col-type"><code>${esc(c.datatype)}</code></td></tr>`,
    ).join('\n')
    return `      <div class="erd-card" id="erd-${esc(t.name.replace(/[^a-zA-Z0-9_-]/g, '_'))}">
        <div class="erd-header" style="border-left-color:${style.color}">
          <span class="erd-icon" style="color:${style.color}"><i class="${style.icon}"></i></span>
          <span class="erd-table-name">${esc(t.name)}</span>
          <span class="erd-col-count">${t.columns.length}</span>
        </div>
        <div class="erd-role" style="background:${style.bg};color:${style.color}">${esc(t.description)}</div>
        <table class="erd-cols">
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`
  }).join('\n') + '\n      </div>'
}

function addKey(map: Map<string, Set<string>>, table: string, column: string) {
  if (!map.has(table)) map.set(table, new Set())
  map.get(table)!.add(column)
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
      const rdfProp = `<span class="meta-rdf">${esc(f.uri)}</span>`
      return `          <div class="meta-row">
            <div class="meta-label">${esc(f.labelKey.replace(/^dcat\./, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))}</div>
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
  dimType: string
  title: string
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
  --accent: #2563eb;
  --accent-light: #dbeafe;
  --accent-20: rgba(37,99,235,0.2);
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
    --accent: #60a5fa;
    --accent-light: #1e3a5f;
    --accent-20: rgba(96,165,250,0.2);
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

/* Schema sidebar TOC */
.schema-layout { display: flex; gap: 1rem; margin-top: 1rem; }
.schema-toc { flex: 0 0 200px; position: sticky; top: 1rem; align-self: flex-start; max-height: calc(100vh - 6rem); overflow-y: auto; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--card-bg); padding: 0.5rem 0; }
.schema-toc-search { width: calc(100% - 1rem); margin: 0 0.5rem 0.5rem; padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 0.25rem; font-size: 0.6875rem; background: var(--bg); color: var(--fg); outline: none; }
.schema-toc-search:focus { border-color: var(--accent); }
.schema-toc-item { display: flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.75rem; font-size: 0.6875rem; font-family: 'SF Mono', Menlo, monospace; color: var(--muted); cursor: pointer; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-left: 2px solid transparent; transition: all 0.1s; }
.schema-toc-item:hover { background: var(--accent-20); color: var(--fg); }
.schema-toc-item.active { border-left-color: var(--accent); color: var(--accent); background: var(--accent-20); }
.schema-toc-item .toc-icon { font-size: 0.5625rem; flex-shrink: 0; }
.schema-toc-item .toc-cols { font-size: 0.5625rem; color: var(--muted); margin-left: auto; flex-shrink: 0; }
.schema-main { flex: 1; min-width: 0; }
@media (max-width: 768px) { .schema-layout { flex-direction: column; } .schema-toc { flex: none; position: static; max-height: 200px; } }

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
.json-key { color: #2563eb; }
.json-str { color: #16a34a; }
.json-num { color: #d97706; }
.json-bool { color: #7c3aed; }

@media (prefers-color-scheme: dark) {
  .json-key { color: #60a5fa; }
  .json-str { color: #4ade80; }
  .json-num { color: #fbbf24; }
  .json-bool { color: #a78bfa; }
}

/* Schema tab — ERD-style widgets */
.schema-section { }
.schema-empty { color: var(--muted); font-size: 0.875rem; font-style: italic; }
.schema-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.erd-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; }
.erd-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); background: var(--bg); border-left: 3px solid var(--accent); }
.erd-icon { font-size: 0.75rem; flex-shrink: 0; }
.erd-table-name { font-weight: 600; font-size: 0.8125rem; font-family: 'SF Mono', Menlo, monospace; color: var(--fg); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.erd-col-count { font-size: 0.625rem; color: var(--muted); background: var(--accent-20); padding: 0.1rem 0.4rem; border-radius: 0.25rem; flex-shrink: 0; }
.erd-role { padding: 0.25rem 0.75rem; font-size: 0.6875rem; font-weight: 500; border-bottom: 1px solid var(--border); }
.erd-cols { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
.erd-cols td { padding: 0.25rem 0.75rem; border-bottom: 1px solid var(--border); }
.erd-cols tr:last-child td { border-bottom: none; }
.erd-cols .col-name { white-space: nowrap; }
.erd-cols .col-name code { font-family: 'SF Mono', Menlo, monospace; font-size: 0.75rem; color: var(--fg); }
.erd-cols .col-type code { font-family: 'SF Mono', Menlo, monospace; font-size: 0.6875rem; color: var(--muted); }
.col-badge { display: inline-block; margin-left: 0.35rem; padding: 0 0.25rem; border-radius: 0.15rem; font-size: 0.5625rem; font-weight: 700; vertical-align: middle; font-family: 'SF Mono', Menlo, monospace; }
.col-badge.pk { background: rgba(14,165,233,0.15); color: #0ea5e9; }
.col-badge.fk { background: rgba(139,92,246,0.15); color: #8b5cf6; }

/* Stats */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; text-align: center; }
.stat-value { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }

/* Charts */
.charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 1rem; }
.chart-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; }
.chart-title { font-size: 0.8125rem; font-weight: 600; margin-bottom: 0.75rem; }

/* Horizontal bar chart */
.bar-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
.bar-label { width: 120px; font-size: 0.6875rem; color: var(--muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.bar-track { flex: 1; height: 16px; background: var(--accent-20); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
.bar-value { width: 60px; font-size: 0.6875rem; font-weight: 500; text-align: right; flex-shrink: 0; }

/* Vertical bar chart (for age groups — X = age, Y = patients) */
.vchart-bars { display: flex; align-items: flex-end; gap: 2px; height: 140px; padding-bottom: 2px; }
.vchart-bar { flex: 1; min-width: 8px; max-width: 40px; background: var(--accent); border-radius: 2px 2px 0 0; position: relative; transition: height 0.3s; cursor: default; }
.vchart-bar:hover { background: var(--accent-light); outline: 1px solid var(--accent); }
.vchart-bar:hover::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); font-size: 0.625rem; padding: 2px 6px; border-radius: 3px; white-space: nowrap; z-index: 10; margin-bottom: 4px; pointer-events: none; }
.vchart-labels { display: flex; gap: 2px; margin-top: 4px; overflow: hidden; }
.vchart-labels span { flex: 1; min-width: 8px; max-width: 40px; font-size: 0.5625rem; color: var(--muted); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Pie chart (for sex distribution) */
.pie-container { display: flex; align-items: center; gap: 1.5rem; }
.pie-svg { width: 120px; height: 120px; }
.pie-legend { display: flex; flex-direction: column; gap: 0.35rem; }
.pie-legend-item { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; }
.pie-legend-swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
.pie-legend-value { color: var(--muted); font-size: 0.6875rem; }

/* Table */
.table-wrapper { overflow-x: auto; border: 1px solid var(--border); border-radius: 0.5rem; }
table:not(.erd-cols) { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
table:not(.erd-cols) thead { background: var(--card-bg); position: sticky; top: 0; }
table:not(.erd-cols) th { padding: 0.5rem 0.75rem; text-align: left; font-weight: 600; font-size: 0.75rem; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; user-select: none; }
th.sortable { cursor: pointer; }
th.sortable:hover { color: var(--fg); }
table:not(.erd-cols) th.num, th.num, td.num { text-align: right; }
table:not(.erd-cols) td { padding: 0.375rem 0.75rem; border-bottom: 1px solid var(--border); }
table:not(.erd-cols) tr:hover { background: var(--accent-light); }
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

/* Overview tab controls */
.overview-controls { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.overview-label { font-size: 0.8125rem; color: var(--muted); }
.granularity-toggle { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.gran-btn { padding: 0.3rem 0.8rem; font-size: 0.8125rem; border: none; background: var(--card-bg); color: var(--fg); cursor: pointer; }
.gran-btn.active { background: var(--accent); color: #fff; }
.gran-btn:hover:not(.active):not(:disabled) { background: var(--accent-20); }
.gran-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Heatmaps */
.heatmaps-section { margin-top: 1.5rem; }
.hm-block { margin-bottom: 2rem; }
.hm-title { font-size: 0.875rem; font-weight: 600; margin-bottom: 0.75rem; }
.hm-wrapper { overflow-x: auto; }
.hm-wrapper table { border-collapse: collapse; font-size: 0.7rem; }
.hm-wrapper th { padding: 4px 8px; background: var(--card-bg); border: 1px solid var(--border); font-weight: 500; white-space: nowrap; }
.hm-wrapper td { padding: 4px 8px; border: 1px solid var(--border); text-align: center; min-width: 56px; white-space: nowrap; }
.hm-wrapper td.masked { background: repeating-linear-gradient(45deg, var(--border), var(--border) 3px, var(--card-bg) 3px, var(--card-bg) 6px); color: var(--muted); font-style: italic; }

@media print {
  .filters-bar, .tabs, .pagination, .overview-controls, .schema-toc { display: none; }
  .tab-content { display: block !important; }
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
    if (tabName === 'overview' && !overviewRendered) { renderOverview(); overviewRendered = true; }
  }

  tabs.forEach(function(t) {
    t.addEventListener('click', function() { switchTab(t.dataset.tab); });
  });

  // --- Schema TOC ---
  (function() {
    var toc = document.getElementById('schema-toc');
    var cards = document.querySelectorAll('.erd-card');
    if (!toc || !cards.length) return;

    // Add search input
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter tables...';
    searchInput.className = 'schema-toc-search';
    toc.appendChild(searchInput);

    var items = [];
    cards.forEach(function(card) {
      var nameEl = card.querySelector('.erd-table-name');
      var iconEl = card.querySelector('.erd-icon i');
      var colCountEl = card.querySelector('.erd-col-count');
      if (!nameEl) return;
      var name = nameEl.textContent || '';
      var iconClass = iconEl ? iconEl.className : 'fa-solid fa-table';
      var colCount = colCountEl ? colCountEl.textContent : '';

      var item = document.createElement('a');
      item.className = 'schema-toc-item';
      item.href = '#' + card.id;
      item.innerHTML = '<span class="toc-icon"><i class="' + iconClass + '"></i></span>' + escHtml(name) + '<span class="toc-cols">' + colCount + '</span>';
      item.addEventListener('click', function(e) {
        e.preventDefault();
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        items.forEach(function(it) { it.classList.remove('active'); });
        item.classList.add('active');
      });
      toc.appendChild(item);
      items.push(item);
    });

    // Filter
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.toLowerCase();
      items.forEach(function(item) {
        var text = item.textContent.toLowerCase();
        item.style.display = text.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  })();

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
  var filteredConcepts = allConcepts.slice();
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

  // --- Fuzzy search helper ---
  function fuzzyMatch(needle, haystack) {
    needle = needle.toLowerCase();
    haystack = haystack.toLowerCase();
    if (haystack.indexOf(needle) !== -1) return true;
    // Simple fuzzy: all chars of needle appear in order in haystack
    var ni = 0;
    for (var hi = 0; hi < haystack.length && ni < needle.length; hi++) {
      if (haystack[hi] === needle[ni]) ni++;
    }
    return ni === needle.length;
  }

  // --- Concept filter logic ---
  function applyConceptFilters() {
    var q = search ? search.value.trim() : '';
    var selectFilters = {};

    filterCols.forEach(function(fc) {
      var sel = document.getElementById('filter-' + fc.key);
      if (sel && sel.value) selectFilters[fc.key] = sel.value;
    });

    filteredConcepts = allConcepts.filter(function(r) {
      if (q) {
        var haystack = String(r[0]) + ' ' + String(r[1]);
        if (!fuzzyMatch(q, haystack)) return false;
      }
      for (var key in selectFilters) {
        var idx = colMap[key];
        if (idx != null && String(r[idx]) !== selectFilters[key]) return false;
      }
      return true;
    });

    // Maintain current sort
    if (sortCol >= 0) {
      var isNum = sortCol >= conceptColCount - 4 && sortCol < conceptColCount - 1;
      filteredConcepts.sort(function(a, b) {
        var va = a[sortCol], vb = b[sortCol];
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
    }

    renderConceptPage();
  }

  // Patient/visit/record column indices (last 4 columns: patients, visits, records, isAnonymized)
  var patientColIdx = conceptColCount - 4;
  var visitColIdx = conceptColCount - 3;
  var recordColIdx = conceptColCount - 2;

  // --- Default sort by patients descending ---
  sortCol = patientColIdx;
  sortAsc = false;
  allConcepts.sort(function(a, b) { return b[patientColIdx] - a[patientColIdx]; });
  filteredConcepts = allConcepts.slice();
  // Update header arrow
  if (headers[patientColIdx]) headers[patientColIdx].textContent += ' \\u25BC';

  // --- Period state ---
  var currentGran = 'all';
  var currentPeriodValue = '';

  // --- Overview rendering (lazy, re-renderable) ---
  var overviewRendered = false;

  function renderOverview() {
    renderOverviewWithPeriod(currentGran, currentPeriodValue);
  }

  function renderOverviewWithPeriod(gran, periodValue) {
    // Determine if a specific period is selected (not "all" and a specific value chosen)
    var specificPeriod = periodValue !== '';

    // If a specific period row exists in PERIODS, use its stats
    var periodRow = null;
    if (specificPeriod && PERIODS && PERIODS.length) {
      periodRow = PERIODS.find(function(r) { return r.period_label === periodValue; });
    }

    // Stats cards: use period-specific counts if available
    var pats = periodRow ? periodRow.n_patients : meta.totalPatients;
    var vis = periodRow ? periodRow.n_sejours : meta.totalVisits;
    statsGrid.innerHTML =
      statCard(pats !== null ? pats : '< ' + meta.threshold, 'Patients') +
      statCard(vis !== null ? vis : '< ' + meta.threshold, 'Visits');

    // Charts use dimension data
    var html = '';
    chartDefs.forEach(function(cd) {
      // Hide admission_date chart when a specific period is selected
      if (cd.dimType === 'admission_date' && specificPeriod) return;

      // For sex and age_group: use period row data if available
      if (periodRow && cd.dimType === 'sex') {
        var sexEntries = [];
        if (periodRow.sex_m !== null) sexEntries.push(['M', periodRow.sex_m]);
        if (periodRow.sex_f !== null) sexEntries.push(['F', periodRow.sex_f]);
        if (periodRow.sex_other !== null) sexEntries.push(['Other', periodRow.sex_other]);
        if (sexEntries.length > 0) {
          html += buildPieChart(cd.title, sexEntries);
        }
        return;
      }

      if (periodRow && cd.dimType === 'age_group' && periodRow.age_buckets) {
        var ageEntries = [];
        for (var k in periodRow.age_buckets) {
          if (periodRow.age_buckets[k] !== null) ageEntries.push([k, periodRow.age_buckets[k]]);
        }
        if (ageEntries.length > 0) {
          ageEntries.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
          html += buildVerticalChart(cd.title, ageEntries);
        }
        return;
      }

      if (periodRow && cd.dimType === 'care_site' && periodRow.services) {
        var csEntries = [];
        for (var s in periodRow.services) {
          var sv = periodRow.services[s];
          if (sv && sv.n_patients !== null) csEntries.push([s, sv.n_patients]);
        }
        if (csEntries.length > 0) {
          csEntries.sort(function(a, b) { return b[1] - a[1]; });
          if (csEntries.length > 30) csEntries = csEntries.slice(0, 30);
          html += buildHorizontalChart(cd.title, csEntries);
        }
        return;
      }

      // Default: use dimension data (global)
      var rows = dimData[cd.dimId];
      if (!rows || rows.length === 0) return;

      var entries = rows.map(function(r) { return [String(r[0]), r[1]]; });

      if (cd.dimType === 'age_group') {
        entries.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
        html += buildVerticalChart(cd.title, entries);
      } else if (cd.dimType === 'sex') {
        html += buildPieChart(cd.title, entries);
      } else if (cd.dimType === 'admission_date') {
        entries.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
        if (entries.length > 60) entries = entries.slice(0, 60);
        html += buildVerticalChart(cd.title, entries);
      } else {
        entries.sort(function(a, b) { return b[1] - a[1]; });
        if (entries.length > 30) entries = entries.slice(0, 30);
        html += buildHorizontalChart(cd.title, entries);
      }
    });
    chartsGrid.innerHTML = html;

    // Heatmaps (from period data)
    renderHeatmaps(gran, periodValue);
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
    entries.forEach(function(e) {
      var pct = maxVal > 0 ? Math.round((e[1] / maxVal) * 100) : 0;
      var h = Math.max(1, pct * 1.4);
      bars += '<div class="vchart-bar" style="height:' + h + 'px" data-tip="' + escAttr(e[0]) + ': ' + e[1].toLocaleString() + '"></div>';
      labels += '<span title="' + escAttr(e[0]) + '">' + escHtml(e[0]) + '</span>';
    });
    return '<div class="chart-card"><h3 class="chart-title">' + escHtml(title) + '</h3><div class="vchart-bars">' + bars + '</div><div class="vchart-labels">' + labels + '</div></div>';
  }

  function buildPieChart(title, entries) {
    // Sort descending for nicer display
    entries.sort(function(a, b) { return b[1] - a[1]; });
    var total = 0;
    entries.forEach(function(e) { total += e[1]; });
    if (total === 0) return '';

    // Neutral, non-gendered colors
    var COLORS = ['#2563eb', '#f59e0b', '#8b5cf6', '#64748b', '#3b82f6', '#e11d48'];
    var paths = '';
    var cumAngle = -Math.PI / 2; // start at top
    var cx = 50, cy = 50, r = 45;
    var legendItems = '';

    entries.forEach(function(e, i) {
      var pct = e[1] / total * 100;
      var angle = (e[1] / total) * 2 * Math.PI;
      var color = COLORS[i % COLORS.length];

      if (entries.length === 1) {
        // Full circle
        paths += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '" />';
      } else {
        var x1 = cx + r * Math.cos(cumAngle);
        var y1 = cy + r * Math.sin(cumAngle);
        var x2 = cx + r * Math.cos(cumAngle + angle);
        var y2 = cy + r * Math.sin(cumAngle + angle);
        var largeArc = angle > Math.PI ? 1 : 0;
        paths += '<path d="M' + cx + ',' + cy + ' L' + x1.toFixed(2) + ',' + y1.toFixed(2) + ' A' + r + ',' + r + ' 0 ' + largeArc + ',1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z" fill="' + color + '" />';
      }

      legendItems += '<div class="pie-legend-item"><div class="pie-legend-swatch" style="background:' + color + '"></div><span>' + escHtml(e[0]) + '</span><span class="pie-legend-value">' + e[1].toLocaleString() + ' (' + pct.toFixed(1) + '%)</span></div>';
      cumAngle += angle;
    });

    return '<div class="chart-card"><h3 class="chart-title">' + escHtml(title) + '</h3><div class="pie-container"><svg viewBox="0 0 100 100" class="pie-svg">' + paths + '</svg><div class="pie-legend">' + legendItems + '</div></div></div>';
  }

  // --- Heatmaps (services + concept categories from period data) ---
  var HEATMAP_BASE = [255,247,230];
  var HEATMAP_TOP  = [37, 99, 235];

  function heatColor(val, max) {
    if (val === null || max === 0) return null;
    var t = Math.min(val / max, 1);
    var r = Math.round(HEATMAP_BASE[0] + t * (HEATMAP_TOP[0] - HEATMAP_BASE[0]));
    var g = Math.round(HEATMAP_BASE[1] + t * (HEATMAP_TOP[1] - HEATMAP_BASE[1]));
    var b = Math.round(HEATMAP_BASE[2] + t * (HEATMAP_TOP[2] - HEATMAP_BASE[2]));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function fmtPeriod(v) { return v === null ? '< ' + PERIOD_THRESHOLD : v.toLocaleString(); }

  function renderHeatmaps(gran, periodValue) {
    var section = document.getElementById('heatmaps-section');
    if (!section || !PERIODS || !PERIODS.length) return;

    // Filter rows by granularity
    var rows;
    if (gran === 'all') {
      // Show all non-all rows at finest granularity available
      var grans = ['month','quarter','year'];
      for (var gi = 0; gi < grans.length; gi++) {
        var g = grans[gi];
        rows = PERIODS.filter(function(r) { return r.period_granularity === g; });
        if (rows.length > 0) break;
      }
    } else {
      rows = PERIODS.filter(function(r) { return r.period_granularity === gran; });
    }
    if (!rows || !rows.length) { section.innerHTML = ''; return; }

    // Apply period filter if selected
    if (periodValue) {
      rows = rows.filter(function(r) { return r.period_label === periodValue; });
    }

    var allRow = PERIODS.find(function(r) { return r.period_granularity === 'all'; });
    var html = '';

    // --- Heatmap: services ---
    var svcLabels = allRow ? Object.keys(allRow.services) : [];
    if (svcLabels.length && rows.length > 1) {
      var svcMaxes = {};
      svcLabels.forEach(function(svc) {
        var m = 0;
        rows.forEach(function(r) { var v = r.services[svc] && r.services[svc].n_patients; if (v !== null && v > m) m = v; });
        svcMaxes[svc] = m;
      });
      html += '<div class="hm-block">';
      html += '<div class="hm-title">Patients by service over time</div>';
      html += '<div class="hm-wrapper"><table><thead><tr><th>Service</th>';
      rows.forEach(function(r) { html += '<th>' + r.period_label + '</th>'; });
      html += '</tr></thead><tbody>';
      svcLabels.forEach(function(svc) {
        html += '<tr><td style="font-weight:500;text-align:left;white-space:nowrap">' + escHtml(svc) + '</td>';
        rows.forEach(function(r) {
          var v = r.services[svc] ? r.services[svc].n_patients : null;
          if (v === null) {
            html += '<td class="masked" title="< ' + PERIOD_THRESHOLD + '">*</td>';
          } else {
            var bg = heatColor(v, svcMaxes[svc]);
            html += '<td style="background:' + bg + '" title="' + v.toLocaleString() + '">' + v.toLocaleString() + '</td>';
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
    }

    // --- Heatmap: concept categories ---
    var catLabels = allRow ? Object.keys(allRow.concept_categories) : [];
    if (catLabels.length && rows.length > 1) {
      var catMaxes = {};
      catLabels.forEach(function(cat) {
        var m = 0;
        rows.forEach(function(r) { var v = r.concept_categories[cat] && r.concept_categories[cat].n_patients; if (v !== null && v > m) m = v; });
        catMaxes[cat] = m;
      });
      html += '<div class="hm-block">';
      html += '<div class="hm-title">Patients by concept category over time</div>';
      html += '<div class="hm-wrapper"><table><thead><tr><th>Category</th>';
      rows.forEach(function(r) { html += '<th>' + r.period_label + '</th>'; });
      html += '</tr></thead><tbody>';
      catLabels.forEach(function(cat) {
        html += '<tr><td style="font-weight:500;text-align:left;white-space:nowrap">' + escHtml(cat) + '</td>';
        rows.forEach(function(r) {
          var v = r.concept_categories[cat] ? r.concept_categories[cat].n_patients : null;
          if (v === null) {
            html += '<td class="masked" title="< ' + PERIOD_THRESHOLD + '">*</td>';
          } else {
            var bg = heatColor(v, catMaxes[cat]);
            html += '<td style="background:' + bg + '" title="' + v.toLocaleString() + '">' + v.toLocaleString() + '</td>';
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
    }

    section.innerHTML = html;
  }

  // --- Period time filter controls ---
  if (PERIODS && PERIODS.length) {
    var availGrans = ['month','quarter','year'].filter(function(g) {
      return PERIODS.some(function(r) { return r.period_granularity === g; });
    });

    // Disable unavailable granularity buttons
    document.querySelectorAll('.gran-btn').forEach(function(btn) {
      var g = btn.dataset.gran;
      if (g !== 'all' && !availGrans.includes(g)) {
        btn.disabled = true;
      }
    });

    // Populate period dropdown based on current granularity
    function populatePeriodDropdown(gran) {
      var periodSel = document.getElementById('period-filter');
      if (!periodSel) return;
      periodSel.innerHTML = '<option value="">All periods</option>';
      var rows;
      if (gran === 'all') {
        // Use finest available
        for (var gi = 0; gi < availGrans.length; gi++) {
          rows = PERIODS.filter(function(r) { return r.period_granularity === availGrans[gi]; });
          if (rows.length > 0) break;
        }
      } else {
        rows = PERIODS.filter(function(r) { return r.period_granularity === gran; });
      }
      if (rows) {
        rows.forEach(function(r) {
          var opt = document.createElement('option');
          opt.value = r.period_label;
          opt.textContent = r.period_label;
          periodSel.appendChild(opt);
        });
      }
    }

    populatePeriodDropdown(currentGran);

    var togEl = document.getElementById('granularity-toggle');
    if (togEl) {
      togEl.addEventListener('click', function(e) {
        var btn = e.target.closest('.gran-btn');
        if (!btn || btn.disabled) return;
        currentGran = btn.dataset.gran;
        currentPeriodValue = '';
        document.querySelectorAll('.gran-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
        populatePeriodDropdown(currentGran);
        var periodSel = document.getElementById('period-filter');
        if (periodSel) periodSel.value = '';
        if (overviewRendered) renderOverviewWithPeriod(currentGran, currentPeriodValue);
      });
    }

    var periodSel = document.getElementById('period-filter');
    if (periodSel) {
      periodSel.addEventListener('change', function() {
        currentPeriodValue = this.value;
        if (overviewRendered) renderOverviewWithPeriod(currentGran, currentPeriodValue);
      });
    }
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
  renderConceptPage();
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
