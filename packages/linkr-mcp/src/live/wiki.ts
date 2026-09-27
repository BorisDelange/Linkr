/** Pure helpers for the documentation tools: wiki tree, data catalogs, READMEs. */
import { foldAccents } from '@/lib/fold-accents'
import { localized, setLocalized, toLocalized } from '@/lib/localized'
import { conceptRelations, has } from '@/lib/schema-classes/relations'
import { fieldColumn } from '@/lib/schema-classes/spec'
import {
  AGE_BRACKET_PRESETS, CATALOG_VARIABLE_ORDER, type AnonymizationMode, type CatalogResultCache, type CatalogVariableId, type CatalogVariables,
  type ConceptVariableConfig, type DataCatalog, type PeriodGranularity, type ServiceVariableConfig,
} from '@/types/catalog'
import {
  DEFAULT_CONCEPT_CONFIG, DEFAULT_SERVICE_CONFIG, canonicalCrossing, catalogCounts, crossingId, defaultCatalogVariables, effectiveCrossings, shownCrossingIds,
} from '@/lib/data-catalog/config'
import { buildPublishedCatalog, computeCatalogMasks, publishedConcepts } from '@/lib/data-catalog/publish'
import { PRIMARY, PUBLISHED, SECONDARY } from '@/lib/data-catalog/suppression'
import type { LocalizedString, SchemaMapping, WikiPage } from '@/types'
import { subtreeIds } from './helpers.js'

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

/** Variable ids the tools take, in the catalog's canonical order. */
export const CATALOG_VARIABLES = CATALOG_VARIABLE_ORDER

export interface CatalogChanges {
  concept_enabled?: boolean
  /** Count each concept, or its category / subcategory. */
  concept_level?: ConceptVariableConfig['level']
  category_column?: string | null
  subcategory_column?: string | null
  /** Every concept, or only the N with the most patients. */
  concept_scope?: ConceptVariableConfig['scope']
  concept_top_n?: number
  period_enabled?: boolean
  period_granularity?: PeriodGranularity
  /** Granularity units per period: 2 with 'year' counts every two years. */
  period_step?: number
  service_enabled?: boolean
  service_level?: ServiceVariableConfig['level']
  service_grouping?: ServiceVariableConfig['grouping']
  service_top_n?: number
  /** Manual grouping: raw service name → group name. */
  service_groups?: Record<string, string>
  service_unassigned?: ServiceVariableConfig['unassigned']
  age_enabled?: boolean
  /** Bracket lower bounds, or a preset name. */
  age_brackets?: number[] | string
  sex_enabled?: boolean
  /** The whole list of crossings to compute, each 1 to 3 variable ids. */
  crossings?: string[][]
  count_stays?: boolean
  count_unit_stays?: boolean
  anonymization_threshold?: number
  anonymization_mode?: AnonymizationMode
}

/** Changes that alter what a run counts: refused while a run is paused mid-way. */
const COMPUTED_FIELDS: (keyof CatalogChanges)[] = [
  'concept_enabled', 'concept_level', 'category_column', 'subcategory_column', 'concept_scope', 'concept_top_n',
  'period_enabled', 'period_granularity', 'period_step', 'service_enabled', 'service_level', 'service_grouping',
  'service_top_n', 'service_groups', 'service_unassigned', 'age_enabled', 'age_brackets', 'sex_enabled',
  'crossings', 'count_stays', 'count_unit_stays',
]

const positiveInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1

/**
 * The PATCH body for a catalog configuration change, following the
 * Configuration tab's rules: a column cannot be both category and subcategory,
 * counting categories needs a category column, crossings are 1 to 3 distinct
 * variables stored in canonical order. Cleared fields are sent as null, never
 * undefined — the API reads a missing key as "no change".
 */
export function catalogPatch(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'counts' | 'anonymization' | 'computedSteps'>,
  c: CatalogChanges,
  classColumns: string[],
): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {}
  if (catalog.computedSteps != null && COMPUTED_FIELDS.some((k) => c[k] !== undefined)) {
    return { error: 'A computation of this catalog is paused mid-way: what it counts cannot change until it is finished (compute_data_catalog) or discarded (reset_data_catalog_results).' }
  }
  const defaults = defaultCatalogVariables()
  const v: CatalogVariables = structuredClone(catalog.variables ?? {})
  const concept = (v.concept ??= { ...DEFAULT_CONCEPT_CONFIG })
  const period = (v.period ??= { ...defaults.period! })
  const service = (v.service ??= { ...DEFAULT_SERVICE_CONFIG, groups: {} })
  const age = (v.age ??= { ...defaults.age! })
  const sex = (v.sex ??= { enabled: false })

  if (c.concept_enabled !== undefined) concept.enabled = c.concept_enabled
  if (c.concept_scope !== undefined) concept.scope = c.concept_scope
  if (c.concept_top_n !== undefined) {
    if (!positiveInt(c.concept_top_n)) return { error: 'concept_top_n must be a whole number ≥ 1.' }
    concept.topN = c.concept_top_n
  }
  for (const [key, value] of [['category_column', c.category_column], ['subcategory_column', c.subcategory_column]] as const) {
    if (value && !classColumns.includes(value)) {
      return { error: `Unknown ${key} "${value}". Columns this database offers: ${classColumns.join(', ') || '(none)'}.` }
    }
  }
  if (c.category_column !== undefined) {
    concept.categoryColumn = c.category_column || undefined
    if (concept.subcategoryColumn === concept.categoryColumn) concept.subcategoryColumn = undefined
  }
  if (c.subcategory_column !== undefined) {
    concept.subcategoryColumn = c.subcategory_column || undefined
    if (concept.subcategoryColumn === concept.categoryColumn) concept.categoryColumn = undefined
  }
  if (c.concept_level !== undefined) concept.level = c.concept_level
  if (concept.level === 'category' && !concept.categoryColumn) return { error: 'concept_level "category" needs a category_column.' }
  if (concept.level === 'subcategory' && !concept.subcategoryColumn) return { error: 'concept_level "subcategory" needs a subcategory_column.' }

  if (c.period_enabled !== undefined) period.enabled = c.period_enabled
  if (c.period_granularity !== undefined) period.granularity = c.period_granularity
  if (c.period_step !== undefined) {
    if (!positiveInt(c.period_step)) return { error: 'period_step must be a whole number ≥ 1.' }
    if (c.period_step === 1) delete period.step
    else period.step = c.period_step
  }

  if (c.service_enabled !== undefined) service.enabled = c.service_enabled
  if (c.service_level !== undefined) service.level = c.service_level
  if (c.service_grouping !== undefined) service.grouping = c.service_grouping
  if (c.service_top_n !== undefined) {
    if (!positiveInt(c.service_top_n)) return { error: 'service_top_n must be a whole number ≥ 1.' }
    service.topN = c.service_top_n
  }
  if (c.service_groups !== undefined) service.groups = { ...c.service_groups }
  if (c.service_unassigned !== undefined) service.unassigned = c.service_unassigned

  if (c.age_enabled !== undefined) age.enabled = c.age_enabled
  if (c.age_brackets !== undefined) {
    if (typeof c.age_brackets === 'string') {
      const preset = AGE_BRACKET_PRESETS[c.age_brackets]
      if (!preset) return { error: `Unknown age bracket preset "${c.age_brackets}". Presets: ${Object.keys(AGE_BRACKET_PRESETS).join(', ')}.` }
      age.brackets = [...preset]
    } else {
      if (c.age_brackets.length === 0 || c.age_brackets.some((b) => !positiveInt(b))) return { error: 'age_brackets must be positive whole numbers of years.' }
      age.brackets = [...new Set(c.age_brackets)].sort((a, b) => a - b)
    }
  }
  if (c.sex_enabled !== undefined) sex.enabled = c.sex_enabled

  if (JSON.stringify(v) !== JSON.stringify(catalog.variables ?? {})) patch.variables = v

  if (c.crossings !== undefined) {
    const seen = new Set<string>()
    const crossings: CatalogVariableId[][] = []
    for (const raw of c.crossings) {
      const bad = raw.find((id) => !CATALOG_VARIABLE_ORDER.includes(id as CatalogVariableId))
      if (bad) return { error: `Unknown variable "${bad}" in crossings. Variables: ${CATALOG_VARIABLE_ORDER.join(', ')}.` }
      const vars = canonicalCrossing(raw as CatalogVariableId[])
      if (vars.length < 1 || vars.length > 3) return { error: `A crossing has 1 to 3 distinct variables (got ${raw.join(' × ') || 'none'}).` }
      const id = crossingId(vars)
      if (seen.has(id)) continue
      seen.add(id)
      crossings.push(vars)
    }
    if (JSON.stringify(crossings) !== JSON.stringify(catalog.crossings ?? [])) patch.crossings = crossings
  }

  if (c.count_stays !== undefined || c.count_unit_stays !== undefined) {
    const counts = { ...catalogCounts(catalog) }
    if (c.count_stays !== undefined) counts.visits = c.count_stays
    if (c.count_unit_stays !== undefined) counts.unitStays = c.count_unit_stays
    if (JSON.stringify(counts) !== JSON.stringify(catalogCounts(catalog))) patch.counts = counts
  }

  if (c.anonymization_threshold !== undefined || c.anonymization_mode !== undefined) {
    const threshold = c.anonymization_threshold ?? catalog.anonymization.threshold
    if (!positiveInt(threshold)) return { error: 'anonymization_threshold must be a whole number ≥ 1.' }
    patch.anonymization = { threshold, mode: c.anonymization_mode ?? catalog.anonymization.mode ?? 'replace' }
  }
  return { patch }
}

/** A count as the page shows it: below the threshold it is masked. */
export const maskedCount = (n: number | null | undefined, threshold: number): string =>
  n == null ? `< ${threshold}` : n < threshold ? `< ${threshold}` : String(n)

function describeVariable(id: CatalogVariableId, v: CatalogVariables): string {
  switch (id) {
    case 'concept': {
      const c = v.concept!
      const cols = [c.categoryColumn && `category ${c.categoryColumn}`, c.subcategoryColumn && `subcategory ${c.subcategoryColumn}`].filter(Boolean).join(', ')
      return `concept (by ${c.level}${cols ? `; ${cols}` : ''}; ${c.scope === 'top' ? `top ${c.topN}` : 'all'})`
    }
    case 'period': return `period (by ${v.period!.step && v.period!.step > 1 ? `${v.period!.step} ` : ''}${v.period!.granularity})`
    case 'service': {
      const s = v.service!
      const grouping = s.grouping === 'top' ? `top ${s.topN} + other` : s.grouping === 'manual' ? `${new Set(Object.values(s.groups)).size} manual group(s), others ${s.unassigned === 'other' ? 'as other' : 'kept'}` : 'all'
      return `service (${s.level === 'visit' ? 'visit type' : 'care unit'}; ${grouping})`
    }
    case 'age': return `age [${v.age!.brackets.join(', ')}]`
    case 'sex': return 'sex'
  }
}

export function describeCatalogConfig(catalog: DataCatalog): string[] {
  const v = catalog.variables ?? {}
  const on = CATALOG_VARIABLE_ORDER.filter((id) => v[id]?.enabled)
  const off = CATALOG_VARIABLE_ORDER.filter((id) => !v[id]?.enabled)
  const counts = catalogCounts(catalog)
  const computed = effectiveCrossings(catalog).map((c) => c.join(' × '))
  const shown = shownCrossingIds(catalog)
  const alone = (catalog.crossings ?? []).filter((c) => c.length === 1 && (!shown || shown.has(crossingId(c)))).map((c) => c[0])
  return [
    `Variables: ${on.map((id) => describeVariable(id, v)).join(' · ') || '(none)'}${off.length ? ` — off: ${off.join(', ')}` : ''}`,
    `Crossings computed: ${computed.join(' · ') || '(none)'}`,
    `Published alone: ${alone.join(', ') || '(none)'}`,
    `Counts: patients${counts.visits ? ', hospital stays' : ''}${counts.unitStays ? ', unit stays' : ''}`,
    `Anonymization: counts below ${catalog.anonymization.threshold} are ${catalog.anonymization.mode === 'suppress' ? 'suppressed' : 'masked'}, and cells that would reveal them by subtraction too`,
  ]
}

export function describeCatalogStatus(catalog: DataCatalog): string {
  const paused = catalog.computedSteps != null
  const parts = [`Status: ${paused ? `paused after ${catalog.computedSteps} step(s)` : catalog.status}`]
  if (catalog.lastComputedAt) parts.push(`last computed ${catalog.lastComputedAt}${catalog.lastComputeDurationMs != null ? ` in ${Math.round(catalog.lastComputeDurationMs / 1000)} s` : ''}`)
  if (catalog.status === 'error' && catalog.lastError) parts.push(`error: ${catalog.lastError}`)
  return parts.join(' · ')
}

export type ResultsView = 'summary' | 'concepts' | 'crossing'

/**
 * A computed catalog, as bounded text, masked exactly as the published page
 * masks it: concepts below the threshold capped or dropped, crossing cells
 * through primary and secondary suppression (`buildPublishedCatalog`).
 */
export function renderCatalogResults(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'counts' | 'anonymization'>,
  cache: CatalogResultCache,
  view: ResultsView,
  opts: { limit?: number; search?: string; category?: string; crossing?: string } = {},
): string {
  const limit = opts.limit ?? 50
  const { threshold } = catalog.anonymization
  const m = (n: number | null | undefined) => maskedCount(n, threshold)
  const masks = computeCatalogMasks(catalog, cache, threshold)
  const published = buildPublishedCatalog(catalog, cache, { masks, keepMasked: true })
  const head = `Computed ${cache.computedAt}: ${m(cache.totalPatients)} patients · ${m(cache.totalVisits)} hospital stays · `
    + `${cache.totalConcepts} concepts · ${published.crossings.length} published crossing(s)`
  const concepts = publishedConcepts(catalog, cache, { masks })
  const mc = (c: (typeof concepts)[number], n: number | null | undefined) => (c.status === PUBLISHED ? m(n) : `< ${threshold}`)
  // A masked concept ranks as its masked count, so the order does not place it.
  const rank = (c: (typeof concepts)[number]) => (c.status === PUBLISHED ? c.patientCount : 0)

  if (view === 'summary') {
    const byCategory = new Map<string, number>()
    for (const c of concepts) byCategory.set(c.category ?? '(none)', (byCategory.get(c.category ?? '(none)') ?? 0) + 1)
    const cats = [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k}: ${n}`)
    const top = [...concepts].sort((a, b) => rank(b) - rank(a)).slice(0, 10)
      .map((c) => `  ${c.conceptName} (${c.conceptId}) — ${mc(c, c.patientCount)} patients`)
    const crossings = published.crossings.map((c) => {
      const masked = c.masked.primary + c.masked.secondary
      return `  ${c.id} (${c.vars.join(' × ')}) — ${c.cells.length} cell(s)${masked ? `, ${masked} masked` : ''}`
    })
    return [head, cats.length ? `Concepts by category: ${cats.join(' · ')}` : '', 'Top concepts by patients:', ...top,
      ...(crossings.length ? ['Crossings (read one with view "crossing"):', ...crossings] : [])]
      .filter(Boolean).join('\n')
  }

  if (view === 'concepts') {
    const q = opts.search?.toLowerCase()
    const rows = concepts
      .filter((c) => !opts.category || c.category === opts.category)
      .filter((c) => !q || c.conceptName?.toLowerCase().includes(q) || String(c.conceptId).includes(q))
      .sort((a, b) => rank(b) - rank(a))
    const lines = rows.slice(0, limit).map((c) =>
      `${c.conceptId} · ${c.conceptName}${c.category ? ` · ${c.category}` : ''}${c.subcategory ? ` / ${c.subcategory}` : ''}`
      + ` · patients ${mc(c, c.patientCount)}${c.visitCount != null ? ` · stays ${mc(c, c.visitCount)}` : ''} · records ${mc(c, c.recordCount)}`)
    return [head, `${rows.length} matching concept(s)${rows.length > limit ? `, first ${limit} by patients` : ''}:`, ...lines].join('\n')
  }

  const crossing = published.crossings.find((c) => c.id === opts.crossing)
  if (!crossing) {
    return `${head}\nGive crossing, one of: ${published.crossings.map((c) => c.id).join(', ') || '(none published)'}.`
  }
  const k = crossing.vars.length
  const q = opts.search?.toLowerCase()
  const lines: string[] = []
  let matched = 0
  for (const cell of crossing.cells) {
    const label = crossing.vars.map((id, i) => `${published.variables[id]!.label} ${published.variables[id]!.names[cell[i] as number]}`).join(' × ')
    if (q && !label.toLowerCase().includes(q)) continue
    matched++
    if (lines.length >= limit) continue
    const status = cell[cell.length - 1]
    const counts = status === PRIMARY ? `< ${threshold}` : status === SECONDARY ? 'masked (protects a small cell)'
      : [`patients ${cell[k]}`, ...crossing.measures.map((ms, j) => `${ms} ${cell[k + 1 + j] ?? '—'}`)].join(' · ')
    lines.push(`${label}: ${counts}`)
  }
  return [head, `${crossing.id}: ${matched} cell(s)${matched > limit ? `, first ${limit}` : ''}:`, ...lines].join('\n')
}
