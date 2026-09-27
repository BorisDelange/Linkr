/** Pure helpers for the documentation tools: wiki tree, data catalogs, READMEs. */
import { foldAccents } from '@/lib/fold-accents'
import { localized, setLocalized, toLocalized } from '@/lib/localized'
import { conceptRelations, has } from '@/lib/schema-classes/relations'
import { fieldColumn } from '@/lib/schema-classes/spec'
import { AGE_BRACKET_PRESETS, type AnonymizationMode, type CatalogPeriodRow, type CatalogResultCache, type DataCatalog, type DimensionConfig, type PeriodConfig } from '@/types/catalog'
import type { LocalizedString, SchemaMapping, WikiPage } from '@/types'

// --- Wiki ---------------------------------------------------------------------

/** The wiki store's slug: set from the English title on create and on rename. */
export function wikiSlug(title: string): string {
  return foldAccents(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'page'
}

type TreePage = Pick<WikiPage, 'id' | 'parentId' | 'sortOrder'>

export function childrenOf<T extends TreePage>(pages: T[], parentId: string | null): T[] {
  return pages.filter((p) => (p.parentId ?? null) === parentId).sort((a, b) => a.sortOrder - b.sortOrder)
}

/** The page and every page under it, deepest first (children deleted before their parent). */
export function subtreeIds(pages: TreePage[], id: string): string[] {
  const out: string[] = []
  const walk = (pid: string) => {
    for (const c of childrenOf(pages, pid)) walk(c.id)
    out.push(pid)
  }
  walk(id)
  return out
}

/** Titles from the root down to the page, the page included. */
export function breadcrumbs(pages: WikiPage[], id: string, lang = 'en'): string[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const out: string[] = []
  const seen = new Set<string>()
  for (let p = byId.get(id); p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
    seen.add(p.id)
    out.unshift(localized(p.title, lang) || '(untitled)')
  }
  return out
}

/** The wiki as an indented tree, one line per page, capped at `max` lines. */
export function renderWikiTree(pages: WikiPage[], max = 300, lang = 'en'): string {
  const lines: string[] = []
  const known = new Set(pages.map((p) => p.id))
  const walk = (parentId: string | null, depth: number) => {
    for (const p of childrenOf(pages, parentId)) {
      lines.push(`${'  '.repeat(depth)}- ${localized(p.title, lang) || '(untitled)'} — page_id: ${p.id}`
        + `${p.verified ? ' · verified' : ''}${chars(p.content)}`)
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  // A page whose parent was deleted still exists; the app shows nothing for it,
  // but the agent should see it rather than lose it.
  const orphans = pages.filter((p) => p.parentId && !known.has(p.parentId))
  for (const p of orphans) {
    lines.push(`- ${localized(p.title, lang) || '(untitled)'} — page_id: ${p.id} · orphan (parent ${p.parentId} missing)`)
    walk(p.id, 1)
  }
  if (lines.length <= max) return lines.join('\n')
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more page(s) not shown.`
}

function chars(content: LocalizedString | string | undefined): string {
  const langs = Object.entries(toLocalized(content)).filter(([, v]) => v.trim()).map(([l]) => l)
  return langs.length ? ` · ${langs.join('/')}` : ' · empty'
}

/**
 * The writes that put `pageId` under `newParentId` at `position` (0-based, end
 * when omitted or past the end), renumbering the new siblings 0..n like the
 * store's reorderPages. Refuses a move under the page's own subtree.
 */
export function planMove(
  pages: TreePage[], pageId: string, newParentId: string | null, position?: number,
): { updates: { id: string; parentId?: string | null; sortOrder: number }[] } | { error: string } {
  if (!pages.some((p) => p.id === pageId)) return { error: `No wiki page ${pageId} in this workspace.` }
  if (newParentId !== null) {
    if (!pages.some((p) => p.id === newParentId)) return { error: `No wiki page ${newParentId} in this workspace.` }
    if (subtreeIds(pages, pageId).includes(newParentId)) return { error: 'A page cannot be moved under itself or one of its own sub-pages.' }
  }
  const siblings = childrenOf(pages, newParentId).filter((p) => p.id !== pageId).map((p) => p.id)
  const at = position == null ? siblings.length : Math.max(0, Math.min(Math.floor(position), siblings.length))
  siblings.splice(at, 0, pageId)
  const current = new Map(pages.map((p) => [p.id, p]))
  const updates: { id: string; parentId?: string | null; sortOrder: number }[] = []
  siblings.forEach((id, sortOrder) => {
    const p = current.get(id)!
    if (id === pageId && (p.parentId ?? null) !== newParentId) updates.push({ id, parentId: newParentId, sortOrder })
    else if (p.sortOrder !== sortOrder || id === pageId) updates.push({ id, sortOrder })
  })
  return { updates }
}

/** Cut long text, saying how much was left out. */
export function clip(body: string, max: number): string {
  if (body.length <= max) return body
  return `${body.slice(0, max)}\n\n[… ${body.length - max} more characters not shown]`
}

// --- READMEs ------------------------------------------------------------------

/** Entities carrying a Markdown README (a LocalizedString field `readme`), by the
 *  name the tools use, with their REST path and the README-attachment owner type. */
export const README_OWNERS = {
  workspace: { path: '/workspaces', ownerType: 'workspace', what: 'a workspace (the top-level space holding projects, databases, the wiki)' },
  database: { path: '/data-sources', ownerType: 'data-source', what: 'a database (a connected clinical data source)' },
  mapping_project: { path: '/mapping-projects', ownerType: 'mapping-project', what: 'a concept-mapping project' },
  sql_collection: { path: '/sql-script-collections', ownerType: 'sql-collection', what: 'a workspace SQL script collection' },
  etl_pipeline: { path: '/etl-pipelines', ownerType: 'etl-pipeline', what: 'an ETL pipeline' },
  dq_rule_set: { path: '/dq-rule-sets', ownerType: 'dq-rule-set', what: 'a data-quality rule set' },
  data_catalog: { path: '/data-catalogs', ownerType: 'data-catalog', what: 'a data catalog' },
  plugin: { path: '/user-plugins', ownerType: 'user-plugin', what: 'a custom plugin' },
} as const

export type ReadmeOwner = keyof typeof README_OWNERS

/** The README in one language: its own text first, then the app's fallback order. */
export function readmeIn(readme: LocalizedString | string | null | undefined, lang: string): { text: string; languages: string[] } {
  const all = toLocalized(readme)
  const languages = Object.entries(all).filter(([, v]) => v.trim()).map(([l]) => l)
  return { text: localized(readme, lang), languages }
}

/** Write one language, keeping the others (the README editor's rule). */
export const withReadme = (readme: LocalizedString | string | null | undefined, lang: string, text: string) =>
  setLocalized(readme, lang, text)

// --- Data catalogs ------------------------------------------------------------

/** Columns a catalog can classify concepts by: the dictionaries' category and
 *  subcategory (named by the source column they read) and their extra columns —
 *  what the Configuration tab offers. */
export function catalogClassColumns(mapping: SchemaMapping | null | undefined): string[] {
  if (!mapping) return []
  const keys = new Set<string>()
  for (const d of conceptRelations(mapping)) {
    const spec = mapping.concepts?.find((c) => c.key === d.key)
    for (const column of ['category', 'subcategory'] as const) {
      if (has(d, column)) keys.add(fieldColumn(spec, column)?.column ?? column)
    }
    for (const key of Object.keys(d.extras ?? {})) keys.add(key)
  }
  return [...keys].sort()
}

export interface CatalogChanges {
  sex_enabled?: boolean
  age_group_enabled?: boolean
  /** Bracket lower bounds, or a preset name. */
  age_brackets?: number[] | string
  care_site_enabled?: boolean
  care_site_level?: 'visit' | 'visit_detail'
  /** null turns the period table off. */
  period?: null | {
    granularity?: 'month' | 'quarter' | 'year'
    service_labels?: string[] | null
    concept_categories?: string[]
  }
  anonymization_threshold?: number
  anonymization_mode?: AnonymizationMode
  category_column?: string | null
  subcategory_column?: string | null
}

/**
 * The PATCH body for a catalog configuration change, following the
 * Configuration tab's rules: the admission-date dimension moves with the period
 * table (it is its axis) and its step with the granularity; a column cannot be
 * both category and subcategory. Cleared fields are sent as null, never
 * undefined — the API reads a missing key as "no change".
 */
export function catalogPatch(
  catalog: Pick<DataCatalog, 'dimensions' | 'periodConfig' | 'anonymization' | 'categoryColumn' | 'subcategoryColumn' | 'computedPeriods'>,
  c: CatalogChanges,
  classColumns: string[],
): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {}
  let dims: DimensionConfig[] = catalog.dimensions.map((d) => ({ ...d }))
  const setDim = (type: DimensionConfig['type'], change: Partial<DimensionConfig>) => {
    dims = dims.map((d) => (d.type === type ? { ...d, ...change } : d))
  }
  const touchesPeriodAxis = c.period !== undefined
  if (touchesPeriodAxis && catalog.computedPeriods != null) {
    return { error: 'A computation of this catalog is paused mid-way: its period table cannot change until it is finished (compute_data_catalog) or discarded (reset_data_catalog_results).' }
  }

  if (c.sex_enabled !== undefined) setDim('sex', { enabled: c.sex_enabled })
  if (c.age_group_enabled !== undefined) setDim('age_group', { enabled: c.age_group_enabled })
  if (c.age_brackets !== undefined) {
    let brackets: number[]
    if (typeof c.age_brackets === 'string') {
      const preset = AGE_BRACKET_PRESETS[c.age_brackets]
      if (!preset) return { error: `Unknown age bracket preset "${c.age_brackets}". Presets: ${Object.keys(AGE_BRACKET_PRESETS).join(', ')}.` }
      brackets = [...preset]
    } else {
      if (c.age_brackets.some((b) => !Number.isInteger(b) || b <= 0)) return { error: 'age_brackets must be positive whole numbers of years.' }
      brackets = [...new Set(c.age_brackets)].sort((a, b) => a - b)
    }
    setDim('age_group', { ageGroup: { brackets } })
  }
  if (c.care_site_enabled !== undefined) setDim('care_site', { enabled: c.care_site_enabled })
  if (c.care_site_level !== undefined) {
    const current = dims.find((d) => d.type === 'care_site')?.careSite
    setDim('care_site', { careSite: { ...current, level: c.care_site_level } })
  }

  if (c.period === null) {
    patch.periodConfig = null
    setDim('admission_date', { enabled: false })
  } else if (c.period) {
    const current: PeriodConfig = catalog.periodConfig ?? { granularity: 'month', serviceLevel: 'visit_detail' }
    const next: PeriodConfig = { ...current }
    if (c.period.granularity) next.granularity = c.period.granularity
    if (c.period.service_labels !== undefined) {
      if (c.period.service_labels?.length) next.serviceLabels = c.period.service_labels
      else delete next.serviceLabels
    }
    if (c.period.concept_categories !== undefined) next.conceptCategories = c.period.concept_categories
    patch.periodConfig = next
    // AdmissionDateConfig.step has no 'quarter': the dimension follows at the nearest step it can hold.
    setDim('admission_date', { enabled: true, admissionDate: { step: next.granularity === 'year' ? 'year' : 'month' } })
  }

  if (c.anonymization_threshold !== undefined || c.anonymization_mode !== undefined) {
    const threshold = c.anonymization_threshold ?? catalog.anonymization.threshold
    if (!Number.isInteger(threshold) || threshold < 1) return { error: 'anonymization_threshold must be a whole number ≥ 1.' }
    patch.anonymization = { threshold, mode: c.anonymization_mode ?? catalog.anonymization.mode ?? 'replace' }
  }

  for (const [key, value] of [['category_column', c.category_column], ['subcategory_column', c.subcategory_column]] as const) {
    if (value && !classColumns.includes(value)) {
      return { error: `Unknown ${key} "${value}". Columns this database offers: ${classColumns.join(', ') || '(none)'}.` }
    }
  }
  let category = catalog.categoryColumn ?? null
  let subcategory = catalog.subcategoryColumn ?? null
  if (c.category_column !== undefined) {
    category = c.category_column || null
    if (subcategory === category) subcategory = null
  }
  if (c.subcategory_column !== undefined) {
    subcategory = c.subcategory_column || null
    if (subcategory === category) category = null
  }
  if (category !== (catalog.categoryColumn ?? null)) patch.categoryColumn = category
  if (subcategory !== (catalog.subcategoryColumn ?? null)) patch.subcategoryColumn = subcategory

  if (JSON.stringify(dims) !== JSON.stringify(catalog.dimensions)) patch.dimensions = dims
  return { patch }
}

/** A count as the Data tab shows it: below the threshold it is masked. */
export const maskedCount = (n: number | null | undefined, threshold: number): string =>
  n == null ? `< ${threshold}` : n < threshold ? `< ${threshold}` : String(n)

export function describeCatalogConfig(catalog: DataCatalog): string[] {
  const out: string[] = []
  const dims = catalog.dimensions.map((d) => {
    let extra = ''
    if (d.type === 'age_group' && d.ageGroup) extra = ` [${d.ageGroup.brackets.join(', ')}]`
    if (d.type === 'care_site' && d.careSite) extra = ` (${d.careSite.level})`
    if (d.type === 'admission_date' && d.admissionDate) extra = ` (${d.admissionDate.step})`
    return `${d.type}${d.enabled ? '' : ' (off)'}${extra}`
  })
  out.push(`Dimensions: ${dims.join(' · ')}`)
  out.push(`Anonymization: counts below ${catalog.anonymization.threshold} are ${catalog.anonymization.mode === 'suppress' ? 'suppressed' : 'masked'}`)
  out.push(`Concept category column: ${catalog.categoryColumn ?? '(none)'} · subcategory: ${catalog.subcategoryColumn ?? '(none)'}`)
  const p = catalog.periodConfig
  out.push(p
    ? `Period table: by ${p.granularity}, services at ${p.serviceLevel} level${p.serviceLabels?.length ? ` limited to ${p.serviceLabels.join(', ')}` : ''}`
      + `${p.conceptCategories?.length ? `, concept categories ${p.conceptCategories.join(', ')}` : ''}`
    : 'Period table: off')
  return out
}

export function describeCatalogStatus(catalog: DataCatalog): string {
  const paused = catalog.computedPeriods != null
  const parts = [`Status: ${paused ? `paused after ${catalog.computedPeriods} period row(s)` : catalog.status}`]
  if (catalog.lastComputedAt) parts.push(`last computed ${catalog.lastComputedAt}${catalog.lastComputeDurationMs != null ? ` in ${Math.round(catalog.lastComputeDurationMs / 1000)} s` : ''}`)
  if (catalog.status === 'error' && catalog.lastError) parts.push(`error: ${catalog.lastError}`)
  return parts.join(' · ')
}

export type ResultsView = 'summary' | 'concepts' | 'dimensions' | 'periods'

/** A computed catalog, as bounded text. Counts below the threshold are masked. */
export function renderCatalogResults(
  cache: CatalogResultCache,
  threshold: number,
  view: ResultsView,
  opts: { limit?: number; search?: string; category?: string } = {},
): string {
  const limit = opts.limit ?? 50
  const m = (n: number | null | undefined) => maskedCount(n, threshold)
  const head = `Computed ${cache.computedAt}: ${m(cache.totalPatients)} patients · ${m(cache.totalVisits)} visits · `
    + `${cache.totalConcepts} concepts${cache.periods ? ` · ${cache.periods.length} period row(s)` : ''}`
    + (cache.periodReliabilityScore != null ? ` · ${Math.round(cache.periodReliabilityScore * 100)}% of period cells masked` : '')
  if (view === 'summary') {
    const byCategory = new Map<string, number>()
    for (const c of cache.concepts) byCategory.set(c.category ?? '(none)', (byCategory.get(c.category ?? '(none)') ?? 0) + 1)
    const cats = [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k}: ${n}`)
    const top = [...cache.concepts].sort((a, b) => b.patientCount - a.patientCount).slice(0, 10)
      .map((c) => `  ${c.conceptName} (${c.conceptId}) — ${m(c.patientCount)} patients`)
    return [head, cats.length ? `Concepts by category: ${cats.join(' · ')}` : '', 'Top concepts by patients:', ...top]
      .filter(Boolean).join('\n')
  }
  if (view === 'concepts') {
    const q = opts.search?.toLowerCase()
    const rows = cache.concepts
      .filter((c) => !opts.category || c.category === opts.category)
      .filter((c) => !q || c.conceptName?.toLowerCase().includes(q) || String(c.conceptId).includes(q))
      .sort((a, b) => b.patientCount - a.patientCount)
    const lines = rows.slice(0, limit).map((c) =>
      `${c.conceptId} · ${c.conceptName}${c.category ? ` · ${c.category}` : ''}${c.subcategory ? ` / ${c.subcategory}` : ''}`
      + ` · patients ${m(c.patientCount)} · visits ${m(c.visitCount)} · records ${m(c.recordCount)}`)
    return [head, `${rows.length} matching concept(s)${rows.length > limit ? `, first ${limit} by patients` : ''}:`, ...lines].join('\n')
  }
  if (view === 'dimensions') {
    const lines = cache.dimensions.slice(0, Math.max(limit, 200)).map((d) =>
      `${d.dimensionType} = ${d.value} · patients ${m(d.patientCount)} · visits ${m(d.visitCount)} · records ${m(d.recordCount)}`)
    return [head, ...lines].join('\n')
  }
  const periods = cache.periods ?? []
  if (periods.length === 0) return `${head}\nNo period table (off in the configuration, or not computed yet).`
  const periodLine = (r: CatalogPeriodRow) => {
    const extra = [
      `M ${m(r.sex_m)} F ${m(r.sex_f)}`,
      ...Object.entries(r.age_buckets).map(([k, v]) => `${k} ${m(v)}`),
      ...Object.entries(r.services).map(([k, v]) => `${k} ${m(v.n_patients)}`),
      ...Object.entries(r.concept_categories).map(([k, v]) => `${k} ${m(v.n_patients)}`),
    ]
    return `${r.period_label} · patients ${m(r.n_patients)} · stays ${m(r.n_sejours)} · ${extra.join(' · ')}`
  }
  const lines = periods.slice(0, limit).map(periodLine)
  return [head, ...lines, ...(periods.length > limit ? [`… ${periods.length - limit} more period row(s).`] : [])].join('\n')
}
