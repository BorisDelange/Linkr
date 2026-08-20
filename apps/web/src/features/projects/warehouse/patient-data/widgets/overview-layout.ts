/**
 * Row layout for the Patient overview widget.
 *
 * The figure fits whatever height it has: source tables always get a row, and
 * the lines left over are shared between them in proportion to how many concepts
 * each holds. Concepts that don't fit fold into one "other" row per group, which
 * still carries their events — so the data stays visible even when the names do
 * not, and growing the widget splits them back out.
 *
 * Kept separate from the component because it is pure and worth testing: the
 * apportionment has to add up exactly, and a figure taller than its container is
 * a real bug that only shows on small widgets.
 */

/** One concept in the patient's record, as returned by the inventory query. */
export interface OverviewConceptRow {
  table: string
  conceptId: string
  conceptName: string
  /** Vocabulary code (LOINC, RxNorm…), when the dictionary provides one. */
  conceptCode: string | null
  conceptClass: string | null
  unit: string | null
  /**
   * How many distinct units this concept was charted in for this patient. Above
   * one, `unit` is whichever the aggregate happened to pick, so it must not be
   * shown as if it applied to every event.
   */
  unitCount?: number
  eventCount: number
  durational: boolean
}

export type OverviewRowKind = 'units' | 'table' | 'class' | 'concept' | 'other'

export interface OverviewRow {
  kind: OverviewRowKind
  /** Display label. Generic labels are translated by the caller. */
  label: string
  /** Stable key for scroll/collapse state: the class group, or the table. */
  key: string
  table: string
  /** Concepts this row draws. Empty for the unit lane. */
  conceptIds: string[]
  /** Concepts folded into this row (for "other" and headers). */
  conceptCount: number
  eventCount: number
  /** True when the row mixes concepts, so it can never show a value line. */
  mixed: boolean
  unit?: string | null
  /** Vocabulary code, on single-concept rows only. */
  conceptCode?: string | null
  /** The concept's own id, on single-concept rows only. */
  conceptId?: string | null
  durational: boolean
  /** For "other" rows that are scrolled: how many concepts sit outside the window. */
  scrolledAbove?: number
  scrolledBelow?: number
}

export interface BuildRowsOptions {
  concepts: OverviewConceptRow[]
  /** Lines the figure may use. */
  budget: number
  byClass: boolean
  /** Whether the record has unit stays to show. */
  hasUnits: boolean
  /** Source table name for the unit lane, e.g. `visit_detail`. */
  unitsTable: string | null
  collapsed: ReadonlySet<string>
  hidden: ReadonlySet<string>
  /** Scroll offset per group key, in concepts. */
  offsets: ReadonlyMap<string, number>
}

export interface BuildRowsResult {
  rows: OverviewRow[]
  /** Window size per group, so the caller can drive scrollbars. */
  windows: Map<string, { shown: number; total: number }>
  /** Offsets after clamping, to write back. */
  offsets: Map<string, number>
  /** True when the class level was dropped because the height couldn't afford it. */
  classesDropped: boolean
}

interface Group {
  key: string
  table: string
  cls: string | null
  concepts: OverviewConceptRow[]
}

const sumEvents = (list: OverviewConceptRow[]) =>
  list.reduce((a, c) => a + c.eventCount, 0)

export function buildOverviewRows(opts: BuildRowsOptions): BuildRowsResult {
  const { concepts, byClass, hasUnits, unitsTable, collapsed, hidden, offsets } = opts
  const budget = Math.max(4, Math.floor(opts.budget))

  const byTable = new Map<string, OverviewConceptRow[]>()
  for (const c of concepts) {
    const list = byTable.get(c.table)
    if (list) list.push(c)
    else byTable.set(c.table, [c])
  }
  const allTables = [...byTable.keys()].sort(
    (a, b) => sumEvents(byTable.get(b)!) - sumEvents(byTable.get(a)!),
  )
  // Headers alone can exceed a very short widget. Busiest tables win the space:
  // a figure taller than its container is worse than one showing fewer tables.
  const unitLine = hasUnits ? 1 : 0
  const tables = allTables.slice(0, Math.max(1, budget - unitLine))

  const windows = new Map<string, { shown: number; total: number }>()
  const nextOffsets = new Map<string, number>()

  const unitsRow = (): OverviewRow => ({
    kind: 'units',
    label: unitsTable ?? 'unit',
    key: '__units',
    table: '__units',
    conceptIds: [],
    conceptCount: 0,
    eventCount: 0,
    mixed: true,
    durational: true,
  })

  const tableRow = (t: string): OverviewRow => {
    const list = byTable.get(t)!
    return {
      kind: 'table',
      label: t,
      key: t,
      table: t,
      conceptIds: list.map((c) => c.conceptId),
      conceptCount: list.length,
      eventCount: sumEvents(list),
      mixed: true,
      durational: list.some((c) => c.durational),
    }
  }

  // Every table costs a header, and every class costs one more. Below this the
  // class level cannot be afforded at all, so fall back to the flat tree rather
  // than drawing a figure taller than its container. The unit lane is already
  // spoken for, so it comes off the budget before anything else is priced —
  // counting it as free overflowed the figure by exactly one row whenever
  // `budget === tables.length * 3`.
  const rowBudget = budget - unitLine
  const classAffordable = byClass && rowBudget >= tables.length * 3
  const classesDropped = byClass && !classAffordable

  // Total class rows the figure can carry, shared across the tables in turn.
  let classBudget = Math.max(tables.length, Math.floor((rowBudget - tables.length) / 2))
  let tablesLeft = tables.length

  const groups: Group[] = []
  for (const t of tables) {
    const list = byTable.get(t)!
    if (!classAffordable) {
      groups.push({ key: t, table: t, cls: null, concepts: list })
      continue
    }
    const byCls = new Map<string, OverviewConceptRow[]>()
    for (const c of list) {
      const k = c.conceptClass || '__unmapped'
      const arr = byCls.get(k)
      if (arr) arr.push(c)
      else byCls.set(k, [c])
    }
    // Busiest class first, so the clinically dense ones lead the table.
    let classes = [...byCls.entries()].sort((a, b) => sumEvents(b[1]) - sumEvents(a[1]))

    // Each class costs a header AND, usually, an "other" row — so a long tail of
    // one-concept classes eats the budget and leaves no room for the concepts
    // themselves. Keep only what this table can afford and fold the rest.
    const spare = Math.max(0, budget - tables.length)
    const share = list.length / Math.max(1, concepts.length)
    const want = clamp(Math.round((spare * share) / 2), 1, classes.length)
    // Never spend more than the allowance still holds; every table keeps at
    // least one class row so the level stays meaningful for all of them.
    const allowed = Math.max(1, Math.min(want, classBudget - tablesLeft + 1))
    classBudget -= allowed
    tablesLeft--

    if (classes.length > allowed + 1) {
      const tail = classes.slice(allowed).flatMap(([, cs]) => cs)
      classes = classes.slice(0, allowed)
      if (tail.length) classes.push(['__otherClasses', tail])
    }
    for (const [cls, cs] of classes) {
      groups.push({ key: `${t}\u0000${cls}`, table: t, cls, concepts: cs })
    }
  }

  const groupsOf = (t: string) => groups.filter((g) => g.table === t)

  const classRow = (g: Group): OverviewRow => ({
    kind: 'class',
    label: g.cls ?? '',
    key: g.key,
    table: g.table,
    conceptIds: g.concepts.map((c) => c.conceptId),
    conceptCount: g.concepts.length,
    eventCount: sumEvents(g.concepts),
    mixed: true,
    durational: g.concepts.some((c) => c.durational),
  })

  const conceptRow = (c: OverviewConceptRow, key: string): OverviewRow => ({
    kind: 'concept',
    label: c.conceptName,
    key,
    table: c.table,
    conceptIds: [c.conceptId],
    conceptCount: 1,
    eventCount: c.eventCount,
    mixed: false,
    // Charted in more than one unit: the aggregate's pick describes some events
    // and not others, and a wrong unit on a dose reads as a real measurement.
    unit: (c.unitCount ?? 1) > 1 ? null : c.unit,
    conceptCode: c.conceptCode,
    conceptId: c.conceptId,
    durational: c.durational,
  })

  const otherRow = (
    g: Group,
    rest: OverviewConceptRow[],
    above: number,
    below: number,
  ): OverviewRow => ({
    kind: 'other',
    label: '',
    key: g.key,
    table: g.table,
    conceptIds: rest.map((c) => c.conceptId),
    conceptCount: rest.length,
    eventCount: sumEvents(rest),
    mixed: true,
    durational: rest.some((c) => c.durational),
    scrolledAbove: above || undefined,
    scrolledBelow: below || undefined,
  })

  // Collapsing a table hides all its classes; collapsing one class hides only
  // that class. Either way the freed seats go to whatever is still open. A
  // hidden group spends nothing either: its events are not drawn at all.
  const shut = (g: Group) =>
    collapsed.has(g.table) ||
    hidden.has(g.table) ||
    (g.cls !== null && (collapsed.has(g.key) || hidden.has(g.key)))
  const openGroups = groups.filter((g) => !shut(g))

  const headerCost =
    tables.length +
    (classAffordable
      ? groups.filter((g) => !collapsed.has(g.table) && !hidden.has(g.table)).length
      : 0)
  const totalConcepts = openGroups.reduce((a, g) => a + g.concepts.length, 0)

  // Reserve one line per open group for its "other", or a short viewport overshoots.
  const seats = Math.max(0, budget - headerCost - openGroups.length - unitLine)

  const rows: OverviewRow[] = []
  if (hasUnits) rows.push(unitsRow())

  if (seats <= 0 || totalConcepts === 0) {
    // Too little height for any concept row. Show the structure only, and drop
    // the per-group "other" once even that would overflow — a figure taller than
    // its container is worse than one that admits it is summarising.
    const structural =
      tables.length +
      (classAffordable ? groups.filter((g) => !collapsed.has(g.table)).length : 0)
    const roomForOther = budget - structural - rows.length
    let spent = 0
    for (const t of tables) {
      rows.push(tableRow(t))
      if (collapsed.has(t)) continue
      for (const g of groupsOf(t)) {
        if (g.cls !== null) rows.push(classRow(g))
        if (g.cls !== null && collapsed.has(g.key)) continue
        if (spent >= roomForOther) continue
        if (g.concepts.length > 0) {
          rows.push(otherRow(g, g.concepts, 0, 0))
          spent++
        }
      }
    }
    return { rows, windows, offsets: nextOffsets, classesDropped }
  }

  // Largest-remainder apportionment, floor 1 per group so nothing is starved.
  const quota = openGroups.map((g) => (g.concepts.length / totalConcepts) * seats)
  const alloc = new Map(openGroups.map((g, i) => [g.key, Math.max(1, Math.floor(quota[i]))]))
  let used = [...alloc.values()].reduce((a, b) => a + b, 0)
  const remainders = openGroups
    .map((g, i) => ({ key: g.key, frac: quota[i] - Math.floor(quota[i]) }))
    .sort((a, b) => b.frac - a.frac)
  let i = 0
  while (used < seats && remainders.length) {
    const k = remainders[i % remainders.length].key
    alloc.set(k, (alloc.get(k) ?? 0) + 1)
    i++
    used++
  }
  while (used > seats) {
    const top = [...alloc.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!top || top[1] <= 1) break
    alloc.set(top[0], top[1] - 1)
    used--
  }

  // Emit each table immediately followed by ITS groups and their concepts, so
  // the left column reads as a tree rather than as stacked blocks.
  for (const t of tables) {
    rows.push(tableRow(t))
    if (collapsed.has(t) || hidden.has(t)) {
      windows.set(t, { shown: 0, total: byTable.get(t)!.length })
      continue
    }
    for (const g of groupsOf(t)) {
      if (g.cls !== null) rows.push(classRow(g))
      if (g.cls !== null && (collapsed.has(g.key) || hidden.has(g.key))) {
        windows.set(g.key, { shown: 0, total: g.concepts.length })
        continue
      }

      const sorted = [...g.concepts].sort((a, b) => b.eventCount - a.eventCount)
      const seatsHere = Math.min(alloc.get(g.key) ?? 0, sorted.length)
      // The "other" row costs a line too, whenever anything is left out.
      let n = sorted.length > seatsHere ? Math.max(0, seatsHere - 1) : seatsHere
      if (sorted.length === n + 1) n += 1
      windows.set(g.key, { shown: n, total: sorted.length })

      // Slide the window by this group's own offset, clamped so it can't run off
      // the end — scrolling past the last concept would show an empty band.
      const maxOff = Math.max(0, sorted.length - n)
      const off = clamp(offsets.get(g.key) ?? 0, 0, maxOff)
      nextOffsets.set(g.key, off)

      for (const c of sorted.slice(off, off + n)) rows.push(conceptRow(c, g.key))

      // Everything outside the window — above AND below — folds into one row, so
      // the events stay visible even while their concepts are scrolled away.
      const rest = [...sorted.slice(0, off), ...sorted.slice(off + n)]
      if (rest.length) {
        rows.push(otherRow(g, rest, off, sorted.length - off - n))
      }
    }
  }

  return { rows, windows, offsets: nextOffsets, classesDropped }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Which detail level a row gets, given how much room its events have.
 *
 * The obvious test — events per pixel — is the wrong one. Clinical events cluster
 * in admissions, so zooming from years to a week barely changes how many are in
 * view while the median gap between them changes by orders of magnitude. Density
 * is about whether marks COLLIDE, so measure the gap, not the count.
 */
export const MIN_GAP_PX = 4
/** Below this many events in view, always draw them individually: overlap only
 *  matters once there are enough marks for it to hide anything. */
export const FEW_EVENTS = 12

export function medianGapPx(timestamps: number[], plotW: number, span: number): number {
  if (timestamps.length < 2) return Infinity
  // A zero or NaN span yields NaN, and `NaN >= MIN_GAP_PX` is false — the row
  // would silently collapse to a density band instead of drawing its events.
  // Infinity is the honest answer: with no span there is no crowding.
  if (!(span > 0)) return Infinity
  const ts = [...timestamps].sort((a, b) => a - b)
  const gaps = new Float64Array(ts.length - 1)
  for (let i = 1; i < ts.length; i++) gaps[i - 1] = ts[i] - ts[i - 1]
  // Typed arrays sort numerically by default. On an even count this takes the
  // upper of the two middle gaps rather than their mean — fine for a threshold.
  gaps.sort()
  return (gaps[gaps.length >> 1] / span) * plotW
}

/**
 * Lead a drug label with the substance rather than the packaging.
 *
 * RxNorm names read "1000 ML sodium chloride 9 MG/ML Injection" — dose first,
 * drug in the middle. The gutter truncates from the right, so the one word that
 * identifies the row is the first thing lost, and a column of drug rows all
 * reads "250 ML sodium…".
 *
 * The quantity and the form move to the end instead of being dropped: 250 ML and
 * 1000 ML sodium chloride are different orders, and on a real record five bags
 * collapse to one identical label if you delete it.
 */
/**
 * Does this label look like an RxNorm-style drug name — quantity, dose form, or
 * a bracketed brand?
 *
 * Triggering on the table's name instead would be a guess about the schema:
 * OMOP calls it "Drug", MIMIC "Prescriptions", and the next model something
 * else. The name's own shape is the thing that actually needs shortening, and it
 * is the same shape wherever it comes from.
 */
export function looksLikeDrugName(name: string): boolean {
  // A leading quantity, or a dose form at the end. NOT a bracketed suffix on its
  // own: LOINC uses brackets too ("Leukocytes [#/volume] in Blood"), and reading
  // that as a brand would mangle every lab name. A brand only counts alongside a
  // strength, which lab names do not carry.
  if (LEADING_QTY_RE.test(name)) return true
  if (DOSE_FORM_RE.test(name)) return true
  return /\[[^\]]+\]\s*$/.test(name) && STRENGTH_RE.test(name)
}

const LEADING_QTY_RE = /^\d+(?:\.\d+)?\s*(?:ML|MG|L|G|UNT|MEQ)\s+/i
/** A dose strength anywhere in the name: "100 UNT/ML", "25 MG". */
const STRENGTH_RE = /\d+(?:\.\d+)?\s*(?:MG|ML|G|UNT|MEQ)(?:\/(?:ML|MG|L|HR))?\b/i
const DOSE_FORM_RE =
  /\s+(Injectable Solution|Prefilled Syringe|Injection|Oral Tablet|Oral Capsule|Oral Solution|Delayed Release Oral Tablet|Extended Release Oral Tablet|Rectal Suppository|Topical Cream|Topical Ointment|Nasal Spray|Ophthalmic Solution|Auto-Injector|Transdermal System|Oral Lozenge|Medicated Patch)\s*$/i

export function shortenDrugName(name: string): string {
  const qty = name.match(/^(\d+(?:\.\d+)?\s*(?:ML|MG|L|G|UNT|MEQ))\s+/i)
  let s = qty ? name.slice(qty[0].length) : name
  const brand = s.match(/\[([^\]]+)\]\s*$/)
  s = s.replace(/\s*\[[^\]]+\]\s*$/, '')
  const form = s.match(DOSE_FORM_RE)
  if (form) s = s.slice(0, -form[0].length)
  if (brand) s = `${s} [${brand[1]}]`
  s = s.trim()
  if (!s) return name
  if (qty) return `${s}, ${qty[1].replace(/\s+/g, ' ')}`
  if (form) return `${s}, ${form[1].toLowerCase()}`
  return s
}

/**
 * Do two labels carry the same words, ignoring order, case and punctuation?
 *
 * Used to decide whether a shortened name is worth repeating in full. Shortening
 * only reorders and re-cases — "… Oral Tablet" becomes "…, oral tablet" — so a
 * plain string comparison reports a difference where no word was actually lost.
 */
export function sameWords(a: string, b: string): boolean {
  const words = (s: string) => {
    const w = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    return w.sort().join(' ')
  }
  return words(a) === words(b)
}

/**
 * Whether a unit already expresses a rate — `mL/h`, `mcg/kg/min`, `U/hr`.
 *
 * When the schema points `valueColumn` at a column that is itself a rate (MIMIC
 * `inputevents.rate`), dividing it by the duration again produces a figure that
 * is wrong by hours and prints as a plausible "0.07 mL/h". The unit string is
 * the only signal available that this has happened, so the caller uses it to
 * withhold the derived rate rather than publish a fabricated one.
 */
export function unitIsRate(unit: string | null | undefined): boolean {
  if (!unit) return false
  return /\/\s*(h|hr|hour|min|minute|sec|second|d|day)\b\.?$/i.test(unit.trim())
}

/**
 * Average rate for a dose spread over a period: quantity per hour, in the dose's
 * own unit.
 *
 * This is an average over the recorded window, NOT a prescribed rate. OMOP's
 * end date is when the order stopped being valid, which for a single
 * administration is not when the drug finished going in: an intramuscular
 * vaccine on a real record spans 57 hours, giving 0.009 mL/h. The standard
 * vocabulary cannot tell those apart — a drip and a bolus are both
 * `Intravenous` — so the caller shows the route beside the figure and lets the
 * reader judge, rather than the code guessing.
 */
export function hourlyRate(
  quantity: number | null,
  startMs: number,
  endMs: number | null,
): number | null {
  if (quantity == null || !(quantity > 0)) return null
  if (endMs == null || !(endMs > startMs)) return null
  const hours = (endMs - startMs) / 3_600_000
  if (!(hours > 0)) return null
  return quantity / hours
}
