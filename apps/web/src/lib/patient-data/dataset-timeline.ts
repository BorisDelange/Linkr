/**
 * Plotting a dataset on the patient timeline, beside the OMOP concepts.
 *
 * The point is comparison: a manually collected variable (ventilation start/end
 * recorded by hand) drawn on the SAME axis as what the warehouse holds, so the two
 * can be read against each other rather than in two windows.
 *
 * A dataset is not OMOP, so nothing here can be inferred from a schema mapping:
 * the widget's config names which column identifies the patient, which carries the
 * date, and which the value. This module turns those choices plus the dataset's
 * rows into the row shape the timeline already draws.
 */

/**
 * How a dataset's columns map onto timeline series.
 *
 * The roles mirror what an OMOP event table carries, because that is what the
 * timeline already knows how to draw: who, when, until when, how much, and which
 * series the row belongs to. A dataset has no schema mapping to infer them from, so
 * they are declared here — one mapping per dataset plotted on the widget.
 */
export interface DatasetTimelineMapping {
  datasetFileId: string
  /** Column holding the person id, matched against the selected patient. */
  personColumn: string
  /**
   * Column holding the visit id. Optional: a dataset collected per patient rather
   * than per stay has none, and is then shown for every visit of that patient.
   */
  visitColumn?: string
  /** Column holding the unit-stay id, for a dataset collected per stay. */
  visitDetailColumn?: string
  /** Column holding the event date (or its start, when `endColumn` is set). */
  dateColumn: string
  /** Column holding the end of an event that lasts — drawn as a block, not a point. */
  endColumn?: string
  /** Column holding the numeric value. Absent = an event with no measurement. */
  valueColumn?: string
  /** Column holding a textual value, for a row whose result is not a number. */
  textValueColumn?: string
  /**
   * Column holding a code identifying what the row measures.
   *
   * This is what rows are GROUPED BY: one series per distinct code, the way the
   * warehouse gives one series per concept. `labelColumn` names those series when
   * present; with neither, the whole dataset is one series.
   */
  conceptCodeColumn?: string
  /** Column whose value names the series. Absent = every row is one series. */
  labelColumn?: string
  /** Series name when neither `conceptCodeColumn` nor `labelColumn` is set. */
  seriesName?: string
  /**
   * The codes to plot, out of those the dataset holds.
   *
   * Required, not a convenience: a dataset routinely carries hundreds of distinct
   * codes, and drawing them all would make the chart unreadable and the query
   * pointless. An empty list therefore plots NOTHING — the widget is not configured
   * until something is picked, exactly as a timeline with no concept selected draws
   * nothing.
   */
  codes?: string[]
}

/** The subset of the timeline's row shape a dataset can fill. */
export interface DatasetTimelineRow {
  concept_id: number
  concept_name: string
  value: number
  value_string?: string | null
  unit?: string | null
  event_date: unknown
  end_date?: unknown
}

/**
 * Synthetic concept ids for dataset series.
 *
 * The timeline keys its series, colors and legend by `concept_id`, so a dataset
 * series needs one — but it must never collide with a real OMOP concept id. OMOP
 * ids are positive (locally-minted ones live in the 2-billion range), so negative
 * ids are free by construction, exactly as negative row ordinals are in the edit
 * log.
 */
export function datasetSeriesId(seriesIndex: number): number {
  return -(seriesIndex + 1)
}

/**
 * A stable synthetic id for one series of one dataset.
 *
 * Derived from the dataset and the series key rather than from the order the rows
 * happen to arrive in: a positional id changes with the patient on screen (a patient
 * missing the first code shifts every other series up one), which would move the
 * colours the user picked from one series to another. Hashing the pair keeps a
 * series' id — and so its colour — the same for every patient.
 *
 * Collisions are possible in principle and harmless in practice: two series sharing
 * an id would share a colour, not corrupt any data. The range is kept well inside
 * Number.MAX_SAFE_INTEGER and strictly negative, so it can never meet an OMOP id.
 */
export function datasetSeriesKeyId(datasetFileId: string, seriesKey: string): number {
  const input = `${datasetFileId}\u0000${seriesKey}`
  // FNV-1a, 32-bit: short, dependency-free, and well spread for short strings.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // >>> 0 first: `hash` is a signed 32-bit int here, and negating a negative one
  // would mint a POSITIVE id that collides with the OMOP vocabulary.
  return -((hash >>> 0) + 1)
}

/** Whether a series id was minted here rather than coming from the vocabulary. */
export function isDatasetSeriesId(conceptId: number): boolean {
  return conceptId < 0
}

/**
 * Turn dataset rows into timeline rows for one patient.
 *
 * Rows that don't concern the selected patient (or visit, when the mapping names a
 * visit column) are dropped, as are rows with no usable date — a row that cannot
 * be placed in time has no meaning on a timeline.
 */
export function datasetRowsToTimeline(
  rows: readonly Record<string, unknown>[],
  mapping: DatasetTimelineMapping,
  patient: { personId: string | null; visitId: string | null; visitDetailId?: string | null },
  fallbackName: string,
): DatasetTimelineRow[] {
  if (!patient.personId || !mapping.personColumn || !mapping.dateColumn) return []
  // Nothing picked plots nothing: see `codes` on the mapping.
  const wanted = mapping.codes
  if (groupsByCode(mapping) && (!wanted || wanted.length === 0)) return []
  const wantedSet = wanted ? new Set(wanted) : null

  const out: DatasetTimelineRow[] = []

  for (const row of rows) {
    if (!sameId(row[mapping.personColumn], patient.personId)) continue
    // A dataset with no visit column is per-patient, so it shows on every visit.
    if (mapping.visitColumn && patient.visitId && !sameId(row[mapping.visitColumn], patient.visitId)) {
      continue
    }
    if (mapping.visitDetailColumn && patient.visitDetailId
      && !sameId(row[mapping.visitDetailColumn], patient.visitDetailId)) {
      continue
    }

    const eventDate = normaliseDate(row[mapping.dateColumn])
    if (eventDate == null) continue

    const key = seriesKeyOf(row, mapping)
    if (wantedSet && !wantedSet.has(key)) continue

    const name = seriesNameOf(row, mapping, fallbackName)
    const seriesId = datasetSeriesKeyId(mapping.datasetFileId, key)

    const rawValue = mapping.valueColumn ? row[mapping.valueColumn] : undefined
    const numeric = toNumber(rawValue)
    const rawText = mapping.textValueColumn ? row[mapping.textValueColumn] : undefined

    out.push({
      concept_id: seriesId,
      concept_name: name,
      // A row with no numeric value is still an event in time; the timeline reads
      // `value_string` for those and draws a marker rather than a curve point.
      value: numeric ?? 1,
      // The dedicated text column wins when there is one: a row with both a number
      // and a label means the label describes the number, not that it is missing.
      value_string: rawText != null && rawText !== ''
        ? String(rawText)
        : (numeric == null && rawValue != null ? String(rawValue) : null),
      event_date: eventDate,
      ...(mapping.endColumn ? { end_date: normaliseDate(row[mapping.endColumn]) ?? undefined } : {}),
    })
  }

  // The timeline expects chronological rows (its OMOP query ends in ORDER BY).
  out.sort((a, b) => Number(a.event_date) - Number(b.event_date))
  return out
}

/** Whether this mapping splits its rows into series, or is one series in total. */
export function groupsByCode(mapping: DatasetTimelineMapping): boolean {
  return !!(mapping.conceptCodeColumn || mapping.labelColumn)
}

/**
 * The key identifying a row's series: its code, else its label, else the whole
 * dataset. The CODE takes precedence — a label is a display name and two codes can
 * legitimately share one, which would silently merge two series into one.
 */
export function seriesKeyOf(
  row: Record<string, unknown>,
  mapping: DatasetTimelineMapping,
): string {
  if (mapping.conceptCodeColumn) return String(row[mapping.conceptCodeColumn] ?? '')
  if (mapping.labelColumn) return String(row[mapping.labelColumn] ?? '')
  return ''
}

/** What a series is called on the chart and in the legend. */
export function seriesNameOf(
  row: Record<string, unknown>,
  mapping: DatasetTimelineMapping,
  fallbackName: string,
): string {
  if (mapping.labelColumn) {
    const label = row[mapping.labelColumn]
    if (label != null && label !== '') return String(label)
  }
  const key = seriesKeyOf(row, mapping)
  return key || mapping.seriesName || fallbackName
}

/** One selectable series of a dataset, with how much of the dataset it accounts for. */
export interface DatasetSeriesOption {
  /** The code (or label) rows are grouped by — what `mapping.codes` holds. */
  code: string
  /** Display name: the label when the dataset has one, else the code itself. */
  name: string
  /** Distinct patients holding at least one row of this series. */
  patientCount: number
  /** Rows of this series, across every patient. */
  recordCount: number
}

/**
 * The series a dataset offers, with their counts over the WHOLE dataset.
 *
 * Counted across every patient, not the one on screen: the point of the list is to
 * decide what is worth plotting at all, and a code absent from the current patient
 * is exactly the sort of thing that still belongs on the widget.
 *
 * Rows with no usable date are excluded — they cannot be drawn, so counting them
 * would promise series the timeline then renders empty.
 */
export function datasetSeriesOptions(
  rows: readonly Record<string, unknown>[],
  mapping: DatasetTimelineMapping,
): DatasetSeriesOption[] {
  if (!mapping.personColumn || !mapping.dateColumn) return []

  const byCode = new Map<string, { name: string; patients: Set<string>; rows: number }>()
  for (const row of rows) {
    if (normaliseDate(row[mapping.dateColumn]) == null) continue
    const code = seriesKeyOf(row, mapping)
    let entry = byCode.get(code)
    if (!entry) {
      entry = { name: seriesNameOf(row, mapping, code), patients: new Set(), rows: 0 }
      byCode.set(code, entry)
    }
    entry.rows += 1
    const person = row[mapping.personColumn]
    if (person != null && person !== '') entry.patients.add(String(person))
  }

  return [...byCode.entries()]
    .map(([code, e]) => ({
      code,
      name: e.name,
      patientCount: e.patients.size,
      recordCount: e.rows,
    }))
    // Commonest first: the series worth plotting are usually the well-populated ones.
    .sort((a, b) => b.recordCount - a.recordCount || a.name.localeCompare(b.name))
}

/** Ids cross the SQL/JSON boundary as numbers or strings, so compare as text. */
function sameId(cell: unknown, id: string): boolean {
  if (cell == null) return false
  return String(cell) === id
}

/**
 * A cell as a Date, or null when it holds nothing plottable.
 *
 * Dataset cells are far more varied than a warehouse column: a CSV gives strings,
 * Parquet gives Dates or epoch numbers, and a hand-typed cell gives whatever the
 * clinician wrote.
 */
function normaliseDate(cell: unknown): Date | null {
  if (cell == null || cell === '') return null
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell
  if (typeof cell === 'bigint') return new Date(Number(cell / 1000n))
  if (typeof cell === 'number') return new Date(cell)
  const parsed = new Date(String(cell))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toNumber(cell: unknown): number | null {
  if (cell == null || cell === '' || typeof cell === 'boolean') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * The dataset mappings a timeline config carries, new shape or old.
 *
 * A widget configured before multi-dataset support holds a single `dataset`. Folding
 * it in here — rather than migrating stored configs — means an untouched widget is
 * never rewritten, so a project's git diff stays empty until someone actually edits
 * the widget.
 */
export function timelineDatasets(config: {
  datasets?: Partial<DatasetTimelineMapping>[]
  dataset?: Partial<DatasetTimelineMapping>
}): Partial<DatasetTimelineMapping>[] {
  // PRESENCE of the new key wins, empty or not. Falling back on emptiness instead
  // would resurrect the legacy `dataset` the moment someone removed the last one
  // from a widget configured before multi-dataset support: the config still carries
  // the old key, and the removal would silently undo itself.
  if (config.datasets) return config.datasets
  return config.dataset ? [config.dataset] : []
}
