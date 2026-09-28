/**
 * Standalone HTML export for concept catalogs: one self-contained page (inline
 * CSS, SVG and script, no network request) with the JSON-LD embedded for
 * machines, and four tabs — Explore, Metadata, Schema, Info. Same visual
 * language as the cohort report.
 *
 * Nothing unmasked reaches the page: the crossings come from
 * `buildPublishedCatalog` (masked cells left out), and the concepts it masks
 * are capped (replace) or removed (suppress) before being inlined.
 */

import type { DataCatalog, CatalogResultCache, CatalogConceptRow, SchemaMapping, AnonymizationMode, CatalogCounts } from '@/types'
import { PUBLISHED } from '@/lib/data-catalog/suppression'
import { catalogCounts } from '@/lib/data-catalog/config'
import type { IntrospectedTable } from '@/lib/duckdb/engine'
import { LINKR_LOGO_SVG } from '@/lib/cohort-report/render-html'
import { escapeXml as esc } from '@/lib/cohort-report/charts'
import { buildPublishedCatalog, computeCatalogMasks, publishedConcepts, type PublishedConcept, type PublishedCrossing } from '@/lib/data-catalog/publish'
import { buildJsonLd } from './jsonld'
import { mappedTableDocs } from './mapped-tables'
import { localized } from '@/lib/localized'
import { DCAT_FIELDS, DCAT_VOCABULARIES, HEALTHDCATAP_RELEASE, HEALTHDCATAP_SPEC_URL, normalizeDcatMetadata, type DcatClass } from './schema'
import { bundleText, exploreText, fill, PAGE_TEXT, type PageLocale, type PageText } from './page-text'
import { CATALOG_CSS, icon, type IconName } from './export-html-style'
import { CATALOG_SCRIPT } from './export-html-script'
import { mappingColumnRoles, mappingTableTypes, renderSchemaErd, TABLE_TYPE_ICON, type ColumnRole, type TableType } from './export-html-erd'

export interface ExportHtmlOptions {
  catalog: DataCatalog
  cache: CatalogResultCache
  schemaMapping?: SchemaMapping | null
  /** Full introspected schema (all tables + columns from information_schema). */
  fullSchema?: IntrospectedTable[] | null
  /** Language of the page. Default English. */
  locale?: PageLocale
  /**
   * The app's preview only, never a published file: masked cells keep their
   * numbers (flagged as masked), to see what the threshold hides.
   */
  reveal?: boolean
}

export type Anonymized<T> = T & { _anonymized?: boolean }

/** Masked rows flagged; in the published page (not `reveal`) their counts are capped at the threshold. */
function conceptListRows(rows: PublishedConcept[], threshold: number, reveal: boolean): Anonymized<CatalogConceptRow>[] {
  return rows.map(({ status, ...r }) => {
    if (status === PUBLISHED) return r
    if (reveal) return { ...r, _anonymized: true }
    return { ...r, patientCount: threshold, recordCount: threshold, ...(r.visitCount != null ? { visitCount: threshold } : {}), _anonymized: true }
  })
}

/** Largest first; ties by id, so that capped rows keep no trace of their real order. */
function byPatients(a: CatalogConceptRow, b: CatalogConceptRow): number {
  const ka = String(a.conceptId)
  const kb = String(b.conceptId)
  return b.patientCount - a.patientCount || (ka < kb ? -1 : ka > kb ? 1 : 0)
}

/**
 * What the Explore tab reads: published crossings, variable labels, the concept
 * list and the totals. The bulk of the page — tens of megabytes on a large
 * warehouse — so the app's preview builds it once and hands it to the page
 * (`dataFrom: 'parent'`) instead of inlining it.
 */
export interface CatalogPageData {
  threshold: number
  variables: ReturnType<typeof buildPublishedCatalog>['variables']
  /** Without their masked-cell counts: how many are masked is not for the page. */
  crossings: (Omit<PublishedCrossing, 'masked'> & { masked?: PublishedCrossing['masked'] })[]
  concepts: ReturnType<typeof buildConceptTable>
  totals: Record<string, number>
}

export function buildCatalogPageData({ catalog, cache, locale = 'en', reveal = false }: Pick<ExportHtmlOptions, 'catalog' | 'cache' | 'locale' | 'reveal'>): CatalogPageData {
  const threshold = catalog.anonymization.threshold
  const masks = computeCatalogMasks(catalog, cache, threshold)
  const concepts = conceptListRows(publishedConcepts(catalog, cache, { reveal, masks }), threshold, reveal).sort(byPatients)
  const published = buildPublishedCatalog(catalog, cache, { locale, reveal, masks })
  const counts = catalogCounts(catalog)
  return {
    threshold,
    variables: published.variables,
    crossings: reveal ? published.crossings : published.crossings.map(({ masked: _masked, ...c }) => c),
    concepts: buildConceptTable(concepts, locale),
    totals: {
      patients: cache.totalPatients,
      ...(counts.visits ? { stays: cache.totalVisits } : {}),
      ...(counts.unitStays && cache.grandTotal.totalUnitStays != null ? { unitStays: cache.grandTotal.totalUnitStays } : {}),
      concepts: new Set(concepts.map((r) => r.conceptId)).size,
      records: cache.grandTotal.totalRecords,
    },
  }
}

/** The message the preview's page waits for, and the one it sends when ready for it. */
export const PAGE_DATA_MESSAGE = 'linkr-catalog-data'
export const PAGE_READY_MESSAGE = 'linkr-catalog-ready'

/** JSON safe to inline in a `<script>`: a `</script>` in a concept name cannot close it. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function generateCatalogHtml(opts: ExportHtmlOptions & {
  /** Built beforehand (`buildCatalogPageData`), for the same catalog, results, language and view. */
  data?: CatalogPageData
  /**
   * 'inline' (the published file): the data is in the page. 'parent' (the
   * app's preview): the page asks the window embedding it, which answers with
   * a PAGE_DATA_MESSAGE — no tens of megabytes to write and parse as HTML.
   */
  dataFrom?: 'inline' | 'parent'
}): string {
  const { catalog, cache, schemaMapping, fullSchema, locale = 'en', dataFrom = 'inline' } = opts
  const T = PAGE_TEXT[locale]
  const fmt = (n: number) => n.toLocaleString(locale)
  const threshold = catalog.anonymization.threshold
  const mode: AnonymizationMode = catalog.anonymization.mode ?? 'replace'
  const data = opts.data ?? buildCatalogPageData(opts)

  const metadata = catalog.dcatApMetadata ?? {}
  const jsonLd = JSON.stringify(buildJsonLd({ metadata, schemaMapping, fullSchema, cache, catalog }), null, 2)

  const catalogTitle = (metadata['catalog.title'] as string) || localized(catalog.name, locale)
  const catalogDesc = (metadata['catalog.description'] as string) || localized(catalog.description, locale) || ''
  const publisher = (metadata['publisher.name'] as string) || (metadata['agent.name'] as string) || ''
  const generated = new Date().toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const schema = buildSchemaSection(fullSchema, schemaMapping, locale)
  const counts = catalogCounts(catalog)

  const tab = (id: string, label: string, ico: IconName, count?: number, active = false) =>
    `<button class="tab${active ? ' active' : ''}" data-tab="${id}" role="tab" aria-selected="${active}">${icon(ico)}${label}${count != null ? `<span class="count num">${fmt(count)}</span>` : ''}</button>`

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(catalogTitle)} — ${esc(T.concept_catalog)}</title>
<script type="application/ld+json">
${jsonLd.replace(/</g, '\\u003c')}
</script>
<style>${CATALOG_CSS}</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="brand">${LINKR_LOGO_SVG}<div class="brand-t"><h1>${esc(catalogTitle)}</h1><div class="eyebrow">${esc(T.concept_catalog)}</div></div></div>
    ${catalogDesc ? `<p class="desc">${esc(catalogDesc)}</p>` : ''}
    <nav class="tabs" role="tablist">
      ${tab('explore', esc(T.tab_explore), 'barChart', undefined, true)}
      ${tab('metadata', esc(T.tab_metadata), 'fileText')}
      ${tab('schema', esc(T.tab_schema), 'table', schema.tableCount || undefined)}
      ${tab('info', esc(T.tab_info), 'info')}
    </nav>
  </header>

  <section id="tab-explore" class="tab-content active">
    <div class="explore">
      <aside class="card xp-side" id="xp-side" aria-label="${esc(T.side_aria)}"></aside>
      <div class="xp-main" id="xp-main"></div>
    </div>
  </section>

  <section id="tab-metadata" class="tab-content">
    <div class="section-head">
      <h2>${esc(T.metadata_title)}</h2><span class="sub">Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE} · ${esc(T.ehds)}</span><span class="spacer"></span>
      <button class="btn" id="open-jsonld" type="button" title="${esc(T.jsonld_view)}">${icon('code')}JSON-LD</button>
    </div>
${buildMetadataHtml(metadata, locale)}
  </section>

  <div id="jsonld-overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="jsonld-title">
    <div class="dialog">
      <div class="dialog-head">
        <div class="dialog-title" id="jsonld-title">${icon('code', 16)}${esc(T.jsonld_source)}</div>
        <button class="btn" id="copy-jsonld" type="button">${icon('copy', 13)}<span>${esc(T.copy)}</span></button>
        <button class="btn" id="download-jsonld" type="button">${icon('download', 13)}${esc(T.download)}</button>
        <button class="btn icon-only" id="close-jsonld" type="button" title="${esc(T.close)}" aria-label="${esc(T.close)}">${icon('x', 16)}</button>
      </div>
      <pre class="dialog-body"><code id="jsonld-code">${syntaxHighlight(jsonLd)}</code></pre>
    </div>
  </div>

  <section id="tab-schema" class="tab-content">
    <div class="section-head">
      <h2>${esc(T.schema_title)}</h2><span class="sub">${[schemaMapping?.presetLabel ? localized(schemaMapping.presetLabel, locale) : '', schema.tableCount ? fill(T.schema_tables_n, { n: schema.tableCount }) : ''].filter(Boolean).map(esc).join(' · ') || esc(T.schema_default_sub)}</span>
    </div>
${schema.html}
  </section>

  <section id="tab-info" class="tab-content">
${buildInfoHtml({ locale, threshold, mode, counts, crossings: data.crossings.map((c) => c.vars.map((v) => data.variables[v]?.label ?? v)), variables: Object.values(data.variables).map((v) => v!.label) })}
  </section>

  <footer>
    <span>${[fill(T.generated_on, { date: generated }), publisher].filter(Boolean).map(esc).join(' · ')}</span>
    <span>Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE} · ${esc(T.ehds)}</span>
    <span>${esc(T.generated_with)} <a href="${docUrl(locale)}" target="_blank" rel="noopener">Linkr</a></span>
  </footer>
</div>

<script>
var DATA = ${dataFrom === 'inline' ? inlineJson(data) : 'null'};
var META = ${inlineJson({
    fileBase: fileSlug(catalogTitle),
    conceptNote: icon('shield', 13) + fill(mode === 'suppress' ? T.concept_note_suppress : T.concept_note_replace, { t: threshold }),
  })};
var L = ${inlineJson({ ...T, locale })};
var TX = ${inlineJson(exploreText(locale))};
var ICONS = ${inlineJson({
    up: icon('arrowUp', 11), down: icon('arrowDown', 11), both: icon('arrowUpDown', 11),
    search: icon('search', 14), x: icon('x', 13), download: icon('download', 13),
    left: icon('chevronLeft', 14), right: icon('chevronRight', 14), chevron: icon('chevronDown', 14), shield: icon('shield', 13), info: icon('info', 12),
    user: icon('user', 16), stethoscope: icon('stethoscope', 16), activity: icon('activity', 16), tags: icon('tags', 16),
    layers: icon('layers', 16), trendingUp: icon('trendingUp', 16), barChart: icon('barChart', 16), sigma: icon('sigma', 16), table: icon('table', 16),
  })};
${dataFrom === 'inline' ? CATALOG_SCRIPT : `window.addEventListener('message', function onData(e) {
  if (e.source !== window.parent || !e.data || e.data.type !== '${PAGE_DATA_MESSAGE}') return;
  window.removeEventListener('message', onData);
  DATA = e.data.data;
  ${CATALOG_SCRIPT}
});
window.parent.postMessage({ type: '${PAGE_READY_MESSAGE}' }, '*');`}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

const docUrl = (locale: PageLocale) => `https://linkr.interhop.org/${locale === 'fr' ? '' : 'en/'}docs/warehouse/data-catalog`
const EHDS_URL = 'https://eur-lex.europa.eu/eli/reg/2025/327/oj'

/** What the page is, how its numbers were made and protected, and where to read more. */
function buildInfoHtml({ locale, threshold, mode, counts, crossings, variables }: {
  locale: PageLocale
  threshold: number
  mode: AnonymizationMode
  counts: CatalogCounts
  crossings: string[][]
  variables: string[]
}): string {
  const multi = crossings.filter((c) => c.length > 1)
  const card = (ico: IconName, title: string, body: string) =>
    `    <div class="card info-card"><div class="meta-card-head">${icon(ico, 15)}${title}</div><div class="info-body">${body}</div></div>`
  const vars = variables.map((v) => `<b>${esc(v.toLowerCase())}</b>`).join(', ')
  const crossed = multi.map((c) => esc(c.join(' × '))).join(', ')
  const spec = `<a href="${HEALTHDCATAP_SPEC_URL}" target="_blank" rel="noopener">Health-DCAT-AP Release ${HEALTHDCATAP_RELEASE}</a>`
  const linkr = '<a href="https://linkr.interhop.org" target="_blank" rel="noopener">Linkr</a>'
  if (locale === 'fr') {
    return [
      card('bookOpen', 'À propos de ce catalogue', `<p>Cette page décrit le contenu d'un entrepôt de données cliniques sans y donner accès : combien de patients, d'hospitalisations et d'enregistrements il contient, pour quels concepts, sur quelles périodes et quelles populations. Chaque nombre est un effectif agrégé ; aucune ligne concernant un patient ne sort de l'entrepôt.</p>
<p><b>Explorer</b> permet de lire les effectifs. Choisissez une, deux ou trois variables dans le panneau latéral, filtrez chacune d'elles : graphiques, chiffres clés et tableau suivent. <b>Métadonnées</b> décrit le jeu de données dans le vocabulaire Health-DCAT-AP, et <b>Schéma</b> la structure de l'entrepôt source.</p>`),
      card('barChart', 'Comment les effectifs sont calculés', `<p>L'entrepôt est compté selon ${vars || 'ses concepts'}. Chaque variable est comptée seule${multi.length ? `, et ces croisements ont été calculés : ${crossed}` : ''}.</p>
<ul><li>Les <b>patients</b> sont des patients distincts : un patient vu sur deux périodes compte une fois dans chacune, les patients ne s'additionnent donc pas d'une valeur à l'autre d'une variable.</li>
${counts.visits ? '<li>Les <b>hospitalisations</b> sont les séjours hospitaliers (visites) ; avec un concept, celles qui contiennent au moins un de ses enregistrements.</li>' : ''}
${counts.unitStays ? '<li>Les <b>séjours en unité</b> sont les séjours dans une unité de soins au sein de ces hospitalisations.</li>' : ''}
<li>Les <b>enregistrements</b> sont les lignes d'événements (mesures, médicaments, diagnostics…), comptées quand la variable concept fait partie du croisement.</li>
<li>La période et l'âge sont pris au début de l'hospitalisation, ou à la date de l'enregistrement.</li></ul>
<p>Les cellules ne sont jamais additionnées sur cette page : chaque chiffre affiché est une cellule calculée.</p>`),
      card('shield', 'Anonymisation', `<p>Tout effectif inférieur à <b>${threshold} patients</b> est ${mode === 'suppress' ? 'retiré' : 'masqué (affiché &lt; ' + threshold + ')'}. Cela ne suffit pas quand un total est publié : une cellule cachée pourrait être retrouvée en soustrayant les autres cellules du total. Une cellule de plus de ce groupe est donc masquée (<em>suppression secondaire</em>). Les cellules masquées ne portent aucun nombre dans aucun fichier publié.</p>
<p>Les périodes avant la première et après la dernière atteignant le seuil sont écartées.</p>`),
      card('package', 'Standards et fichiers', `<p>Les métadonnées suivent ${spec}, le profil européen de description des jeux de données de santé du <a href="${EHDS_URL}" target="_blank" rel="noopener">règlement sur l'Espace européen des données de santé (UE) 2025/327</a>. Elles sont intégrées à cette page en JSON-LD, lisible par les catalogues et les moteurs de recherche (Métadonnées › JSON-LD).</p>
<p>Le site publié contient cette page, <code>concepts.csv</code> (une ligne par concept), un CSV par croisement dans <code>crossings/</code>, et <code>metadata.jsonld</code>.</p>`),
      card('info', 'Réalisé avec Linkr', `<p>Ce catalogue a été calculé et publié avec ${linkr}, une plateforme open source pour les entrepôts de données cliniques. Comment il est configuré et calculé : <a href="${docUrl(locale)}" target="_blank" rel="noopener">documentation Linkr — Catalogue de données</a>.</p>`),
    ].join('\n')
  }
  return [
    card('bookOpen', 'About this catalog', `<p>This page describes the content of a clinical data warehouse without giving access to it: how many patients, hospitalizations and records it holds, for which concepts, over which periods and populations. Every number is an aggregate count; no row about a patient ever leaves the warehouse.</p>
<p><b>Explore</b> reads the counts. Pick one, two or three variables in the sidebar, filter each of them, and the charts, key figures and table follow. <b>Metadata</b> describes the dataset in the Health-DCAT-AP vocabulary, and <b>Schema</b> the structure of the source warehouse.</p>`),
    card('barChart', 'How the counts are made', `<p>The warehouse is counted along ${vars || 'its concepts'}. Each variable is counted on its own${multi.length ? `, and these crossings were computed: ${crossed}` : ''}.</p>
<ul><li><b>Patients</b> are distinct patients: one seen in two periods counts once in each, so patients never add up across the values of a variable.</li>
${counts.visits ? '<li><b>Hospitalizations</b> are hospital stays (visits); with a concept, those holding at least one of its records.</li>' : ''}
${counts.unitStays ? '<li><b>Unit stays</b> are the stays in a care unit within those hospitalizations.</li>' : ''}
<li><b>Records</b> are event rows (measurements, drugs, diagnoses…), counted when the concept variable is part of a crossing.</li>
<li>Period and age are taken at the start of the hospitalization, or at the date of the record.</li></ul>
<p>Cells are never summed on this page: every figure shown is one computed cell.</p>`),
    card('shield', 'Anonymisation', `<p>Any count below <b>${threshold} patients</b> is ${mode === 'suppress' ? 'removed' : 'masked (shown as &lt; ' + threshold + ')'}. That alone is not enough when a total is published: a hidden cell could be recovered by subtracting the other cells from the total. So one more cell of that group is masked too (<em>secondary suppression</em>). Masked cells carry no number in any published file.</p>
<p>Periods before the first and after the last one reaching the threshold are left out.</p>`),
    card('package', 'Standards and files', `<p>The metadata follows ${spec}, the European profile for describing health datasets under the <a href="${EHDS_URL}" target="_blank" rel="noopener">European Health Data Space regulation (EU) 2025/327</a>. It is embedded in this page as JSON-LD, readable by catalogues and search engines (Metadata › JSON-LD).</p>
<p>The published site holds this page, <code>concepts.csv</code> (one row per concept), one CSV per crossing under <code>crossings/</code>, and <code>metadata.jsonld</code>.</p>`),
    card('info', 'Made with Linkr', `<p>This catalog was computed and published with ${linkr}, an open-source platform for clinical data warehouses. How it is configured and computed: <a href="${docUrl(locale)}" target="_blank" rel="noopener">Linkr documentation — Data catalog</a>.</p>`),
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

export function buildConceptTable(concepts: Anonymized<CatalogConceptRow>[], locale: PageLocale = 'en') {
  const T = PAGE_TEXT[locale]
  const hasDictionary = new Set(concepts.map((r) => r.dictionaryKey).filter(Boolean)).size > 1
  const select = (key: string, label: string): ConceptCol => ({ key, label, type: 'text', filter: 'select', width: 150 })
  const count = (key: string, label: string): ConceptCol => ({ key, label, type: 'number', filter: 'min', width: 130 })
  const cols: ConceptCol[] = [
    { key: 'conceptId', label: T.col_concept_id, type: 'text', filter: 'text', width: 130, className: 'id' },
    { key: 'conceptName', label: T.col_concept_name, type: 'text', filter: 'text', width: 380, className: 'name' },
    ...(hasDictionary ? [select('dictionaryKey', T.col_vocabulary)] : []),
    ...(concepts.some((r) => r.category != null) ? [select('category', T.col_category)] : []),
    ...(concepts.some((r) => r.subcategory != null) ? [select('subcategory', T.col_subcategory)] : []),
    { ...count('patientCount', T.col_patients), className: 'p' },
    ...(concepts.some((r) => r.visitCount != null) ? [count('visitCount', T.col_visits)] : []),
    count('recordCount', T.col_records),
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

/** The table roles of `mappedTableDocs`, in French. */
const ROLE_FR: Record<string, string> = {
  'Patient demographics': 'Données démographiques des patients',
  'Visit / encounter records': 'Visites / hospitalisations',
  'Visit detail / unit stays': 'Séjours en unité',
  'Clinical notes': 'Notes cliniques',
  'Concept dictionary': 'Dictionnaire de concepts',
}

function mappingRoleLabels(mapping: SchemaMapping, locale: PageLocale): Map<string, string> {
  const labels = new Map<string, string>()
  // The first relation reading a table names its role (patient before visit before events).
  for (const t of mappedTableDocs(mapping)) if (!labels.has(t.table)) labels.set(t.table, locale === 'fr' ? ROLE_FR[t.role] ?? t.role : t.role)
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

function buildSchemaSection(fullSchema: IntrospectedTable[] | null | undefined, mapping: SchemaMapping | null | undefined, locale: PageLocale): { html: string; tableCount: number } {
  const T: PageText = PAGE_TEXT[locale]
  const types = mapping ? mappingTableTypes(mapping) : new Map<string, TableType>()
  const roles = mapping ? mappingColumnRoles(mapping) : new Map<string, Map<string, ColumnRole>>()
  const roleLabels = mapping ? mappingRoleLabels(mapping, locale) : new Map<string, string>()

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
      <h3 class="eyebrow">${esc(T.mapped_tables)}</h3>
      <div class="erd-scroll">${erd}</div>
      <div class="legend">${TYPE_ORDER.map((t) => `<span><i class="swatch t-${t}"></i>${esc(T[`legend_${t}`])}</span>`).join('')}${(['pk', 'fk', 'value', 'date'] as const).map((r) => `<span><i class="role r-${r}">${r}</i>${esc(T[`role_${r}`])}</span>`).join('')}<span>${esc(T.click_table)}</span></div>
    </div>` : ''

  if (!tables.length) {
    return { html: erdHtml || `    <div class="card empty">${esc(T.no_schema)}</div>`, tableCount: 0 }
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
        <div class="tbl-head">${icon(t.type ? TABLE_TYPE_ICON[t.type] : 'table', 14)}<span class="tbl-name" title="${esc(t.name)}">${esc(t.name)}</span><span class="tbl-count num">${t.columns.length} ${esc(t.columns.length === 1 ? T.col_one : T.col_other)}</span></div>
        ${t.role ? `<div class="tbl-role">${esc(t.role)}</div>` : ''}
        <table class="cols"><tbody>${rows}</tbody></table>
      </div>`
  }).join('\n')

  const layout = `    <div class="schema-layout">
      <aside class="card toc">
        <label class="toc-search">${icon('search', 13)}<input type="search" id="toc-filter" class="input" placeholder="${esc(T.filter_tables)}" autocomplete="off"></label>
        <nav class="toc-list">
${toc}
        </nav>
      </aside>
      <div class="schema-main">
${cards}
      </div>
    </div>`
  if (!erdHtml) return { tableCount: tables.length, html: layout }
  // The tables first: what a reader looks up; the diagram is the overview.
  return {
    tableCount: tables.length,
    html: `    <div class="subtabs"><div class="seg" id="schema-seg"><button type="button" data-pane="tables" class="active">${icon('table', 13)}${esc(T.schema_tab_tables)}</button><button type="button" data-pane="diagram">${icon('network', 13)}${esc(T.schema_tab_diagram)}</button></div></div>
    <div class="schema-pane" data-pane="tables">
${layout}
    </div>
    <div class="schema-pane" data-pane="diagram" hidden>
${erdHtml}
    </div>`,
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const CLASS_ICON: Record<DcatClass, IconName> = {
  catalog: 'folderOpen',
  dataset: 'database',
  distribution: 'package',
  agent: 'building',
}

const CLASS_ORDER: DcatClass[] = ['catalog', 'dataset', 'distribution', 'agent']

function buildMetadataHtml(raw: Record<string, unknown>, locale: PageLocale): string {
  const T = PAGE_TEXT[locale]
  const label = (key: string) => bundleText(locale, key) ?? bundleText('en', key) ?? key
  const metadata = normalizeDcatMetadata(raw)
  const sections = CLASS_ORDER.flatMap((cls) => {
    const filled = DCAT_FIELDS.filter((f) => f.dcatClass === cls && metadata[f.key] != null && metadata[f.key] !== '')
    if (!filled.length) return []
    const rows = filled.map((f) => `        <div class="meta-row">
          <div class="meta-label">${esc(label(f.labelKey))}</div>
          <div class="meta-value">${resolveFieldDisplay(f.key, metadata[f.key], f.type, f.vocabularyKey, locale)}</div>
          <div class="meta-uri">${esc(f.uri)}</div>
        </div>`).join('\n')
    return [`    <div class="card meta-card">
      <div class="meta-card-head">${icon(CLASS_ICON[cls], 15)}${esc(T[`class_${cls}`])}</div>
${rows}
    </div>`]
  })
  return sections.length ? sections.join('\n') : `    <div class="card empty">${esc(T.no_metadata)}</div>`
}

function resolveFieldDisplay(key: string, raw: unknown, type: string, vocabKey: string | undefined, locale: PageLocale): string {
  if (vocabKey && DCAT_VOCABULARIES[vocabKey]) {
    const vocab = DCAT_VOCABULARIES[vocabKey]
    const values = typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw) ? raw.map(String) : [String(raw)]
    return values.map((v) => {
      const opt = vocab.find((o) => o.value === v)
      return `<span class="pill">${esc(opt ? (opt.labelKey && bundleText(locale, opt.labelKey)) || opt.label : v)}</span>`
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

  if (type === 'boolean') return raw === true || raw === 'true' ? PAGE_TEXT[locale].yes : PAGE_TEXT[locale].no

  if (type === 'tags' && Array.isArray(raw)) {
    return raw.map((k) => `<span class="pill">${esc(String(k))}</span>`).join('')
  }

  if (type === 'number') {
    const n = Number(raw)
    return isNaN(n) ? esc(String(raw)) : `<strong class="num">${n.toLocaleString(locale)}</strong>`
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

/**
 * The concept list as CSV, masked like the page: in suppress mode the masked
 * concepts are left out; in replace mode their counts are empty — a number
 * column holds numbers only — and the status column says they are suppressed.
 */
export function buildConceptsCsv(catalog: DataCatalog, cache: CatalogResultCache): string {
  // Masked rows sorted as their capped count, never their real one: the order must not place them.
  const concepts = conceptListRows(publishedConcepts(catalog, cache), catalog.anonymization.threshold, false).sort(byPatients)
  const withVisits = concepts.some((r) => r.visitCount != null)
  const header = ['concept_id', 'concept_name', 'vocabulary', 'category', 'subcategory',
    'patient_count', ...(withVisits ? ['visit_count'] : []), 'record_count', 'status']
  const rows: string[] = [header.join(',')]

  for (const r of concepts) {
    const shown = !r._anonymized
    const count = (n: number | undefined) => (shown ? String(n ?? 0) : '')
    rows.push([
      csvEscape(r.conceptId), csvEscape(r.conceptName),
      csvEscape(r.dictionaryKey ?? ''), csvEscape(r.category ?? ''), csvEscape(r.subcategory ?? ''),
      count(r.patientCount), ...(withVisits ? [count(r.visitCount)] : []), count(r.recordCount),
      shown ? 'published' : 'suppressed',
    ].join(','))
  }

  return rows.join('\n')
}
