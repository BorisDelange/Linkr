/**
 * Standalone HTML export for concept catalogs: one self-contained page (inline
 * CSS, SVG and script, no network request) with the JSON-LD embedded for
 * machines, and four tabs — Metadata, Schema, Overview, Concepts. Same visual
 * language as the cohort report. Anonymisation: rows below the threshold are
 * either capped (replace) or removed (suppress) before anything is rendered.
 */

import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogDimensionRow, SchemaMapping, AnonymizationMode, DimensionConfig } from '@/types'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { LINKR_LOGO_SVG } from '@/lib/cohort-report/render-html'
import { columnChart, donut, horizontalBars, verticalBars, escapeXml as esc, type ChartItem } from '@/lib/cohort-report/charts'
import { buildJsonLd } from './jsonld'
import { localized } from '@/lib/localized'
import { DCAT_FIELDS, DCAT_VOCABULARIES, HEALTHDCATAP_RELEASE, normalizeDcatMetadata, type DcatClass } from './schema'
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

type Counted = { patientCount: number; recordCount: number; visitCount: number }
type Anonymized<T> = T & { _anonymized?: boolean }

function anonymize<T extends Counted>(rows: T[], threshold: number, mode: AnonymizationMode): Anonymized<T>[] {
  if (mode === 'suppress') return rows.filter((r) => r.patientCount >= threshold)
  return rows.map((r) => (r.patientCount < threshold
    ? { ...r, patientCount: threshold, recordCount: threshold, visitCount: threshold, _anonymized: true }
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
  const dimensions = anonymize(cache.dimensions, threshold, mode)
  const periods = cache.periods ?? []

  const metadata = catalog.dcatApMetadata ?? {}
  const jsonLd = JSON.stringify(buildJsonLd({ metadata, schemaMapping, fullSchema, cache, catalog }), null, 2)

  const catalogTitle = (metadata['catalog.title'] as string) || localized(catalog.name, 'en')
  const catalogDesc = (metadata['catalog.description'] as string) || localized(catalog.description, 'en') || ''
  const publisher = (metadata['agent.name'] as string) || (metadata['catalog.publisher'] as string) || ''
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const table = buildConceptTable(concepts, catalog)
  const schema = buildSchemaSection(fullSchema, schemaMapping)
  const totals = {
    patients: cache.totalPatients,
    visits: cache.totalVisits,
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
<title>${esc(catalogTitle)} — Concept Catalog</title>
<script type="application/ld+json">
${jsonLd.replace(/</g, '\\u003c')}
</script>
<style>${CATALOG_CSS}</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="brand">${LINKR_LOGO_SVG}<div><div class="eyebrow">Concept catalog</div><div class="meta-line">${[`Generated on ${generated}`, publisher, `Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE}`].filter(Boolean).map(esc).join(' · ')}</div></div></div>
    <h1>${esc(catalogTitle)}</h1>
    ${catalogDesc ? `<p class="desc">${esc(catalogDesc)}</p>` : ''}
    <nav class="tabs" role="tablist">
      ${tab('metadata', 'Metadata', 'fileText', undefined, true)}
      ${tab('schema', 'Schema', 'table', schema.tableCount || undefined)}
      ${tab('overview', 'Overview', 'barChart')}
      ${tab('concepts', 'Concepts', 'tags', concepts.length)}
    </nav>
  </header>

  <section id="tab-metadata" class="tab-content active">
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

  <section id="tab-overview" class="tab-content">
    <div class="section-head">
      <h2>Overview</h2><span class="sub">Population and activity covered by the catalog</span><span class="spacer"></span>
      ${periods.length ? `<div class="ov-controls">
        <span class="lbl">Period</span>
        <div class="seg" id="granularity"><button type="button" class="active" data-gran="all">All</button><button type="button" data-gran="month">Month</button><button type="button" data-gran="quarter">Quarter</button><button type="button" data-gran="year">Year</button></div>
        <select id="period-filter" class="select"><option value="">All periods</option></select>
      </div>` : ''}
    </div>
${buildOverviewHtml(catalog.dimensions.filter((d) => d.enabled), dimensions, totals, threshold, periods.length > 0)}
  </section>

  <section id="tab-concepts" class="tab-content">
    <div class="section-head">
      <h2>Concepts</h2><span class="sub">Distinct patients, hospitalizations and records per concept</span>
    </div>
    <div class="card dt">
      <div class="dt-toolbar">
        <label class="search">${icon('search', 14)}<input type="search" id="concept-search" class="input" placeholder="Search concepts…" autocomplete="off"></label>
        <button class="btn" id="concept-clear" type="button" hidden>${icon('x', 13)}Clear filters</button>
        <span class="spacer"></span>
        <span class="dt-note">${icon('shield', 13)}${mode === 'suppress' ? `Concepts with fewer than ${threshold} patients are not listed` : `Counts below ${threshold} patients are shown as &lt; ${threshold}`}</span>
      </div>
      <div class="dt-scroll">
        <table id="concept-table">
          <thead>
            <tr class="head">${table.headHtml}</tr>
            <tr class="filters">${table.filterHtml}</tr>
          </thead>
          <tbody id="concept-tbody"></tbody>
        </table>
      </div>
      <div class="dt-foot">
        <span id="concept-count" class="num"></span>
        <span class="spacer"></span>
        <span>Rows per page</span>
        <select id="concept-page-size" class="select">${[25, 50, 100, 250, 500].map((n) => `<option value="${n}"${n === 50 ? ' selected' : ''}>${n}</option>`).join('')}</select>
        <button class="btn icon-only" id="concept-prev" type="button" aria-label="Previous page">${icon('chevronLeft', 14)}</button>
        <span id="concept-page-info" class="page-info num"></span>
        <button class="btn icon-only" id="concept-next" type="button" aria-label="Next page">${icon('chevronRight', 14)}</button>
      </div>
    </div>
  </section>

  <footer>
    <span>${icon('shield', 12)}Anonymisation threshold: ${threshold} patients · ${mode === 'suppress' ? 'rows below it removed' : 'counts below it capped'}</span>
    <span>Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE} · EHDS Regulation (EU) 2025/327</span>
    <span>Generated with Linkr</span>
  </footer>
</div>

<script>
var CONCEPTS = ${inlineJson(table.rows)};
var CONCEPT_COLS = ${inlineJson(table.cols.map(({ key, kind }) => ({ key, kind })))};
var PERIODS = ${inlineJson(periods)};
var META = ${inlineJson({ threshold, totalPatients: totals.patients, totalVisits: totals.visits })};
var ICONS = ${inlineJson({ up: icon('arrowUp', 11), down: icon('arrowDown', 11), both: icon('arrowUpDown', 11) })};
${CATALOG_SCRIPT}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** Age bands sort on their lower bound: "5–9" before "10–14", "[0;18[" before "[18;25[". */
function leadingNumber(label: string): number {
  const m = /\d+/.exec(label)
  return m ? Number(m[0]) : Infinity
}

// A daily admission axis over years would be thousands of hairline bars.
const MAX_TIME_BARS = 500

function buildOverviewHtml(
  enabledDims: DimensionConfig[],
  dimensions: Anonymized<CatalogDimensionRow>[],
  totals: { patients: number; visits: number; concepts: number; records: number },
  threshold: number,
  hasPeriods: boolean,
): string {
  const kpi = (key: string, value: number, label: string, periodNote = false) =>
    `<div class="kpi" data-kpi="${key}"><div class="v num">${fmt(value)}</div><div class="l">${label}</div>${periodNote && hasPeriods ? '<div class="s" style="display:none">all periods</div>' : ''}</div>`
  const kpis = `    <div class="kpis">${kpi('patients', totals.patients, 'Patients')}${kpi('visits', totals.visits, 'Hospitalizations')}${kpi('concepts', totals.concepts, 'Concepts', true)}${kpi('records', totals.records, 'Records', true)}</div>`

  const charts = enabledDims.flatMap((dim) => {
    const rows = dimensions.filter((r) => r.dimensionId === dim.id)
    if (!rows.length) return []
    const title = dim.label || dim.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    let items: ChartItem[] = rows.map((r) => ({
      label: String(r.value),
      count: { value: r.patientCount, label: r._anonymized ? `<${threshold}` : fmt(r.patientCount) },
    }))
    let svg: string
    let size: 'compact' | 'full'
    if (dim.type === 'age_group') {
      items.sort((a, b) => leadingNumber(a.label) - leadingNumber(b.label) || a.label.localeCompare(b.label))
      svg = columnChart(items, { title, unit: 'patients' })
      size = 'compact'
    } else if (dim.type === 'sex') {
      items.sort((a, b) => (b.count.value ?? 0) - (a.count.value ?? 0))
      svg = donut(items, { title, locale: 'en', centerValue: fmt(totals.patients), centerLabel: 'patients' })
      size = 'compact'
    } else if (dim.type === 'admission_date') {
      items.sort((a, b) => a.label.localeCompare(b.label))
      items = items.slice(-MAX_TIME_BARS)
      svg = verticalBars(items, { title, width: 1100, height: 260 })
      size = 'full'
    } else {
      items.sort((a, b) => (b.count.value ?? 0) - (a.count.value ?? 0))
      svg = horizontalBars(items.slice(0, 30), { title, width: 1100 })
      size = 'full'
    }
    const anonymized = rows.some((r) => r._anonymized)
    return [`    <div class="card chart ${size}" data-dim="${esc(dim.type)}" data-title="${esc(title)}">
      <h3 class="eyebrow">${esc(title)}</h3>
      <div class="chart-body">${svg}</div>
      ${anonymized ? `<p class="caption">Counts below ${threshold} patients are shown as &lt;${threshold}.</p>` : ''}
    </div>`]
  })

  return [
    kpis,
    charts.length ? `    <div class="charts">\n${charts.join('\n')}\n    </div>` : '    <div class="card empty">No demographic dimension was computed for this catalog.</div>',
    hasPeriods ? '    <div id="heatmaps"></div>' : '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Concepts table
// ---------------------------------------------------------------------------

interface ConceptCol {
  key: string
  label: string
  kind: 'id' | 'text' | 'select' | 'num'
}

function buildConceptTable(concepts: Anonymized<CatalogConceptRow>[], catalog: DataCatalog) {
  const hasDictionary = new Set(concepts.map((r) => r.dictionaryKey).filter(Boolean)).size > 1
  const cols: ConceptCol[] = [
    { key: 'conceptId', label: 'Concept ID', kind: 'id' },
    { key: 'conceptName', label: 'Concept name', kind: 'text' },
    ...(hasDictionary ? [{ key: 'dictionaryKey', label: 'Vocabulary', kind: 'select' } as const] : []),
    ...(catalog.categoryColumn ? [{ key: 'category', label: 'Category', kind: 'select' } as const] : []),
    ...(catalog.subcategoryColumn ? [{ key: 'subcategory', label: 'Subcategory', kind: 'select' } as const] : []),
    { key: 'patientCount', label: 'Patients', kind: 'num' },
    { key: 'visitCount', label: 'Hospitalizations', kind: 'num' },
    { key: 'recordCount', label: 'Records', kind: 'num' },
  ]
  const rows = concepts.map((r) => [
    ...cols.map((c) => (r[c.key as keyof CatalogConceptRow] ?? '') as string | number),
    r._anonymized === true,
  ])

  const headHtml = cols.map((c, i) =>
    `<th${c.kind === 'num' ? ' class="r"' : ''}><button class="sort" type="button" data-idx="${i}"><span>${c.label}</span><span class="sort-ico"></span></button></th>`,
  ).join('')

  const filterHtml = cols.map((c, i) => {
    const attrs = `class="f" data-idx="${i}" aria-label="Filter ${c.label}"`
    if (c.kind === 'num') return `<th class="r"><input ${attrs} data-kind="num" type="number" min="0" placeholder="≥ min"></th>`
    if (c.kind === 'select') {
      const values = [...new Set(rows.map((r) => String(r[i])).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      return `<th><select ${attrs} data-kind="select"><option value="">All</option>${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select></th>`
    }
    return `<th><input ${attrs} data-kind="text" type="text" placeholder="Filter…"></th>`
  }).join('')

  return { cols, rows, headHtml, filterHtml }
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
  for (const [label, et] of Object.entries(mapping.eventTables ?? {})) labels.set(et.table, label)
  for (const cd of mapping.conceptTables ?? []) labels.set(cd.table, 'Concept dictionary')
  if (mapping.visitDetailTable) labels.set(mapping.visitDetailTable.table, 'Visit details / unit stays')
  if (mapping.visitTable) labels.set(mapping.visitTable.table, 'Visits / encounters')
  if (mapping.patientTable) labels.set(mapping.patientTable.table, 'Patient demographics')
  return labels
}

/** The mapped columns only, for a source whose full schema was not introspected. */
function tablesFromMapping(m: SchemaMapping): SchemaTable[] {
  const tables: SchemaTable[] = []
  const cols = (...names: (string | undefined)[]) => names.filter((n): n is string => !!n).map((name) => ({ name }))
  if (m.patientTable) {
    const p = m.patientTable
    tables.push({ name: p.table, columns: cols(p.idColumn, p.birthDateColumn, p.birthYearColumn, p.genderColumn) })
  }
  if (m.visitTable) {
    const v = m.visitTable
    tables.push({ name: v.table, columns: cols(v.idColumn, v.patientIdColumn, v.startDateColumn, v.endDateColumn, v.typeColumn) })
  }
  for (const cd of m.conceptTables ?? []) {
    if (cd.idColumn) tables.push({ name: cd.table, columns: cols(cd.idColumn, cd.nameColumn, cd.codeColumn, cd.vocabularyColumn) })
  }
  for (const et of Object.values(m.eventTables ?? {})) {
    tables.push({ name: et.table, columns: cols(et.conceptIdColumn, et.patientIdColumn, et.dateColumn) })
  }
  return tables
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
const enLabel = (labelKey: string): string => {
  const leaf = labelKey.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], en)
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
