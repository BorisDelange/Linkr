import { CATALOG_VARIABLE_ORDER, type CatalogResultCache, type CatalogVariableId, type DataCatalog, type PeriodGranularity } from '@/types/catalog'
import { OTHER_MODALITY, periodLabel, trimPeriods } from './config'
import { computeCrossingMasks, PUBLISHED, SECONDARY, type CellStatus } from './suppression'

/**
 * The catalog's crossings as they may leave the instance: masked, trimmed and
 * labelled. Every published output (the standalone page, the crossing CSVs)
 * is built from this and nothing else, so no output can carry a count its
 * siblings hide.
 *
 * A masked cell keeps its place (the page draws it as masked) but loses every
 * number: the raw value never reaches the published file, not even hidden.
 */

export type PublishedMeasure = 'patients' | 'stays' | 'records'

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
   * Whether each unit of a measure falls in exactly one modality — a patient
   * has one sex, a stay one start period — so that shares of the sum mean
   * something (a pie chart). A patient seen at 40 and at 41 sits in two age
   * brackets: patients do not partition age.
   */
  partition: Record<PublishedMeasure, boolean>
  granularity?: PeriodGranularity
  /** Concept variable only: whether a modality is a concept or a category of them. */
  level?: 'concept' | 'category' | 'subcategory'
}

/** [modality index per variable…, patients, second measure, status]; numbers are null when masked. */
export type PublishedCell = (number | null)[]

export interface PublishedCrossing {
  id: string
  vars: CatalogVariableId[]
  /** Stays for crossings over visits, records for crossings over events (with the concept variable). */
  second: 'stays' | 'records'
  cells: PublishedCell[]
  masked: { primary: number; secondary: number }
}

export interface PublishedCatalog {
  threshold: number
  variables: Partial<Record<CatalogVariableId, PublishedVariable>>
  crossings: PublishedCrossing[]
}

const SEX_NAMES: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other' }

/** '[18;65[' → '18–64', '[90;+∞[' → '90+', '[0;+∞[' → 'All ages'. */
export function ageDisplayName(label: string): string {
  const m = /^\[(\d+);(\d+|\+∞)\[$/.exec(label)
  if (!m) return label
  if (m[2] === '+∞') return m[1] === '0' ? 'All ages' : `${m[1]}+`
  return `${m[1]}–${Number(m[2]) - 1}`
}

function variableLabel(catalog: Pick<DataCatalog, 'variables'>, id: CatalogVariableId): string {
  const v = catalog.variables
  switch (id) {
    case 'concept': return v.concept?.level === 'category' ? 'Concept category' : v.concept?.level === 'subcategory' ? 'Concept subcategory' : 'Concept'
    case 'period': return 'Period'
    case 'service': return v.service?.level === 'visit' ? 'Visit type' : 'Care unit'
    case 'age': return 'Age group'
    case 'sex': return 'Sex'
  }
}

function modalityName(id: CatalogVariableId, code: string, cache: CatalogResultCache): string {
  if (code === OTHER_MODALITY) return id === 'service' ? 'Other services' : 'Other'
  switch (id) {
    case 'period': return periodLabel(code, 'en')
    case 'age': return ageDisplayName(code)
    case 'sex': return SEX_NAMES[code] ?? code
    case 'concept': return cache.labels?.concept?.[code] ?? code
    default: return code
  }
}

function partitionOf(catalog: Pick<DataCatalog, 'variables'>, id: CatalogVariableId): Record<PublishedMeasure, boolean> {
  switch (id) {
    case 'sex': return { patients: true, stays: true, records: true }
    case 'period':
    case 'age': return { patients: false, stays: true, records: true }
    // A stay crossing several units counts once in each.
    case 'service': return { patients: false, stays: catalog.variables.service?.level === 'visit', records: false }
    case 'concept': return { patients: false, stays: false, records: true }
  }
}

const KIND: Record<CatalogVariableId, PublishedVariable['kind']> = {
  concept: 'concept', period: 'time', service: 'nominal', age: 'ordinal', sex: 'nominal',
}

/**
 * Each variable's modalities in display order, with their names — periods
 * trimmed to those reaching the threshold. Shared by the published outputs and
 * the app's Data tab, so both list the same rows.
 */
export function publishedVariables(
  catalog: Pick<DataCatalog, 'variables' | 'anonymization'>,
  cache: CatalogResultCache,
): PublishedCatalog['variables'] {
  const threshold = catalog.anonymization.threshold
  const crossings = cache.crossings ?? []
  const used = new Set(crossings.flatMap((c) => c.variables))
  const variables: PublishedCatalog['variables'] = {}
  for (const id of CATALOG_VARIABLE_ORDER) {
    if (!used.has(id)) continue
    const marginal = crossings.find((c) => c.id === id)?.rows ?? []
    let mods = cache.modalities?.[id] ?? [...new Set(marginal.map((r) => r.values[0]))]
    // De-identified sources scatter a few patients over decades: drop the
    // periods before the first and after the last that reach the threshold.
    if (id === 'period') mods = trimPeriods(mods, new Map(marginal.map((r) => [r.values[0], r.patients])), threshold)
    const variable: PublishedVariable = {
      id,
      label: variableLabel(catalog, id),
      kind: KIND[id],
      mods,
      names: mods.map((m) => modalityName(id, m, cache)),
      partition: partitionOf(catalog, id),
    }
    if (id === 'period') variable.granularity = catalog.variables.period?.granularity
    if (id === 'concept') variable.level = catalog.variables.concept?.level ?? 'concept'
    if (id === 'concept' && catalog.variables.concept?.level === 'concept' && catalog.variables.concept.categoryColumn) {
      const categoryOf = new Map<string, string | null>()
      const multi = new Set(cache.concepts.map((c) => c.dictionaryKey)).size > 1
      for (const c of cache.concepts) categoryOf.set(multi ? `${c.dictionaryKey}:${c.conceptId}` : String(c.conceptId), c.category ?? null)
      variable.categories = mods.map((m) => categoryOf.get(m) ?? null)
    }
    variables[id] = variable
  }
  return variables
}

/**
 * `reveal` keeps the numbers of masked cells, their status unchanged: for the
 * app's Data tab, which shows what the masks hide. Never for a published output.
 */
export function buildPublishedCatalog(
  catalog: Pick<DataCatalog, 'variables' | 'anonymization'>,
  cache: CatalogResultCache,
  { reveal = false }: { reveal?: boolean } = {},
): PublishedCatalog {
  const threshold = catalog.anonymization.threshold
  const crossings = cache.crossings ?? []
  const masks = computeCrossingMasks(crossings, threshold)
  const variables = publishedVariables(catalog, cache)
  const index = new Map<CatalogVariableId, Map<string, number>>()
  for (const v of Object.values(variables)) index.set(v.id, new Map(v.mods.map((m, i) => [m, i])))

  const published: PublishedCrossing[] = []
  for (const crossing of crossings) {
    const mask = masks.get(crossing.id)
    const second = crossing.variables.includes('concept') ? 'records' : 'stays'
    const cells: PublishedCell[] = []
    let primary = 0
    let secondary = 0
    crossing.rows.forEach((row, r) => {
      const idx = crossing.variables.map((v, i) => index.get(v)?.get(row.values[i]))
      if (idx.some((i) => i == null)) return
      const status = (mask?.status[r] ?? PUBLISHED) as CellStatus
      if (status === PUBLISHED || reveal) {
        if (status === SECONDARY) secondary++
        else if (status !== PUBLISHED) primary++
        cells.push([...(idx as number[]), row.patients, (second === 'records' ? row.records : row.stays) ?? null, status])
      } else {
        if (status === SECONDARY) secondary++
        else primary++
        cells.push([...(idx as number[]), null, null, status])
      }
    })
    const n = crossing.variables.length
    cells.sort((x, y) => {
      for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
      return 0
    })
    published.push({ id: crossing.id, vars: crossing.variables, second, cells, masked: { primary, secondary } })
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
 * their name), the patients and stays/records, and the cell's status. A
 * masked cell has empty counts — a number column holds numbers only, and the
 * status says why one is missing.
 */
export function buildCrossingCsv(pub: PublishedCatalog, crossing: PublishedCrossing): string {
  const withConceptName = crossing.vars.includes('concept') && pub.variables.concept?.kind === 'concept'
    && pub.variables.concept.names.some((n, i) => n !== pub.variables.concept!.mods[i])
  const header = [
    ...crossing.vars.flatMap((v) => (v === 'concept' && withConceptName ? ['concept', 'concept_name'] : [v])),
    'patients', crossing.second, 'status',
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
    lines.push([...values, cell[n], cell[n + 1], STATUS_CSV[cell[n + 2] as CellStatus]].map(csvField).join(','))
  }
  return `${lines.join('\n')}\n`
}
