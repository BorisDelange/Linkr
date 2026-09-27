import {
  CATALOG_VARIABLE_ORDER,
  DEFAULT_CATALOG_COUNTS,
  type CatalogCounts,
  type CatalogVariableId,
  type CatalogVariables,
  type ConceptVariableConfig,
  type DataCatalog,
  type PeriodGranularity,
  type ServiceVariableConfig,
} from '@/types/catalog'

/** Modality of the cells a grouping folds together ("Other" services). */
export const OTHER_MODALITY = '__other__'

/** What the catalog counts beside patients, defaults filled in. */
export function catalogCounts(catalog: Pick<DataCatalog, 'counts'>): CatalogCounts {
  return { ...DEFAULT_CATALOG_COUNTS, ...catalog.counts }
}

export const SEX_MODALITIES = ['male', 'female', 'other'] as const

export const DEFAULT_AGE_BRACKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90]

export const DEFAULT_SERVICE_CONFIG: ServiceVariableConfig = {
  enabled: false,
  level: 'visit_detail',
  grouping: 'all',
  topN: 10,
  groups: {},
  unassigned: 'other',
}

export const DEFAULT_CONCEPT_CONFIG: ConceptVariableConfig = {
  enabled: false,
  level: 'concept',
  scope: 'all',
  topN: 100,
}

export function defaultCatalogVariables(): CatalogVariables {
  return {
    concept: { ...DEFAULT_CONCEPT_CONFIG },
    period: { enabled: true, granularity: 'year' },
    service: { ...DEFAULT_SERVICE_CONFIG, groups: {} },
    age: { enabled: true, brackets: [...DEFAULT_AGE_BRACKETS] },
    sex: { enabled: true },
  }
}

export function defaultCatalogCrossings(): CatalogVariableId[][] {
  return [['period'], ['age'], ['period', 'age'], ['period', 'sex'], ['age', 'sex']]
}

// ---------------------------------------------------------------------------
// Crossing identity
// ---------------------------------------------------------------------------

/** The variables in canonical order, without duplicates. */
export function canonicalCrossing(vars: readonly CatalogVariableId[]): CatalogVariableId[] {
  const set = new Set(vars)
  return CATALOG_VARIABLE_ORDER.filter((v) => set.has(v))
}

export function crossingId(vars: readonly CatalogVariableId[]): string {
  return canonicalCrossing(vars).join('-')
}

export function isVariableEnabled(variables: CatalogVariables, id: CatalogVariableId): boolean {
  return !!variables[id]?.enabled
}

export function enabledVariables(variables: CatalogVariables): CatalogVariableId[] {
  return CATALOG_VARIABLE_ORDER.filter((v) => isVariableEnabled(variables, v))
}

/**
 * The ids of the crossings a publication shows: the chosen ones whose
 * variables are all enabled, single variables included only when chosen. A
 * variable can be worth reading crossed (age × gender) and not alone (gender).
 * Without a crossings list at all, every computed one.
 */
export function shownCrossingIds(catalog: Pick<DataCatalog, 'variables' | 'crossings'>): Set<string> | null {
  if (!catalog.crossings) return null
  const enabled = new Set(enabledVariables(catalog.variables))
  return new Set(catalog.crossings.map(canonicalCrossing).filter((c) => c.length && c.every((v) => enabled.has(v))).map((c) => c.join('-')))
}

/**
 * Every crossing a run computes: the 1-way marginal of each enabled variable
 * (shown or not: it orders the modalities and ranks the concepts and services),
 * then the chosen crossings whose variables are all enabled — smallest first,
 * because a crossing's margins must be final before its own cells are
 * suppressed (see `suppression.ts`).
 */
export function effectiveCrossings(catalog: Pick<DataCatalog, 'variables' | 'crossings'>): CatalogVariableId[][] {
  const enabled = new Set(enabledVariables(catalog.variables))
  const seen = new Set<string>()
  const out: CatalogVariableId[][] = []
  const push = (vars: CatalogVariableId[]) => {
    const canon = canonicalCrossing(vars)
    if (canon.length === 0 || canon.length > 3 || canon.some((v) => !enabled.has(v))) return
    const id = canon.join('-')
    if (seen.has(id)) return
    seen.add(id)
    out.push(canon)
  }
  for (const v of enabled) push([v])
  for (const c of catalog.crossings ?? []) push(c)
  return out.sort((a, b) => a.length - b.length)
}

/**
 * A stable key for the parameters a crossing's cells depend on, so a yield
 * estimate survives a change to a variable it does not use.
 */
export function crossingParamsKey(variables: CatalogVariables, vars: readonly CatalogVariableId[]): string {
  const parts = canonicalCrossing(vars).map((v) => {
    const cfg = variables[v]
    if (!cfg) return v
    const { enabled: _enabled, ...params } = cfg as unknown as Record<string, unknown>
    return `${v}:${stableStringify(params)}`
  })
  return parts.join('|')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Modalities
// ---------------------------------------------------------------------------

/** Bracket labels in order, e.g. [18, 65] → '[0;18[', '[18;65[', '[65;+∞['. No boundary is one bracket. */
export function ageBucketLabels(brackets: readonly number[]): string[] {
  const sorted = [...new Set(brackets)].filter((b) => b > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return ['[0;+∞[']
  const labels = [`[0;${sorted[0]}[`]
  for (let i = 0; i < sorted.length; i++) {
    labels.push(i < sorted.length - 1 ? `[${sorted[i]};${sorted[i + 1]}[` : `[${sorted[i]};+∞[`)
  }
  return labels
}

/**
 * Period modalities as the SQL writes them: '2024-03' (month), '2024-Q1'
 * (quarter), '2024' (year). Lexicographic order is chronological for all three.
 */
export function periodRange(first: string, last: string, granularity: PeriodGranularity, step = 1): string[] {
  const parse = (v: string): number | null => {
    const y = parseInt(v.slice(0, 4), 10)
    if (isNaN(y)) return null
    if (granularity === 'year') return y
    if (granularity === 'quarter') {
      const q = parseInt(v.slice(6), 10)
      return isNaN(q) ? null : y * 4 + (q - 1)
    }
    const m = parseInt(v.slice(5, 7), 10)
    return isNaN(m) ? null : y * 12 + (m - 1)
  }
  const format = (n: number): string => {
    if (granularity === 'year') return String(n)
    if (granularity === 'quarter') return `${Math.floor(n / 4)}-Q${(n % 4) + 1}`
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
  }
  const a = parse(first)
  const b = parse(last)
  if (a == null || b == null || b < a) return []
  const out: string[] = []
  for (let n = a; n <= b; n += Math.max(1, Math.floor(step))) out.push(format(n))
  return out
}

/** The last unit of a period that starts at `value` and spans `step` units. */
function periodEnd(value: string, step: number): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(value)
  if (quarter) {
    const n = Number(quarter[1]) * 4 + Number(quarter[2]) - 1 + step - 1
    return `${Math.floor(n / 4)}-Q${(n % 4) + 1}`
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value)
  if (month) {
    const n = Number(month[1]) * 12 + Number(month[2]) - 1 + step - 1
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
  }
  return String(Number(value) + step - 1)
}

/** 'Mar 2024', 'Q1 2024' or '2024'; with a step, the span: '2024–2025', 'Jan 2024 – Jun 2024'. */
export function periodLabel(value: string, locale = 'en', step = 1): string {
  const one = (v: string) => {
    const quarter = /^(\d{4})-Q([1-4])$/.exec(v)
    if (quarter) return `Q${quarter[2]} ${quarter[1]}`
    const month = /^(\d{4})-(\d{2})$/.exec(v)
    if (month) {
      const d = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1))
      return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', timeZone: 'UTC' })
    }
    return v
  }
  if (step <= 1) return one(value)
  const end = periodEnd(value, step)
  return /^\d{4}$/.test(value) ? `${value}–${end}` : `${one(value)} – ${one(end)}`
}

/**
 * The period modalities between the first and the last period whose 1-way
 * total reaches the threshold.
 *
 * De-identified sources shift dates per patient (MIMIC spreads a decade over a
 * century), leaving long tails of periods holding a handful of patients each:
 * dozens of rows that can only ever read "< T".
 */
export function trimPeriods(
  periods: readonly string[],
  marginal: ReadonlyMap<string, number>,
  threshold: number,
): string[] {
  const kept = periods.map((p) => (marginal.get(p) ?? 0) >= threshold)
  const first = kept.indexOf(true)
  const last = kept.lastIndexOf(true)
  return first < 0 ? [] : periods.slice(first, last + 1)
}

// ---------------------------------------------------------------------------
// Legacy configuration
// ---------------------------------------------------------------------------

/** The configuration shape before variables and crossings, read once and dropped. */
interface LegacyCatalogFields {
  dimensions?: Array<{
    type?: string
    enabled?: boolean
    ageGroup?: { brackets?: number[] }
    careSite?: { level?: 'visit' | 'visit_detail' }
  }> | null
  categoryColumn?: string | null
  subcategoryColumn?: string | null
  periodConfig?: {
    granularity?: PeriodGranularity
    serviceLevel?: 'visit' | 'visit_detail'
    serviceLabels?: string[]
    conceptCategories?: string[]
  } | null
  computedPeriods?: number | null
}

export const LEGACY_CATALOG_FIELDS = ['dimensions', 'categoryColumn', 'subcategoryColumn', 'periodConfig', 'computedPeriods'] as const

/** Whether a stored catalog still carries the old configuration and no variables. */
export function isLegacyCatalog(raw: object): boolean {
  return !(raw as Partial<DataCatalog>).variables
}

/**
 * Variables + crossings of a catalog stored before they existed.
 *
 * The old period table was "one row per period, widened by sex, age, services
 * and concept categories" — that is exactly the period×X crossings, so each
 * enabled enrichment becomes one.
 */
export function convertLegacyCatalog(raw: LegacyCatalogFields): Pick<DataCatalog, 'variables' | 'crossings'> {
  const dims = raw.dimensions ?? []
  const dim = (type: string) => dims.find((d) => d?.type === type)
  const pc = raw.periodConfig ?? null
  const serviceLabels = pc?.serviceLabels ?? []

  const variables: CatalogVariables = {
    concept: {
      ...DEFAULT_CONCEPT_CONFIG,
      enabled: (pc?.conceptCategories?.length ?? 0) > 0 && !!raw.categoryColumn,
      level: raw.categoryColumn ? 'category' : 'concept',
      ...(raw.categoryColumn ? { categoryColumn: raw.categoryColumn } : {}),
      ...(raw.subcategoryColumn ? { subcategoryColumn: raw.subcategoryColumn } : {}),
    },
    period: { enabled: !!pc, granularity: pc?.granularity ?? 'month' },
    service: {
      ...DEFAULT_SERVICE_CONFIG,
      enabled: !!dim('care_site')?.enabled,
      level: pc?.serviceLevel ?? dim('care_site')?.careSite?.level ?? 'visit_detail',
      // A picked subset of services becomes groups of one, the rest "Other".
      grouping: serviceLabels.length > 0 ? 'manual' : 'all',
      groups: Object.fromEntries(serviceLabels.map((l) => [l, l])),
    },
    age: { enabled: !!dim('age_group')?.enabled, brackets: dim('age_group')?.ageGroup?.brackets ?? [...DEFAULT_AGE_BRACKETS] },
    sex: { enabled: !!dim('sex')?.enabled },
  }

  // Every variable was shown alone then.
  const crossings: CatalogVariableId[][] = enabledVariables(variables).map((v) => [v])
  if (variables.period?.enabled) {
    for (const v of ['concept', 'service', 'age', 'sex'] as const) {
      if (variables[v]?.enabled) crossings.push(canonicalCrossing(['period', v]))
    }
  }
  return { variables, crossings }
}

/**
 * The catalog with variables and crossings, converting an old one in place of
 * its legacy fields. A no-op for a catalog already converted.
 */
export function normalizeCatalog<T extends object>(raw: T): T & Pick<DataCatalog, 'variables' | 'crossings'> {
  if (!isLegacyCatalog(raw)) {
    const c = raw as T & Pick<DataCatalog, 'variables' | 'crossings'>
    return c.crossings ? c : { ...c, crossings: [] }
  }
  const converted = convertLegacyCatalog(raw as LegacyCatalogFields)
  const rest = { ...raw } as Record<string, unknown>
  for (const key of LEGACY_CATALOG_FIELDS) delete rest[key]
  return { ...(rest as T), ...converted }
}
