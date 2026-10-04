/**
 * Disclosure audit: what an outsider can work out from a published catalog.
 *
 * It reads exactly what leaves the instance — the published cells (masked
 * ones absent, like empty ones), the concept list and the totals, as
 * perturbed as the page shows them — and tries what an attacker would.
 * Every absent cell is an unknown >= 0. Each published total over a group of
 * cells, where the count adds up across the group (records over dates, stays
 * over periods, patients over sex), gives an equation; tables are linked
 * through the margins they share, so a total recovered from one table feeds
 * the equations of the next. The concept list joins in as the concept margin,
 * or, when the crossings count categories, as each category's concepts; over
 * every concept, the grand total of records caps the margin's sum. With
 * perturbation, each published count is only known within ±noise, so the
 * equations get that much slack.
 *
 * Interval propagation over those equations — plus, inside one cell,
 * patients <= stays (over visits) or <= records (over events) — bounds every
 * unknown. Flagged:
 * - a masked cell whose patients are pinned between 1 and the threshold
 *   minus one: a small group shown to exist;
 * - a masked cell whose stays or records come out exactly, or within 2.
 *
 * Propagation is sound (every bound it gives holds) but not complete: an
 * integer programme over all tables at once (τ-ARGUS) can find more. It is
 * split in independent systems — one over visits, one per published concept —
 * which keeps each one small.
 */

import type { AnonymizationAudit, AnonymizationAuditFinding, CatalogMeasure, CatalogResultCache, CatalogVariableId, DataCatalog } from '@/types/catalog'
import { CATALOG_VARIABLE_ORDER } from '@/types/catalog'
import {
  buildPublishedCatalog,
  computeCatalogMasks,
  conceptModalityKey,
  publishedConcepts,
  publishedTotals,
  type PublishedCatalog,
} from './publish'
import { PUBLISHED } from './suppression'

type Fact = 'visit' | 'event'

/** What adds up exactly across which variables, per population: a patient has one sex; a stay one start period and age; a record one date, age and concept. */
const ADDS: Record<Fact, Partial<Record<CatalogMeasure, readonly CatalogVariableId[]>>> = {
  visit: { patients: ['sex'], stays: ['period', 'age', 'sex'], unit_stays: ['period', 'age', 'sex'] },
  event: { patients: ['sex'], stays: ['sex'], records: ['period', 'age', 'sex', 'concept'] },
}

/** Inside one cell, the first count cannot exceed the second, and both are empty together. */
const BOUNDS: Record<Fact, [CatalogMeasure, CatalogMeasure][]> = {
  visit: [['patients', 'stays']],
  event: [['patients', 'records'], ['stays', 'records']],
}

/** Examples kept per finding. */
const EXAMPLES = 20
const ROUNDS = 40

interface Table {
  id: string
  vars: CatalogVariableId[]
  measures: CatalogMeasure[]
  /** Published values by cell key (modality indices joined by ','). */
  cells: Map<string, (number | null)[]>
  /**
   * The concept list when the concept variable counts categories: the concepts
   * of each category (indices into `names`, null for those the list leaves
   * out), cells keyed `category:concept`.
   */
  members?: { of: Map<number, number[]>; names: (string | null)[] }
}

export interface AuditInput {
  published: PublishedCatalog
  /**
   * The concept list as published: the concept margin when the 1-way crossing
   * is not published, each category's concepts when the variable counts
   * categories. A masked concept the list still names (replace mode) has null
   * counts; `group` is its category (or subcategory) at the variable's level.
   */
  concepts: { key: string; name?: string; group?: string | null; patients: number | null; stays?: number | null; records: number | null }[]
  /** Suppress mode: the list leaves masked concepts out, so a category may hold concepts it does not name. */
  hidesMasked?: boolean
  /**
   * The crossings count every concept, at whatever level. The published
   * variable says so only at concept level (`everyConcept`, which its page
   * reads); at category level the audit takes it from here, so that the
   * concepts with no category are capped by the grand total like the margin.
   */
  everyConcept?: boolean
  totals: { patients: number; stays?: number; unitStays?: number; records: number }
  threshold: number
  noise: number
}

export interface AuditHooks {
  /** Systems solved, out of how many. */
  progress?: (done: number, total: number) => void
  signal?: AbortSignal
}

const CONCEPT_LIST = 'concept-list'
/** Suppress mode: whatever concepts a category holds that the list leaves out. */
const UNLISTED = '…'
/** The group of the concepts with no category, in the list at category level. */
const NO_GROUP = -1
const NO_GROUP_NAME = '—'

const factOf = (vars: readonly CatalogVariableId[]): Fact => (vars.includes('concept') ? 'event' : 'visit')

function tablesOf(input: AuditInput): Map<string, Table> {
  const tables = new Map<string, Table>()
  for (const c of input.published.crossings) {
    const k = c.vars.length
    const measures: CatalogMeasure[] = ['patients', ...c.measures]
    const cells = new Map<string, (number | null)[]>()
    for (const cell of c.cells) {
      if (cell[cell.length - 1] !== PUBLISHED) continue
      cells.set(cell.slice(0, k).join(','), cell.slice(k, k + measures.length))
    }
    tables.set(c.vars.join('-'), { id: c.id, vars: c.vars, measures, cells })
  }
  const concept = input.published.variables.concept
  if (!concept || !input.concepts.length) return tables
  const index = new Map(concept.mods.map((m, i) => [m, i]))
  const withStays = input.concepts.some((c) => c.stays != null)
  const measures: CatalogMeasure[] = withStays ? ['patients', 'stays', 'records'] : ['patients', 'records']
  const valuesOf = (c: AuditInput['concepts'][number]) => (withStays ? [c.patients, c.stays ?? null, c.records] : [c.patients, c.records])
  const cells = new Map<string, (number | null)[]>()
  if ((concept.level ?? 'concept') === 'concept') {
    // The concept list is the concept margin whether or not the 1-way crossing is published.
    if (tables.has('concept')) return tables
    for (const c of input.concepts) {
      const i = index.get(c.key)
      if (i != null && c.records != null) cells.set(String(i), valuesOf(c))
    }
    tables.set('concept', { id: 'concept', vars: ['concept'], measures, cells })
    return tables
  }
  const of = new Map<number, number[]>()
  const names: (string | null)[] = []
  const add = (g: number, name: string | null) => {
    const m = names.push(name) - 1
    of.set(g, [...(of.get(g) ?? []), m])
    return m
  }
  for (const c of input.concepts) {
    const g = c.group == null ? NO_GROUP : index.get(c.group)
    if (g == null) continue
    const m = add(g, c.name ?? c.key)
    if (c.records != null) cells.set(`${g}:${m}`, valuesOf(c))
  }
  if (input.hidesMasked) for (let g = NO_GROUP; g < concept.mods.length; g++) add(g, null)
  tables.set(CONCEPT_LIST, { id: CONCEPT_LIST, vars: ['concept'], measures, cells, members: { of, names } })
  return tables
}

/** Σ coef·x + c = 0, with c known within [cLo, cHi]. */
interface Equation { terms: [number, string][]; cLo: number; cHi: number }

function* product(spaces: number[]): Generator<number[]> {
  if (spaces.some((n) => n === 0)) return
  const at = spaces.map(() => 0)
  while (true) {
    yield at
    let p = spaces.length - 1
    while (p >= 0 && ++at[p] === spaces[p]) at[p--] = 0
    if (p < 0) return
  }
}

/** The equations of one system: over visits (`concept` null), or over the events of one concept. */
function equationsOf(tables: Map<string, Table>, input: AuditInput, concept: number | null): Equation[] {
  const { noise, totals } = input
  const size = (v: CatalogVariableId) => input.published.variables[v]?.mods.length ?? 0
  const grand: Partial<Record<CatalogMeasure, number>> = { patients: totals.patients, stays: totals.stays, unit_stays: totals.unitStays }
  const eqs: Equation[] = []
  if (concept == null) eqs.push(...grandRecordEquations(tables, input))
  for (const t of tables.values()) {
    if (t.members) {
      if (concept != null) eqs.push(...memberEquations(t, t.members, tables.get('concept'), concept, noise))
      continue
    }
    if ((concept == null) !== !t.vars.includes('concept')) continue
    const fact = factOf(t.vars)
    for (let mi = 0; mi < t.measures.length; mi++) {
      const m = t.measures[mi]
      const adds = ADDS[fact][m] ?? []
      for (let subset = 1; subset < 1 << t.vars.length; subset++) {
        const across = t.vars.filter((_, p) => subset & (1 << p))
        if (across.includes('concept') || !across.every((v) => adds.includes(v))) continue
        const kept = t.vars.filter((_, p) => !(subset & (1 << p)))
        const margin = kept.length ? tables.get(kept.join('-')) : null
        const marginMeasure = margin ? margin.measures.indexOf(m) : -1
        if (kept.length && (!margin || marginMeasure < 0)) continue
        if (!kept.length && (fact === 'event' || grand[m] == null)) continue

        const keptSpaces = kept.map((v) => (v === 'concept' ? 1 : size(v)))
        const acrossSpaces = across.map(size)
        for (const s of product(keptSpaces)) {
          const at = new Map<CatalogVariableId, number>(kept.map((v, i) => [v, v === 'concept' ? concept! : s[i]]))
          const terms: [number, string][] = []
          let c = 0
          let published = 0
          for (const d of product(acrossSpaces)) {
            across.forEach((v, i) => at.set(v, d[i]))
            const key = t.vars.map((v) => at.get(v)).join(',')
            const value = t.cells.get(key)?.[mi]
            if (value == null) terms.push([1, `${t.id}|${key}|${m}`])
            else { c += value; published++ }
          }
          if (margin) {
            const key = kept.map((v) => at.get(v)).join(',')
            const value = margin.cells.get(key)?.[marginMeasure]
            if (value == null) terms.push([-1, `${margin.id}|${key}|${m}`])
            else { c -= value; published++ }
          } else {
            c -= grand[m]!
            published++
          }
          if (terms.length) eqs.push({ terms, cLo: c - noise * published, cHi: c + noise * published })
        }
      }
    }
  }
  return eqs
}

/** `x >= 1`: a cell the page shows to exist. */
const exists = (x: string): Equation => ({ terms: [[1, x]], cLo: -Infinity, cHi: -1 })

/**
 * The concept list at category level, for category `g`: records add up across
 * the category's concepts to its cell. A concept the list names but masks
 * exists.
 */
function memberEquations(t: Table, members: NonNullable<Table['members']>, margin: Table | undefined, g: number, noise: number): Equation[] {
  const eqs: Equation[] = []
  const of = members.of.get(g) ?? []
  for (let mi = 0; mi < t.measures.length; mi++) {
    const m = t.measures[mi]
    if (!ADDS.event[m]?.includes('concept')) continue
    const marginMeasure = margin ? margin.measures.indexOf(m) : -1
    const total = marginMeasure >= 0 ? margin!.cells.get(String(g))?.[marginMeasure] : undefined
    if (total == null) continue
    const terms: [number, string][] = []
    let c = -total
    let published = 1
    for (const member of of) {
      const value = t.cells.get(`${g}:${member}`)?.[mi]
      const x = `${t.id}|${g}:${member}|${m}`
      if (value != null) { c += value; published++ } else {
        terms.push([1, x])
        if (members.names[member] != null) eqs.push(exists(x))
      }
    }
    if (terms.length) eqs.push({ terms, cLo: c - noise * published, cHi: c + noise * published })
  }
  return eqs
}

/**
 * A catalog over every concept: the grand total of records is at least the sum
 * of the concept margin's — an event whose concept is not in a dictionary
 * counts in the total only. At category level the margin is the categories'
 * cells plus the concepts with no category, which are in none of them. A
 * concept the list names but masks exists.
 */
function grandRecordEquations(tables: Map<string, Table>, input: AuditInput): Equation[] {
  const concept = input.published.variables.concept
  const margin = tables.get('concept')
  const mi = margin ? margin.measures.indexOf('records') : -1
  const list = tables.get(CONCEPT_LIST)
  if (list?.members) {
    if (!input.everyConcept) return []
    const li = list.measures.indexOf('records')
    const cells: { value: number | null | undefined; x: string; named: boolean }[] = [
      ...concept!.mods.map((_, g) => ({ value: mi >= 0 ? margin!.cells.get(String(g))?.[mi] : null, x: `concept|${g}|records`, named: false })),
      ...(list.members.of.get(NO_GROUP) ?? []).map((m) => ({
        value: list.cells.get(`${NO_GROUP}:${m}`)?.[li],
        x: `${list.id}|${NO_GROUP}:${m}|records`,
        named: list.members!.names[m] != null,
      })),
    ]
    return recordsCap(cells, input)
  }
  if (!concept?.everyConcept || !margin || mi < 0) return []
  const masked = new Set(input.concepts.filter((c) => c.records == null).map((c) => c.key))
  return recordsCap(
    concept.mods.map((code, i) => ({ value: margin.cells.get(String(i))?.[mi], x: `${margin.id}|${i}|records`, named: masked.has(code) })),
    input,
  )
}

/** Σ cells <= the grand total of records; an absent cell is an unknown, one the list names exists. */
function recordsCap(cells: { value: number | null | undefined; x: string; named: boolean }[], input: AuditInput): Equation[] {
  const eqs: Equation[] = []
  const terms: [number, string][] = []
  let c = -input.totals.records
  let published = 1
  for (const { value, x, named } of cells) {
    if (value != null) { c += value; published++ } else {
      terms.push([1, x])
      if (named) eqs.push(exists(x))
    }
  }
  if (terms.length) eqs.push({ terms, cLo: c - input.noise * published, cHi: Infinity })
  return eqs
}

interface Bounds { lo: Map<string, number>; hi: Map<string, number>; inconsistent: number }

function propagate(eqs: Equation[], factOfTable: Map<string, Fact>, measuresOfTable: Map<string, CatalogMeasure[]>): Bounds {
  const lo = new Map<string, number>()
  const hi = new Map<string, number>()
  const ids = new Set<string>()
  for (const e of eqs) for (const [, x] of e.terms) ids.add(x)
  // Inside one cell: patients <= stays or records, stays <= records over events; empty together.
  const pairs: [string, string][] = []
  const paired = new Set<string>()
  for (const x of [...ids]) {
    const [table, key] = x.split('|')
    for (const [small, big] of BOUNDS[factOfTable.get(table) ?? 'visit']) {
      const measures = measuresOfTable.get(table) ?? []
      if (!measures.includes(small) || !measures.includes(big)) continue
      const a = `${table}|${key}|${small}`
      const b = `${table}|${key}|${big}`
      if ((x === a || x === b) && !paired.has(a + b)) {
        paired.add(a + b)
        pairs.push([a, b])
        ids.add(a)
        ids.add(b)
      }
    }
  }
  for (const x of ids) { lo.set(x, 0); hi.set(x, Infinity) }

  for (let round = 0; round < ROUNDS; round++) {
    let changed = false
    for (const { terms, cLo, cHi } of eqs) {
      // Σ over the terms of the smallest and largest a·x, the infinite ones counted apart.
      let minSum = 0, maxSum = 0, minInf = 0, maxInf = 0
      const mins: number[] = []
      const maxs: number[] = []
      for (const [a, x] of terms) {
        const l = lo.get(x)!, h = hi.get(x)!
        const mn = a > 0 ? l : -h
        const mx = a > 0 ? h : -l
        mins.push(mn); maxs.push(mx)
        if (mn === -Infinity) minInf++; else minSum += mn
        if (mx === Infinity) maxInf++; else maxSum += mx
      }
      terms.forEach(([a, x], i) => {
        const restMax = maxInf - (maxs[i] === Infinity ? 1 : 0) > 0 ? Infinity : maxSum - (maxs[i] === Infinity ? 0 : maxs[i])
        const restMin = minInf - (mins[i] === -Infinity ? 1 : 0) > 0 ? -Infinity : minSum - (mins[i] === -Infinity ? 0 : mins[i])
        // a·x = -c - Σ others
        const axLo = -cHi - restMax
        const axHi = -cLo - restMin
        const [nLo, nHi] = a > 0 ? [axLo, axHi] : [-axHi, -axLo]
        if (nLo > lo.get(x)! + 1e-9 && Number.isFinite(nLo)) { lo.set(x, Math.ceil(nLo - 1e-9)); changed = true }
        if (nHi < hi.get(x)! - 1e-9 && Number.isFinite(nHi)) { hi.set(x, Math.floor(nHi + 1e-9)); changed = true }
      })
    }
    for (const [small, big] of pairs) {
      if (hi.get(big)! < hi.get(small)!) { hi.set(small, hi.get(big)!); changed = true }
      if (lo.get(small)! > lo.get(big)!) { lo.set(big, lo.get(small)!); changed = true }
      if (lo.get(big)! >= 1 && lo.get(small)! < 1) { lo.set(small, 1); changed = true }
    }
    if (!changed) break
  }
  let inconsistent = 0
  for (const x of ids) if (lo.get(x)! > hi.get(x)!) inconsistent++
  return { lo, hi, inconsistent }
}

/** Audit what a catalog publishes under its current settings. */
export async function auditCatalog(
  catalog: Pick<DataCatalog, 'variables' | 'crossings' | 'anonymization' | 'counts'>,
  cache: CatalogResultCache,
  hooks: AuditHooks = {},
): Promise<AnonymizationAudit> {
  const { threshold, mode = 'replace', noise = 0 } = catalog.anonymization
  const masks = computeCatalogMasks(catalog, cache, threshold)
  const published = buildPublishedCatalog(catalog, cache, { masks })
  const keyOf = conceptModalityKey(cache)
  const level = catalog.variables.concept?.level ?? 'concept'
  const concepts = publishedConcepts(catalog, cache, { masks }).map((c) => {
    const shown = c.status === PUBLISHED
    return {
      key: keyOf(c),
      name: c.conceptName,
      group: level === 'category' ? c.category : level === 'subcategory' ? c.subcategory : undefined,
      patients: shown ? c.patientCount : null,
      stays: shown ? c.visitCount : null,
      records: shown ? c.recordCount : null,
    }
  })
  const startedAt = Date.now()
  const result = await auditPublished({
    published,
    concepts,
    hidesMasked: mode === 'suppress',
    everyConcept: catalog.variables.concept?.scope === 'all',
    totals: publishedTotals(catalog, cache),
    threshold,
    noise,
  }, hooks)
  return { threshold, mode, noise, resultsComputedAt: cache.computedAt, computedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, ...result }
}

/** The audit proper, over what is published. */
export async function auditPublished(input: AuditInput, hooks: AuditHooks = {}): Promise<Pick<AnonymizationAudit, 'components' | 'unknowns' | 'inconsistent' | 'findings'>> {
  const tables = tablesOf(input)
  const factOfTable = new Map([...tables.values()].map((t) => [t.id, factOf(t.vars)]))
  const measuresOfTable = new Map([...tables.values()].map((t) => [t.id, t.measures]))
  const varsOfTable = new Map([...tables.values()].map((t) => [t.id, t.vars]))
  const margin = tables.get('concept')
  // One system per concept whose total is published: a concept without one has nothing to subtract from.
  const components: (number | null)[] = [null, ...[...(margin?.cells.keys() ?? [])].map(Number)]

  const found = new Map<string, AnonymizationAuditFinding>()
  let unknowns = 0
  let inconsistent = 0
  let yieldedAt = Date.now()
  for (let n = 0; n < components.length; n++) {
    hooks.signal?.throwIfAborted()
    const eqs = equationsOf(tables, input, components[n])
    if (eqs.length) {
      const { lo, hi, inconsistent: bad } = propagate(eqs, factOfTable, measuresOfTable)
      inconsistent += bad
      unknowns += lo.size
      for (const [x, l] of lo) {
        const h = hi.get(x)!
        if (l > h) continue
        const [table, key, measure] = x.split('|') as [string, string, CatalogMeasure]
        const kind = measure === 'patients'
          ? (l >= 1 && h <= input.threshold - 1 ? (l === h ? 'exact' : 'small') : null)
          : (l >= 1 && h - l <= 2 ? (l === h ? 'exact' : 'narrow') : null)
        if (!kind) continue
        const id = `${table}|${measure}|${kind}`
        let f = found.get(id)
        if (!f) found.set(id, (f = { crossing: table, variables: varsOfTable.get(table)!, measure, kind, count: 0, examples: [] }))
        f.count++
        if (f.examples.length < EXAMPLES) {
          const vars = varsOfTable.get(table)!
          const members = tables.get(table)?.members
          const cell = members
            ? key.split(':').map((i, p) => (p === 0
              ? (Number(i) === NO_GROUP ? NO_GROUP_NAME : input.published.variables.concept?.names[Number(i)])
              : members.names[Number(i)] ?? UNLISTED) ?? i)
            : key.split(',').map((i, p) => input.published.variables[vars[p]]?.names[Number(i)] ?? i)
          f.examples.push({ cell, lo: l, hi: h })
        }
      }
    }
    // Yield now and then: the tab stays usable, progress shows, a stop lands.
    if (Date.now() - yieldedAt > 30) {
      hooks.progress?.(n + 1, components.length)
      await new Promise((r) => setTimeout(r, 0))
      yieldedAt = Date.now()
    }
  }
  hooks.progress?.(components.length, components.length)
  const rank = (f: AnonymizationAuditFinding) => (f.measure === 'patients' ? 0 : 1)
  const findings = [...found.values()].sort((a, b) => rank(a) - rank(b)
    || CATALOG_VARIABLE_ORDER.indexOf(a.variables[0]) - CATALOG_VARIABLE_ORDER.indexOf(b.variables[0]) || a.crossing.localeCompare(b.crossing))
  return { components: components.length, unknowns, inconsistent, findings }
}
