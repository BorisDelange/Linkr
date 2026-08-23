/**
 * The rows of a descriptive table ("Table 1"), in the shape a journal prints.
 *
 * The change from the old model is structural: a categorical variable is no
 * longer one row with its levels crammed into a cell, but a heading row followed
 * by ONE INDENTED ROW PER LEVEL — the gtsummary layout, and what makes the table
 * readable and copyable into a manuscript.
 *
 * Pure: no React, no i18n. Labels come in already localized, so the same
 * function serves the widget, the export and (later) the Reports page.
 */

export type SummaryStat = 'median_iqr' | 'mean_sd' | 'min_max' | 'range'

export interface DescriptiveCell {
  /** Rendered text; an em dash when the statistic does not apply. */
  text: string
}

export interface DescriptiveRow {
  id: string
  label: string
  /** A level of the variable above, not a variable of its own. */
  indent: boolean
  /** Keyed by group name; the single key '' when there is no group-by. */
  cells: Record<string, DescriptiveCell>
  /** How many respondents this row's statistic is computed over. */
  n: number
}

export interface DescriptiveTable {
  rows: DescriptiveRow[]
  /** Group names in display order, or null when ungrouped. */
  groups: string[] | null
  /** Rows per group, for the "Control (n=137)" header. */
  groupSizes: Record<string, number>
  total: number
}

export const DASH = '—'

export interface VariableSpec {
  /** Identifies the row in the output; the caller's column id. */
  id: string
  /**
   * The key to read this variable out of a data row.
   *
   * NOT the same as `id`: a column's id is a slug (`col_weight_kg`) while the
   * rows a dataset yields are keyed by the column's NAME (`weight_kg`). Reading
   * by id finds `undefined` in every row, which surfaces as a variable that is
   * 100% missing rather than as an error.
   */
  key: string
  /** Already resolved to the column's label, never its storage name. */
  label: string
  kind: 'numeric' | 'categorical'
}

function isMissing(v: unknown): boolean {
  if (v == null) return true
  const s = String(v).trim().toLowerCase()
  return s === '' || s === 'null' || s === 'na' || s === 'nan'
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** R type-7 quantile, matching the rest of the app. */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const pos = (n - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

/** Round to at most `digits` significant decimals, dropping a trailing `.0`. */
export function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return DASH
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(digits)
}

/** The rendered statistic for a set of numeric values. */
function numericCell(values: unknown[], stat: SummaryStat): string {
  const nums: number[] = []
  for (const v of values) {
    if (isMissing(v)) continue
    const n = toNum(v)
    if (n !== null) nums.push(n)
  }
  if (nums.length === 0) return DASH
  nums.sort((a, b) => a - b)
  switch (stat) {
    case 'mean_sd': {
      const mean = nums.reduce((s, v) => s + v, 0) / nums.length
      const variance = nums.length > 1
        ? nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (nums.length - 1)
        : 0
      return `${fmt(mean)} ± ${fmt(Math.sqrt(variance))}`
    }
    case 'min_max':
      return `${fmt(nums[0])} / ${fmt(nums[nums.length - 1])}`
    case 'range':
      return fmt(nums[nums.length - 1] - nums[0])
    default:
      return `${fmt(quantile(nums, 0.5))} [${fmt(quantile(nums, 0.25))}–${fmt(quantile(nums, 0.75))}]`
  }
}

/** `44 (32%)`, the count and its share of the group that ANSWERED. */
function countCell(count: number, answered: number): string {
  if (answered === 0) return DASH
  return `${count} (${Math.round((count / answered) * 100)}%)`
}

export interface BuildOptions {
  rows: Record<string, unknown>[]
  variables: VariableSpec[]
  /** Column to split by: its id, the row key to read it by, and its label. */
  groupBy?: { id: string; key: string; label: string }
  stat?: SummaryStat
  /** Show a "Missing" row under each variable that has any. */
  showMissing?: boolean
  /** Label for the missing row, already localized. */
  missingLabel?: string
  /** Cap on levels shown per categorical variable; 0 = all. */
  maxLevels?: number
  othersLabel?: string
}

/**
 * Build the table.
 *
 * Percentages are over the rows that ANSWERED, not over the group total — a
 * variable with 30% missing would otherwise show levels summing to 70%, which
 * reads as a mistake. The missing count is reported on its own row instead, so
 * nothing is hidden.
 */
export function buildDescriptiveTable({
  rows,
  variables,
  groupBy,
  stat = 'median_iqr',
  showMissing = true,
  missingLabel = 'Missing',
  maxLevels = 0,
  othersLabel = 'Other',
}: BuildOptions): DescriptiveTable {
  const grouped = new Map<string, Record<string, unknown>[]>()
  if (groupBy) {
    for (const row of rows) {
      const raw = row[groupBy.key]
      // A missing group value is its own group: dropping those rows would
      // silently change the denominator of every other column.
      const key = isMissing(raw) ? DASH : String(raw).trim()
      const list = grouped.get(key)
      if (list) list.push(row)
      else grouped.set(key, [row])
    }
  } else {
    grouped.set('', rows)
  }

  const groups = groupBy ? [...grouped.keys()].sort() : null
  const keys = groups ?? ['']
  const groupSizes: Record<string, number> = {}
  for (const k of keys) groupSizes[k] = grouped.get(k)?.length ?? 0

  const out: DescriptiveRow[] = []

  for (const variable of variables) {
    const answeredPerGroup: Record<string, unknown[]> = {}
    for (const k of keys) {
      answeredPerGroup[k] = (grouped.get(k) ?? []).map((r) => r[variable.key]).filter((v) => !isMissing(v))
    }
    const answeredTotal = keys.reduce((s, k) => s + answeredPerGroup[k].length, 0)

    if (variable.kind === 'numeric') {
      out.push({
        id: variable.id,
        label: variable.label,
        indent: false,
        n: answeredTotal,
        cells: Object.fromEntries(keys.map((k) => [k, { text: numericCell(answeredPerGroup[k], stat) }])),
      })
    } else {
      // The heading row names the variable and carries no statistic — the
      // levels below it do. Levels are ordered by overall frequency so the
      // dominant category leads, which is how a Table 1 is read.
      const overall = new Map<string, number>()
      for (const k of keys) {
        for (const v of answeredPerGroup[k]) {
          const key = String(v).trim()
          overall.set(key, (overall.get(key) ?? 0) + 1)
        }
      }
      let levels = [...overall.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
      let others: string[] = []
      if (maxLevels > 0 && levels.length > maxLevels) {
        others = levels.slice(maxLevels)
        levels = levels.slice(0, maxLevels)
      }

      out.push({
        id: variable.id,
        label: variable.label,
        indent: false,
        n: answeredTotal,
        cells: Object.fromEntries(keys.map((k) => [k, { text: '' }])),
      })
      for (const level of levels) {
        out.push({
          id: `${variable.id}::${level}`,
          label: level,
          indent: true,
          n: overall.get(level) ?? 0,
          cells: Object.fromEntries(keys.map((k) => {
            const answered = answeredPerGroup[k]
            const count = answered.filter((v) => String(v).trim() === level).length
            return [k, { text: countCell(count, answered.length) }]
          })),
        })
      }
      if (others.length > 0) {
        const otherSet = new Set(others)
        out.push({
          id: `${variable.id}::__others__`,
          label: othersLabel,
          indent: true,
          n: others.reduce((s, o) => s + (overall.get(o) ?? 0), 0),
          cells: Object.fromEntries(keys.map((k) => {
            const answered = answeredPerGroup[k]
            const count = answered.filter((v) => otherSet.has(String(v).trim())).length
            return [k, { text: countCell(count, answered.length) }]
          })),
        })
      }
    }

    if (showMissing) {
      const missingPerGroup = keys.map((k) => (groupSizes[k] ?? 0) - answeredPerGroup[k].length)
      if (missingPerGroup.some((m) => m > 0)) {
        out.push({
          id: `${variable.id}::__missing__`,
          label: missingLabel,
          indent: true,
          n: missingPerGroup.reduce((s, m) => s + m, 0),
          cells: Object.fromEntries(keys.map((k, i) => [
            k,
            // Missing IS over the group total — it is the one quantity whose
            // denominator is everyone, since that is what makes it missing.
            { text: missingPerGroup[i] === 0 ? DASH : countCell(missingPerGroup[i], groupSizes[k] ?? 0) },
          ])),
        })
      }
    }
  }

  return { rows: out, groups, groupSizes, total: rows.length }
}
