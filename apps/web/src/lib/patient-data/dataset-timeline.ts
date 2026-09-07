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

/** How a dataset's columns map onto a timeline series. */
export interface DatasetTimelineMapping {
  datasetFileId: string
  /** Column holding the person id, matched against the selected patient. */
  personColumn: string
  /**
   * Column holding the visit id. Optional: a dataset collected per patient rather
   * than per stay has none, and is then shown for every visit of that patient.
   */
  visitColumn?: string
  /** Column holding the event date (or its start, when `endColumn` is set). */
  dateColumn: string
  /** Column holding the end of an event that lasts — drawn as a block, not a point. */
  endColumn?: string
  /** Column holding the numeric value. Absent = an event with no measurement. */
  valueColumn?: string
  /** Column whose value names the series. Absent = every row is one series. */
  labelColumn?: string
  /** Series name when `labelColumn` is unset. */
  seriesName?: string
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
  patient: { personId: string | null; visitId: string | null },
  fallbackName: string,
): DatasetTimelineRow[] {
  if (!patient.personId || !mapping.personColumn || !mapping.dateColumn) return []

  const seriesIds = new Map<string, number>()
  const out: DatasetTimelineRow[] = []

  for (const row of rows) {
    if (!sameId(row[mapping.personColumn], patient.personId)) continue
    // A dataset with no visit column is per-patient, so it shows on every visit.
    if (mapping.visitColumn && patient.visitId && !sameId(row[mapping.visitColumn], patient.visitId)) {
      continue
    }

    const eventDate = normaliseDate(row[mapping.dateColumn])
    if (eventDate == null) continue

    const name = mapping.labelColumn
      ? String(row[mapping.labelColumn] ?? fallbackName)
      : (mapping.seriesName || fallbackName)

    let seriesId = seriesIds.get(name)
    if (seriesId === undefined) {
      seriesId = datasetSeriesId(seriesIds.size)
      seriesIds.set(name, seriesId)
    }

    const rawValue = mapping.valueColumn ? row[mapping.valueColumn] : undefined
    const numeric = toNumber(rawValue)

    out.push({
      concept_id: seriesId,
      concept_name: name,
      // A row with no numeric value is still an event in time; the timeline reads
      // `value_string` for those and draws a marker rather than a curve point.
      value: numeric ?? 1,
      value_string: numeric == null && rawValue != null ? String(rawValue) : null,
      event_date: eventDate,
      ...(mapping.endColumn ? { end_date: normaliseDate(row[mapping.endColumn]) ?? undefined } : {}),
    })
  }

  // The timeline expects chronological rows (its OMOP query ends in ORDER BY).
  out.sort((a, b) => Number(a.event_date) - Number(b.event_date))
  return out
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
