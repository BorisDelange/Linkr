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
  // Everything below runs over millions of cells on a large warehouse, so it
  // holds flat typed arrays rather than an object or a string per cell or per
  // group: those made the garbage collector the main cost.

  // Each modality gets an index per variable, read once per cell. A cell's key
  // over a set of variables is its indices in mixed radix — the same key for
  // the same modalities in whichever crossing, so a group finds its margin.
  const modalityIndex = new Map<string, Map<string, number>>()
  const codes = new Map<string, Int32Array>()
  for (const c of crossings) {
    const k = c.variables.length
    const indices = c.variables.map((v) => {
      let index = modalityIndex.get(v)
      if (!index) modalityIndex.set(v, (index = new Map()))
      return index
    })
    const code = new Int32Array(c.rows.length * k)
    for (let i = 0; i < c.rows.length; i++) {
      const values = c.rows[i].values
      for (let p = 0; p < k; p++) {
        const index = indices[p]
        let n = index.get(values[p])
        if (n === undefined) index.set(values[p], (n = index.size))
        code[i * k + p] = n
      }
    }
    codes.set(c.id, code)
  }
  const radix = new Map<string, number>()
  let span = 1
  for (const [v, index] of modalityIndex) {
    radix.set(v, span)
    span *= index.size
  }

  const masks = new Map<string, CrossingMask>()
  const byId = new Map(crossings.map((c) => [c.id, c]))
  const statusByKey = new Map<string, Map<number, CellStatus>>()
  // Only crossings some larger one takes as a margin need their cells keyed.
  const margins = new Set<string>()
  for (const c of crossings) {
    for (let subset = 1; subset < (1 << c.variables.length) - 1; subset++) {
      margins.add(c.variables.filter((_, i) => subset & (1 << i)).join('-'))
    }
  }

  const ordered = [...crossings].sort((a, b) => a.variables.length - b.variables.length)
  for (const crossing of ordered) {
    const { rows, variables } = crossing
    const n = rows.length
    const k = variables.length
    const code = codes.get(crossing.id)!
    const weights = variables.map((v) => radix.get(v)!)
    const status = new Uint8Array(n)
    for (let i = 0; i < n; i++) status[i] = rows[i].patients < threshold ? PRIMARY : PUBLISHED

    // The groups, back to back: group g is members[start[g]..start[g + 1]].
    const members: number[] = []
    const start: number[] = [0]
    const bucketOf = new Int32Array(n)
    for (let subset = 0; subset < (1 << k) - 1; subset++) {
      const positions: number[] = []
      for (let p = 0; p < k; p++) if (subset & (1 << p)) positions.push(p)
      let totalPublished: (key: number) => boolean
      if (positions.length === 0) {
        totalPublished = () => true
      } else {
        const margin = byId.get(positions.map((p) => variables[p]).join('-'))
        const marginStatus = margin && factOf(margin) === factOf(crossing) ? statusByKey.get(margin.id) : undefined
        if (!marginStatus) continue
        totalPublished = (key) => marginStatus.get(key) === PUBLISHED
      }
      // Buckets numbered in order of first appearance, members in row order.
      const bucketIds = new Map<number, number>()
      const bucketKeys: number[] = []
      const sizes: number[] = []
      for (let i = 0; i < n; i++) {
        let key = 0
        for (const p of positions) key += code[i * k + p] * weights[p]
        let b = bucketIds.get(key)
        if (b === undefined) {
          b = bucketKeys.length
          bucketIds.set(key, b)
          bucketKeys.push(key)
          sizes.push(0)
        }
        bucketOf[i] = b
        sizes[b]++
      }
      const offset = new Int32Array(sizes.length).fill(-1)
      for (let b = 0; b < sizes.length; b++) {
        if (sizes[b] < 2 || !totalPublished(bucketKeys[b])) continue
        offset[b] = start[start.length - 1]
        start.push(offset[b] + sizes[b])
      }
      members.length = start[start.length - 1]
      const fill = offset.slice()
      for (let i = 0; i < n; i++) {
        const b = bucketOf[i]
        if (offset[b] >= 0) members[fill[b]++] = i
      }
    }
    const groupCount = start.length - 1

    // Passes over the groups in order until none changes — but a group is only
    // looked at again once one of its cells was masked since: one that did not
    // fire and saw no change cannot fire. Same order, same outcome as scanning
    // every group on every pass, without re-reading millions of unchanged cells.
    const groupsOfCell = cellGroupIndex(members, start, n)
    const queued = new Uint8Array(groupCount).fill(1)
    let pending = groupCount
    while (pending > 0) {
      for (let g = 0; g < groupCount; g++) {
        if (!queued[g]) continue
        queued[g] = 0
        pending--
        let masked = 0
        let smallest = -1
        for (let m = start[g]; m < start[g + 1]; m++) {
          const i = members[m]
          if (status[i] !== PUBLISHED) masked++
          else if (smallest < 0 || rows[i].patients < rows[smallest].patients) smallest = i
        }
        if (masked === 1 && smallest >= 0) {
          status[smallest] = SECONDARY
          for (let j = groupsOfCell.start[smallest]; j < groupsOfCell.start[smallest + 1]; j++) {
            const other = groupsOfCell.groups[j]
            if (!queued[other]) {
              queued[other] = 1
              pending++
            }
          }
        }
      }
    }

    const keyed = margins.has(crossing.id) ? new Map<number, CellStatus>() : null
    let primary = 0
    let secondary = 0
    let patientMass = 0
    let publishedMass = 0
    for (let i = 0; i < n; i++) {
      const s = status[i] as CellStatus
      if (keyed) {
        let key = 0
        for (let p = 0; p < k; p++) key += code[i * k + p] * weights[p]
        keyed.set(key, s)
      }
      patientMass += rows[i].patients
      if (s === PRIMARY) primary++
      else if (s === SECONDARY) secondary++
      else publishedMass += rows[i].patients
    }
    if (keyed) statusByKey.set(crossing.id, keyed)
    masks.set(crossing.id, { status, cells: n, primary, secondary, patientMass, publishedMass })
  }
  return masks
}

/** For each cell, the groups it belongs to: `groups[start[i]..start[i + 1]]`. */
function cellGroupIndex(members: readonly number[], groupStart: readonly number[], cells: number): { start: Int32Array; groups: Int32Array } {
  const start = new Int32Array(cells + 1)
  for (const i of members) start[i + 1]++
  for (let i = 0; i < cells; i++) start[i + 1] += start[i]
  const fill = start.slice(0, cells)
  const index = new Int32Array(start[cells])
  for (let g = 0; g + 1 < groupStart.length; g++) {
    for (let m = groupStart[g]; m < groupStart[g + 1]; m++) index[fill[members[m]]++] = g
  }
  return { start, groups: index }
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
