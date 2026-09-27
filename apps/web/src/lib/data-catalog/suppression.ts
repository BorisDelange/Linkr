import type { AnonymizationConfig, AnonymizationImpact, CatalogCrossingResult, CatalogResultCache } from '@/types/catalog'

/** 0 = published, 1 = below the threshold, 2 = hidden to protect another cell. */
export type CellStatus = 0 | 1 | 2

export const PUBLISHED: CellStatus = 0
export const PRIMARY: CellStatus = 1
export const SECONDARY: CellStatus = 2

export interface CrossingMask {
  /** One status per row of the crossing, same index. */
  status: Uint8Array
  cells: number
  primary: number
  secondary: number
  /** Sum of the cells' patients, and of the published ones: the patient coverage. */
  patientMass: number
  publishedMass: number
}

const SEP = '\u0001'

/** Crossings over events (with the concept variable) and over visits count different populations. */
function factOf(c: Pick<CatalogCrossingResult, 'variables'>): 'event' | 'visit' {
  return c.variables.includes('concept') ? 'event' : 'visit'
}

/**
 * Primary and secondary cell suppression over every crossing of a catalog.
 *
 * Primary: a cell with fewer patients than the threshold is masked, and all of
 * its measures with it (stays, records) — its patient count is what identifies.
 *
 * Secondary — the classic "at least two suppressed cells per published total"
 * rule. A group of cells whose total is published elsewhere, with exactly one
 * masked cell, would give that cell away by subtraction, so the smallest
 * published cell of the group is masked too. The groups of a crossing are, for
 * each proper subset S of its variables, the cells sharing their S modalities;
 * the group's total is the matching cell of the S-crossing when that crossing
 * is computed over the same population and its cell is published — and for S
 * empty, the grand total, always taken as published. Each masking can open a
 * new single-masked group along another variable, so the pass repeats until
 * nothing changes. Crossings are processed smallest first: a crossing's margins
 * must be final before they decide its own groups.
 *
 * Limits, knowingly accepted:
 * - Only non-empty cells take part. An empty cell reads "< T" like a masked
 *   one but hides nothing, so it cannot protect: the group needs two masked
 *   cells that actually hold patients.
 * - Distinct-patient counts only add up over a true partition (sex). Across
 *   age at visit, services or concepts one patient sits in several cells, so
 *   subtraction yields bounds rather than a value; the rule is applied the same
 *   way, which is conservative there.
 * - Protection is per crossing and its own margins. Guaranteeing it across
 *   overlapping 2- and 3-way tables (linked tables, solved as an integer
 *   programme by tools like τ-ARGUS) is out of scope.
 */
export function computeCrossingMasks(
  crossings: readonly CatalogCrossingResult[],
  threshold: number,
): Map<string, CrossingMask> {
  const masks = new Map<string, CrossingMask>()
  const byId = new Map(crossings.map((c) => [c.id, c]))
  const statusByKey = new Map<string, Map<string, CellStatus>>()

  const ordered = [...crossings].sort((a, b) => a.variables.length - b.variables.length)
  for (const crossing of ordered) {
    const { rows, variables } = crossing
    const status = new Uint8Array(rows.length)
    for (let i = 0; i < rows.length; i++) status[i] = rows[i].patients < threshold ? PRIMARY : PUBLISHED

    const groups: number[][] = []
    const k = variables.length
    for (let subset = 0; subset < (1 << k) - 1; subset++) {
      const positions = variables.map((_, i) => i).filter((i) => subset & (1 << i))
      let totalPublished: (key: string) => boolean
      if (positions.length === 0) {
        totalPublished = () => true
      } else {
        const subsetVars = positions.map((i) => variables[i])
        const margin = byId.get(subsetVars.join('-'))
        const marginStatus = margin && factOf(margin) === factOf(crossing) ? statusByKey.get(margin.id) : undefined
        if (!marginStatus) continue
        totalPublished = (key) => marginStatus.get(key) === PUBLISHED
      }
      const bucket = new Map<string, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const key = positions.map((p) => rows[i].values[p]).join(SEP)
        const list = bucket.get(key)
        if (list) list.push(i)
        else bucket.set(key, [i])
      }
      for (const [key, members] of bucket) {
        if (members.length > 1 && totalPublished(key)) groups.push(members)
      }
    }

    let changed = true
    while (changed) {
      changed = false
      for (const members of groups) {
        let masked = 0
        let smallest = -1
        for (const i of members) {
          if (status[i] !== PUBLISHED) masked++
          else if (smallest < 0 || rows[i].patients < rows[smallest].patients) smallest = i
        }
        if (masked === 1 && smallest >= 0) {
          status[smallest] = SECONDARY
          changed = true
        }
      }
    }

    const keyed = new Map<string, CellStatus>()
    let primary = 0
    let secondary = 0
    let patientMass = 0
    let publishedMass = 0
    for (let i = 0; i < rows.length; i++) {
      const s = status[i] as CellStatus
      keyed.set(rows[i].values.join(SEP), s)
      patientMass += rows[i].patients
      if (s === PRIMARY) primary++
      else if (s === SECONDARY) secondary++
      else publishedMass += rows[i].patients
    }
    statusByKey.set(crossing.id, keyed)
    masks.set(crossing.id, { status, cells: rows.length, primary, secondary, patientMass, publishedMass })
  }
  return masks
}

/** Share of a crossing's non-empty cells that are published, 0–1 (1 when it has none). */
export function publishedCellShare(mask: Pick<CrossingMask, 'cells' | 'primary' | 'secondary'>): number {
  return mask.cells > 0 ? (mask.cells - mask.primary - mask.secondary) / mask.cells : 1
}

/** Share of the patient-cell mass sitting in published cells, 0–1. */
export function publishedPatientShare(mask: Pick<CrossingMask, 'patientMass' | 'publishedMass'>): number {
  return mask.patientMass > 0 ? mask.publishedMass / mask.patientMass : 1
}

/** What `settings` mask over a computed catalog: the summary the Anonymization tab keeps. */
export function computeAnonymizationImpact(cache: Pick<CatalogResultCache, 'concepts' | 'crossings'>, settings: AnonymizationConfig): AnonymizationImpact {
  const crossings = cache.crossings ?? []
  const masks = computeCrossingMasks(crossings, settings.threshold)
  return {
    threshold: settings.threshold,
    mode: settings.mode ?? 'replace',
    computedAt: new Date().toISOString(),
    concepts: { total: cache.concepts.length, masked: cache.concepts.filter((r) => r.patientCount < settings.threshold).length },
    crossings: crossings.map((c) => {
      const { cells, primary, secondary, patientMass, publishedMass } = masks.get(c.id)!
      return { id: c.id, variables: c.variables, cells, primary, secondary, patientMass, publishedMass }
    }),
  }
}
