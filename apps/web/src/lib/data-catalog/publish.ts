import {
  CATALOG_VARIABLE_ORDER,
  type AnonymizationConfig,
  type AnonymizationImpact,
  type CatalogConceptRow,
  type CatalogCrossingResult,
  type CatalogCrossingRow,
  type CatalogMeasure,
  type CatalogResultCache,
  type CatalogVariableId,
  type DataCatalog,
  type PeriodGranularity,
} from '@/types/catalog'
import { catalogCounts, OTHER_MODALITY, periodLabel, shownCrossingIds, trimPeriods } from './config'
import { fallbackKey, perturbed } from './perturbation'
import { computeAnonymizationImpact, computeCrossingMasks, CONCEPT_MEMBER, PRIMARY, PUBLISHED, SECONDARY, type CellStatus, type CrossingMask, type MaskTable } from './suppression'
import type { PageLocale } from '@/lib/dcat-ap/page-text'

/**
 * The catalog's crossings as they may leave the instance: masked, trimmed and
 * labelled. Every published output (the standalone page, the crossing CSVs)
 * is built from this and nothing else, so no output can carry a count its
 * siblings hide.
 *
 * A masked cell is left out, exactly like an empty one: keeping it, even
 * without its numbers, would tell "at least one patient" from "none". The page
 * reads every absent cell as masked.
 */

export type PublishedMeasure = CatalogMeasure

/** The measures a crossing's cells carry after patients: the counted stays, then records over events. */
export function crossingMeasures(catalog: Pick<DataCatalog, 'counts'>, vars: readonly CatalogVariableId[]): Exclude<PublishedMeasure, 'patients'>[] {
  const counts = catalogCounts(catalog)
  return [
    ...(counts.visits ? ['stays' as const] : []),
    ...(counts.unitStays ? ['unit_stays' as const] : []),
    ...(vars.includes('concept') ? ['records' as const] : []),
  ]
}

const ROW_KEY = { stays: 'stays', unit_stays: 'unitStays', records: 'records' } as const

/**
 * The measures a computed crossing actually carries: a crossing over events
 * computed before they counted stays has none, which then reads "not counted"
 * rather than an empty column.
 */
export function computedMeasures(catalog: Pick<DataCatalog, 'counts'>, crossing: Pick<CatalogCrossingResult, 'variables' | 'rows'>): Exclude<PublishedMeasure, 'patients'>[] {
  const first = crossing.rows[0]
  return crossingMeasures(catalog, crossing.variables).filter((m) => !first || first[ROW_KEY[m]] != null)
}

export interface PublishedVariable {
  id: CatalogVariableId
  label: string
  /** How the page lays it out: a time axis, an ordered axis, categories, or concepts. */
  kind: 'time' | 'ordinal' | 'nominal' | 'concept'
  /** Modality codes in display order, as the cells index them. */
  mods: string[]
  /** Display name of each modality, same index. */
  names: string[]
  /** Concept variable at concept level: each concept's category, for the page's category filter. */
  categories?: (string | null)[]
  /**
   * Concept variable: its crossings count every concept (all of them, at
   * concept level), so a sum of their records over concepts misses only the
   * masked cells.
   */
  everyConcept?: boolean
  /**
   * Whether each unit of a measure falls in exactly one modality — a patient
   * has one sex, a stay one start period — so that shares of the sum mean
   * something (a pie chart). A patient seen at 40 and at 41 sits in two age
   * brackets: patients do not partition age. Stays as crossings over visits
   * count them; over events only sex splits them (the page's `adds`).
   */
  partition: Record<PublishedMeasure, boolean>
  granularity?: PeriodGranularity
  /** Period only: granularity units per period. */
  step?: number
  /** Concept variable only: whether a modality is a concept or a category of them. */
  level?: 'concept' | 'category' | 'subcategory'
}

/** [modality index per variable…, patients, each of the crossing's measures…, status]; numbers are null when masked. */
export type PublishedCell = (number | null)[]

export interface PublishedCrossing {
  id: string
  vars: CatalogVariableId[]
  /** What the cells count after patients, in cell order (`crossingMeasures`). */
  measures: Exclude<PublishedMeasure, 'patients'>[]
  cells: PublishedCell[]
  masked: { primary: number; secondary: number }
}

export interface PublishedCatalog {
  threshold: number
  variables: Partial<Record<CatalogVariableId, PublishedVariable>>
  crossings: PublishedCrossing[]
}

const LABELS = {
  en: {
    concept: 'Concept', concept_category: 'Concept category', concept_subcategory: 'Concept subcategory', period: 'Period',
    visit_type: 'Visit type', care_unit: 'Care unit', age: 'Age group', sex: 'Gender',
    male: 'Male', female: 'Female', other: 'Other', all_ages: 'All ages', other_services: 'Other services',
  },
  fr: {
    concept: 'Concept', concept_category: 'Catégorie de concept', concept_subcategory: 'Sous-catégorie de concept', period: 'Période',
    visit_type: 'Type de visite', care_unit: 'Unité de soins', age: "Tranche d'âge", sex: 'Genre',
    male: 'Homme', female: 'Femme', other: 'Autre', all_ages: 'Tous âges', other_services: 'Autres services',
  },
} satisfies Record<PageLocale, Record<string, string>>

/** '[18;65[' → '18–64', '[90;+∞[' → '90+', '[0;+∞[' → 'All ages'. */
export function ageDisplayName(label: string, locale: PageLocale = 'en'): string {
  const m = /^\[(\d+);(\d+|\+∞)\[$/.exec(label)
  if (!m) return label
  if (m[2] === '+∞') return m[1] === '0' ? LABELS[locale].all_ages : `${m[1]}+`
  return `${m[1]}–${Number(m[2]) - 1}`
}

function variableLabel(catalog: Pick<DataCatalog, 'variables'>, id: CatalogVariableId, locale: PageLocale): string {
  const v = catalog.variables
  const L = LABELS[locale]
  switch (id) {
    case 'concept': return v.concept?.level === 'category' ? L.concept_category : v.concept?.level === 'subcategory' ? L.concept_subcategory : L.concept
    case 'period': return L.period
    case 'service': return v.service?.level === 'visit' ? L.visit_type : L.care_unit
    case 'age': return L.age
    case 'sex': return L.sex
  }
}

function modalityName(catalog: Pick<DataCatalog, 'variables'>, id: CatalogVariableId, code: string, cache: CatalogResultCache, locale: PageLocale): string {
  const L = LABELS[locale]
  if (code === OTHER_MODALITY) return id === 'service' ? L.other_services : L.other
  switch (id) {
    case 'period': return periodLabel(code, locale, catalog.variables.period?.step ?? 1)
    case 'age': return ageDisplayName(code, locale)
    case 'sex': return code === 'male' || code === 'female' || code === 'other' ? L[code] : code
    case 'concept': return cache.labels?.concept?.[code] ?? code
    default: return code
  }
}

function partitionOf(catalog: Pick<DataCatalog, 'variables'>, id: CatalogVariableId): Record<PublishedMeasure, boolean> {
  switch (id) {
    case 'sex': return { patients: true, stays: true, unit_stays: true, records: true }
    // A unit stay is counted with its visit, at the visit's start.
    case 'period':
    case 'age': return { patients: false, stays: true, unit_stays: true, records: true }
    // A stay crossing several units counts once in each.
    case 'service': return { patients: false, stays: catalog.variables.service?.level === 'visit', unit_stays: true, records: false }
    case 'concept': return { patients: false, stays: false, unit_stays: false, records: true }
  }
}

const KIND: Record<CatalogVariableId, PublishedVariable['kind']> = {
  concept: 'concept', period: 'time', service: 'nominal', age: 'ordinal', sex: 'nominal',
}

/**
 * The computed crossings the publication shows. A marginal left out is not
 * published, so it is no total a masked cell could be recovered from: the
 * masks are worked out over these crossings only.
 */
export function publishedCrossingResults(catalog: Pick<DataCatalog, 'variables' | 'crossings'>, cache: Pick<CatalogResultCache, 'crossings'>): CatalogResultCache['crossings'] {
  const shown = shownCrossingIds(catalog)
  const all = cache.crossings ?? []
  return shown ? all.filter((c) => shown.has(c.id)) : all
}

/**
 * The concept modality of a concept-list row, as the crossings code it: the
 * concept id, prefixed with its dictionary key when there are several.
 */
export function conceptModalityKey(cache: Pick<CatalogResultCache, 'concepts' | 'labels'>): (row: Pick<CatalogConceptRow, 'dictionaryKey' | 'conceptId'>) => string {
  const dictKeys = new Set(cache.concepts.map((c) => c.dictionaryKey ?? ''))
  // The run prefixes whenever the mapping has several dictionaries, even if the
  // concepts came from one: the crossings' own labels say which it did.
  const prefixed = dictKeys.size > 1 || Object.keys(cache.labels?.concept ?? {}).some((k) => {
    const at = k.indexOf(':')
    return at >= 0 && dictKeys.has(k.slice(0, at))
  })
  return prefixed ? (c) => `${c.dictionaryKey ?? ''}:${c.conceptId}` : (c) => String(c.conceptId)
}

export interface CatalogMasks {
  /** The published crossings (`publishedCrossingResults`). */
  crossings: CatalogCrossingResult[]
  /** One mask per published crossing, its status array aligned with the crossing's rows. */
  masks: Map<string, CrossingMask>
  /** One status per row of `cache.concepts`, same index. */
  concepts: Uint8Array
  /** The status of each modality of the concept variable, by code. */
  conceptModalities: Map<string, CellStatus>
}

const CONCEPT_LIST = 'concept-list'
/** A concept without a category: counted in no category's cell, so in no group. */
const NO_CATEGORY = '\u0000'

function maskOfRows(rows: readonly CatalogCrossingRow[], statusOf: (row: CatalogCrossingRow) => CellStatus): CrossingMask {
  const status = new Uint8Array(rows.length)
  let primary = 0
  let secondary = 0
  let patientMass = 0
  let publishedMass = 0
  rows.forEach((row, i) => {
    const s = statusOf(row)
    status[i] = s
    patientMass += row.patients
    if (s === PRIMARY) primary++
    else if (s === SECONDARY) secondary++
    else publishedMass += row.patients
  })
  return { status, cells: rows.length, primary, secondary, patientMass, publishedMass }
}

/**
 * The category margin of the concept list (`[category, concept]` rows), summed
 * from the list: exact on records, an upper bound on distinct patients. A
 * concept with no category is in no category's cell, so in no total.
 */
function categoryTotals(rows: readonly CatalogCrossingRow[]): MaskTable {
  const byCategory = new Map<string, CatalogCrossingRow>()
  for (const r of rows) {
    const category = r.values[0]
    if (category === NO_CATEGORY) continue
    const total = byCategory.get(category)
    if (total) {
      byCategory.set(category, { ...total, patients: total.patients + r.patients, records: (total.records ?? 0) + (r.records ?? 0) })
    } else {
      byCategory.set(category, { values: [category], patients: r.patients, records: r.records ?? 0 })
    }
  }
  return { id: 'concept', variables: ['concept'], rows: [...byCategory.values()] }
}

/**
 * The masks of everything a catalog publishes: its crossings and its concept
 * list, worked out together.
 *
 * The concept list is the concept variable's 1-way margin: one row per concept
 * with its distinct patients over the same events the crossings count (the
 * standard and the source concept of each event row). Published whether the
 * 1-way crossing is chosen or not, it is a total every concept × … group adds
 * up to — so it takes part in the suppression as the `concept` margin, merged
 * with the 1-way crossing when that one is published too (a concept counted
 * lower in either is masked on that count). A concept masked there is masked
 * in the list, secondary cells included.
 *
 * With the concept variable at category level the crossings count categories,
 * and the list gives each category's concepts: records add up across them to
 * the category's cell. The list then takes part as the `concept ×
 * CONCEPT_MEMBER` crossing, grouped by category under the computed 1-way
 * crossing — published or not, a category total can be recovered from its
 * other crossings — or, never computed, under the list's own category sums.
 */
export function computeCatalogMasks(
  catalog: Pick<DataCatalog, 'variables' | 'crossings'>,
  cache: Pick<CatalogResultCache, 'concepts' | 'crossings' | 'labels'>,
  threshold: number,
): CatalogMasks {
  const crossings = publishedCrossingResults(catalog, cache)
  const keyOf = conceptModalityKey(cache)
  const listRows: CatalogCrossingRow[] = cache.concepts.map((c) => ({ values: [keyOf(c)], patients: c.patientCount, records: c.recordCount }))
  const level = catalog.variables.concept?.level ?? 'concept'
  const tied = level === 'concept' || !crossings.some((c) => c.variables.includes('concept'))
  const oneWay = crossings.find((c) => c.id === 'concept')
  const computedOneWay = oneWay ?? cache.crossings?.find((c) => c.id === 'concept')

  let masks: Map<string, CrossingMask>
  let margin: MaskTable
  let marginMask: CrossingMask
  if (tied) {
    const byKey = new Map<string, CatalogCrossingRow>()
    for (const r of [...listRows, ...(oneWay?.rows ?? [])]) {
      const prev = byKey.get(r.values[0])
      if (!prev || r.patients < prev.patients) byKey.set(r.values[0], r)
    }
    margin = { id: 'concept', variables: ['concept'], rows: [...byKey.values()] }
    masks = computeCrossingMasks([...crossings.filter((c) => c.id !== 'concept'), margin], threshold)
    marginMask = masks.get('concept')!
    masks.delete('concept')
  } else {
    const categoryOf = (c: CatalogConceptRow) => (level === 'subcategory' ? c.subcategory : c.category) ?? NO_CATEGORY
    margin = {
      id: CONCEPT_LIST,
      variables: ['concept', CONCEPT_MEMBER],
      rows: listRows.map((r, i) => ({ ...r, values: [categoryOf(cache.concepts[i]), r.values[0]] })),
    }
    masks = computeCrossingMasks(crossings, threshold)
    // The category totals the list's groups add up to. Without the computed
    // 1-way crossing they come from the list itself: records add up exactly
    // across a category's concepts, so its total is known either way — masking
    // the list with no total to protect left a concept recoverable by subtraction.
    const totals = computedOneWay ?? categoryTotals(margin.rows)
    marginMask = computeCrossingMasks([totals, margin], threshold).get(CONCEPT_LIST)!
  }
  const marginStatus = new Map(margin.rows.map((r, i) => [r.values[r.values.length - 1], marginMask.status[i] as CellStatus]))
  const concepts = Uint8Array.from(listRows, (r) => marginStatus.get(r.values[0]) ?? PUBLISHED)

  let conceptModalities = marginStatus
  if (tied && oneWay) {
    masks.set('concept', maskOfRows(oneWay.rows, (r) => marginStatus.get(r.values[0]) ?? PUBLISHED))
  } else if (!tied) {
    const oneWayMask = oneWay ? masks.get('concept') : undefined
    const rows = computedOneWay?.rows ?? []
    conceptModalities = new Map(rows.map((r, i) => [r.values[0], (oneWayMask ? oneWayMask.status[i] : r.patients < threshold ? PRIMARY : PUBLISHED) as CellStatus]))
  }
  return { crossings, masks, concepts, conceptModalities }
}

/** What `settings` mask over a computed catalog, crossings and concept list alike. */
export function catalogAnonymizationImpact(
  catalog: Pick<DataCatalog, 'variables' | 'crossings'>,
  cache: Pick<CatalogResultCache, 'concepts' | 'crossings' | 'labels'>,
  settings: AnonymizationConfig,
): AnonymizationImpact {
  const { crossings, masks, concepts } = computeCatalogMasks(catalog, cache, settings.threshold)
  return computeAnonymizationImpact({ crossings, masks, conceptStatus: concepts }, settings)
}

/**
 * Finished results with the masks of the catalog's current settings worked
 * out, so the Anonymization tab shows them without a Run of its own — whoever
 * computed the catalog (the app, or the MCP server).
 */
export function withAnonymizationImpact(catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'anonymization'>, cache: CatalogResultCache): CatalogResultCache {
  return { ...cache, anonymizationImpact: catalogAnonymizationImpact(catalog, cache, catalog.anonymization) }
}

export type PublishedConcept = CatalogConceptRow & { status: CellStatus }

/** The warehouse's totals as published: perturbed like any cell. */
export function publishedTotals(
  catalog: Pick<DataCatalog, 'anonymization' | 'counts'>,
  cache: Pick<CatalogResultCache, 'grandTotal' | 'totalPatients' | 'totalVisits'>,
): { patients: number; stays?: number; unitStays?: number; records: number } {
  const { threshold, noise = 0 } = catalog.anonymization
  const counts = catalogCounts(catalog)
  const key = noise ? cache.grandTotal.totalKey ?? fallbackKey('total') : 0
  const at = (v: number, m: CatalogMeasure) => perturbed(v, key, m, noise, threshold)
  return {
    patients: at(cache.totalPatients, 'patients'),
    ...(counts.visits ? { stays: at(cache.totalVisits, 'stays') } : {}),
    ...(counts.unitStays && cache.grandTotal.totalUnitStays != null ? { unitStays: at(cache.grandTotal.totalUnitStays, 'unit_stays') } : {}),
    records: at(cache.grandTotal.totalRecords, 'records'),
  }
}

/**
 * The concept list as it may leave the instance, each row with its status: in
 * suppress mode without the masked rows. Counts stay raw — how a masked one is
 * written (capped, emptied) is each output's business. `reveal` keeps every row.
 */
export function publishedConcepts(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'anonymization'>,
  cache: Pick<CatalogResultCache, 'concepts' | 'crossings' | 'labels'>,
  { reveal = false, masks }: { reveal?: boolean; masks?: CatalogMasks } = {},
): PublishedConcept[] {
  const { threshold, noise = 0 } = catalog.anonymization
  const status = (masks ?? computeCatalogMasks(catalog, cache, threshold)).concepts
  const modalityOf = conceptModalityKey(cache)
  const rows = cache.concepts.map((c, i) => {
    const row: PublishedConcept = { ...c, status: status[i] as CellStatus }
    if (!noise) return row
    // The concept's key is its 1-way cell's: the list and that crossing agree.
    const key = c.patientKey ?? fallbackKey('concept', modalityOf(c))
    row.patientCount = perturbed(c.patientCount, key, 'patients', noise, threshold)
    row.recordCount = perturbed(c.recordCount, key, 'records', noise, threshold)
    if (c.visitCount != null) row.visitCount = perturbed(c.visitCount, key, 'stays', noise, threshold)
    return row
  })
  return reveal || catalog.anonymization.mode !== 'suppress' ? rows : rows.filter((r) => r.status === PUBLISHED)
}

/**
 * The order in which a ranked variable (services, concepts) is published: by
 * each modality's published patients, a masked one counted as the threshold,
 * ties by code, "Other" last. The exact-count order of the results would place
 * a masked modality among its published neighbours — and so bracket its count.
 */
function publishedRank(
  mods: readonly string[],
  marginal: CatalogCrossingResult | undefined,
  statusOf: (code: string, row: CatalogCrossingRow, index: number) => CellStatus,
  { threshold, noise = 0 }: Pick<AnonymizationConfig, 'threshold' | 'noise'>,
): string[] {
  const value = new Map<string, number>()
  marginal?.rows.forEach((row, i) => {
    const code = row.values[0]
    const key = noise ? row.key ?? fallbackKey(marginal.id, code) : 0
    value.set(code, statusOf(code, row, i) === PUBLISHED ? perturbed(row.patients, key, 'patients', noise, threshold) : threshold)
  })
  const at = (m: string) => value.get(m) ?? threshold
  return [...mods].sort((a, b) => Number(a === OTHER_MODALITY) - Number(b === OTHER_MODALITY) || at(b) - at(a) || (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Each variable's modalities in display order, with their names — periods
 * trimmed to those reaching the threshold, services and concepts ranked on
 * their published counts (`publishedRank`). In suppress mode, the concepts (or
 * categories) masked in the concept margin are left out: their names are what
 * that mode withholds — unless `reveal`, for the app's preview.
 */
export function publishedVariables(
  catalog: Pick<DataCatalog, 'variables' | 'anonymization' | 'crossings'>,
  cache: CatalogResultCache,
  locale: PageLocale = 'en',
  { masks = computeCatalogMasks(catalog, cache, catalog.anonymization.threshold), reveal = false }: { masks?: CatalogMasks; reveal?: boolean } = {},
): PublishedCatalog['variables'] {
  const threshold = catalog.anonymization.threshold
  const crossings = cache.crossings ?? []
  const used = new Set(masks.crossings.flatMap((c) => c.variables))
  const primaryRule = (_code: string, row: CatalogCrossingRow): CellStatus => (row.patients < threshold ? PRIMARY : PUBLISHED)
  const variables: PublishedCatalog['variables'] = {}
  for (const id of CATALOG_VARIABLE_ORDER) {
    if (!used.has(id)) continue
    const oneWay = crossings.find((c) => c.id === id)
    const marginal = oneWay?.rows ?? []
    let mods = cache.modalities?.[id] ?? [...new Set(marginal.map((r) => r.values[0]))]
    // De-identified sources scatter a few patients over decades: drop the
    // periods before the first and after the last that reach the threshold.
    if (id === 'period') mods = trimPeriods(mods, new Map(marginal.map((r) => [r.values[0], r.patients])), threshold)
    if (id === 'service') {
      // Unpublished, the 1-way crossing's counts must not order anything: the
      // order would give them away. The services then rank by code.
      const mask = masks.masks.get('service')
      mods = publishedRank(mods, mask ? oneWay : undefined, (_code, _row, i) => mask!.status[i] as CellStatus, catalog.anonymization)
    }
    if (id === 'concept') {
      // At category level nothing else publishes a category's patients: with
      // its 1-way crossing unpublished, the categories rank by code, as services do.
      const byCategory = (catalog.variables.concept?.level ?? 'concept') !== 'concept'
      const ranked = byCategory && !masks.masks.has('concept') ? undefined : oneWay
      mods = publishedRank(mods, ranked, (code, row) => masks.conceptModalities.get(code) ?? primaryRule(code, row), catalog.anonymization)
      if (!reveal && catalog.anonymization.mode === 'suppress') {
        mods = mods.filter((m) => (masks.conceptModalities.get(m) ?? PUBLISHED) === PUBLISHED)
      }
    }
    const variable: PublishedVariable = {
      id,
      label: variableLabel(catalog, id, locale),
      kind: KIND[id],
      mods,
      names: mods.map((m) => modalityName(catalog, id, m, cache, locale)),
      partition: partitionOf(catalog, id),
    }
    if (id === 'period') {
      variable.granularity = catalog.variables.period?.granularity
      variable.step = catalog.variables.period?.step ?? 1
    }
    if (id === 'concept') {
      variable.level = catalog.variables.concept?.level ?? 'concept'
      variable.everyConcept = variable.level === 'concept' && catalog.variables.concept?.scope === 'all'
    }
    if (id === 'concept' && catalog.variables.concept?.level === 'concept' && catalog.variables.concept.categoryColumn) {
      const categoryOf = new Map<string, string | null>()
      const keyOf = conceptModalityKey(cache)
      for (const c of cache.concepts) categoryOf.set(keyOf(c), c.category ?? null)
      variable.categories = mods.map((m) => categoryOf.get(m) ?? null)
    }
    variables[id] = variable
  }
  return variables
}

/**
 * `reveal` keeps the masked cells with their numbers, their status unchanged:
 * for the app's preview, which can show what the masks hide. `keepMasked` keeps
 * them without their numbers, for the app's agent, which says which cells are
 * masked. Neither for a published output. `locale` is the language of the
 * labels (variables, modalities).
 */
export function buildPublishedCatalog(
  catalog: Pick<DataCatalog, 'variables' | 'anonymization' | 'counts' | 'crossings'>,
  cache: CatalogResultCache,
  { reveal = false, keepMasked = false, locale = 'en', masks: catalogMasks }: { reveal?: boolean; keepMasked?: boolean; locale?: PageLocale; masks?: CatalogMasks } = {},
): PublishedCatalog {
  const threshold = catalog.anonymization.threshold
  const noise = catalog.anonymization.noise ?? 0
  const all = catalogMasks ?? computeCatalogMasks(catalog, cache, threshold)
  const { crossings, masks } = all
  const variables = publishedVariables(catalog, cache, locale, { masks: all, reveal })
  const index = new Map<CatalogVariableId, Map<string, number>>()
  for (const v of Object.values(variables)) index.set(v.id, new Map(v.mods.map((m, i) => [m, i])))

  const published: PublishedCrossing[] = []
  for (const crossing of crossings) {
    const mask = masks.get(crossing.id)
    const measures = computedMeasures(catalog, crossing)
    const cells: PublishedCell[] = []
    let primary = 0
    let secondary = 0
    // Millions of rows on a large warehouse: one array per cell and nothing else.
    const lookups = crossing.variables.map((v) => index.get(v))
    const keys = measures.map((m) => ROW_KEY[m])
    const k = lookups.length
    rows: for (let r = 0; r < crossing.rows.length; r++) {
      const row = crossing.rows[r]
      const status = (mask?.status[r] ?? PUBLISHED) as CellStatus
      const shown = status === PUBLISHED || reveal
      const cell: PublishedCell = new Array(k + 2 + keys.length)
      for (let i = 0; i < k; i++) {
        const at = lookups[i]?.get(row.values[i])
        if (at == null) continue rows
        cell[i] = at
      }
      if (status === SECONDARY) secondary++
      else if (status !== PUBLISHED) primary++
      if (!shown && !keepMasked) continue
      const key = noise ? row.key ?? fallbackKey(crossing.id, ...row.values) : 0
      cell[k] = shown ? perturbed(row.patients, key, 'patients', noise, threshold) : null
      for (let m = 0; m < keys.length; m++) {
        const v = row[keys[m]]
        cell[k + 1 + m] = shown && v != null ? perturbed(v, key, measures[m], noise, threshold) : null
      }
      cell[k + 1 + keys.length] = status
      cells.push(cell)
    }
    const n = crossing.variables.length
    cells.sort((x, y) => {
      for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
      return 0
    })
    published.push({ id: crossing.id, vars: crossing.variables, measures, cells, masked: { primary, secondary } })
  }
  return { threshold, variables, crossings: published }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvField(value: string | number | null | undefined): string {
  if (value == null) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

const STATUS_CSV: Record<CellStatus, string> = { 0: 'published', 1: 'suppressed', 2: 'suppressed_secondary' }

/** Path of a crossing's CSV inside the published files. */
export const crossingCsvPath = (id: string) => `crossings/${id}.csv`

/**
 * One crossing as CSV: a column per variable (its code; concepts also get
 * their name), the patients and the crossing's measures, and the cell's status. A
 * masked cell has empty counts — a number column holds numbers only, and the
 * status says why one is missing.
 */
export function buildCrossingCsv(pub: PublishedCatalog, crossing: PublishedCrossing): string {
  const withConceptName = crossing.vars.includes('concept') && pub.variables.concept?.kind === 'concept'
    && pub.variables.concept.names.some((n, i) => n !== pub.variables.concept!.mods[i])
  const header = [
    ...crossing.vars.flatMap((v) => (v === 'concept' && withConceptName ? ['concept', 'concept_name'] : [v])),
    'patients', ...crossing.measures, 'status',
  ]
  const lines = [header.join(',')]
  const n = crossing.vars.length
  for (const cell of crossing.cells) {
    const values = crossing.vars.flatMap((v, i) => {
      const variable = pub.variables[v]!
      const code = variable.mods[cell[i] as number]
      const shown = code === OTHER_MODALITY ? 'Other' : code
      return v === 'concept' && withConceptName ? [shown, variable.names[cell[i] as number]] : [shown]
    })
    lines.push([...values, ...cell.slice(n, -1), STATUS_CSV[cell[cell.length - 1] as CellStatus]].map(csvField).join(','))
  }
  return `${lines.join('\n')}\n`
}
