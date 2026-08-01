/**
 * Goupile eCRF import: turn a Goupile XLSX export (multi-sheet) into one wide
 * Linkr dataset, auto-labelled from the export's embedded data dictionary.
 *
 * A Goupile export has one data sheet per form (each starting with the system
 * columns `__tid`/`__sequence`/`__hid`, then the form's variables) plus two
 * dictionary sheets: `@definitions` (variable → label + type) and `@propositions`
 * (categorical code → label). Multi-select variables are one-hot exploded into
 * `variable.prop` columns valued 0/1; missing values are the literal `'NA'`.
 *
 * This module is pure (it takes already-parsed sheet rows, not a File), so it is
 * unit-tested against real exports. The UI (UploadDatasetDialog) reads the workbook
 * with SheetJS, calls `parseGoupileWorkbook`, then feeds the result to the normal
 * dataset-create path and pushes the metadata via POST /dataset-files/columns/meta.
 *
 * Design: docs/planning/goupile-import-plan.md
 */

/** System columns Goupile prefixes every data sheet with. `__tid` is the join key. */
export const GOUPILE_SYSTEM_COLUMNS = ['__tid', '__sequence', '__hid'] as const

const DEFINITIONS_SHEET = '@definitions'
const PROPOSITIONS_SHEET = '@propositions'

/** A cell value Goupile writes as the literal string "NA" is a missing value. */
function denaturalize(value: unknown): unknown {
  return value === 'NA' ? null : value
}

export interface GoupileColumnMeta {
  label?: string
  description?: string
  valueLabels?: Record<string, string>
}

export interface GoupileParseResult {
  /** Wide column names in order (system columns first, then per-form variables). */
  columns: string[]
  /** Joined rows keyed by column name (one row per distinct __tid). */
  rows: Record<string, unknown>[]
  /** Editorial metadata per column name (label/description/valueLabels). */
  columnMeta: Record<string, GoupileColumnMeta>
}

/** Sheets as SheetJS `sheet_to_json` yields them: name → array of row objects. */
export type SheetMap = Record<string, Record<string, unknown>[]>

/**
 * A workbook is a Goupile export when it carries both dictionary sheets. Detection
 * is a suggestion (the UI lets the user opt out), not a hard requirement.
 */
export function isGoupileWorkbook(sheetNames: string[]): boolean {
  return sheetNames.includes(DEFINITIONS_SHEET) && sheetNames.includes(PROPOSITIONS_SHEET)
}

interface Definition {
  label: string
  type: string // 'text' | 'number' | 'enum' | 'multi'
}

/** `@definitions` rows → { "<table><variable>": {label, type} }. */
function readDefinitions(rows: Record<string, unknown>[]): Map<string, Definition> {
  const map = new Map<string, Definition>()
  for (const r of rows) {
    const table = String(r.table ?? '')
    const variable = String(r.variable ?? '')
    if (!variable) continue
    map.set(`${table}\t${variable}`, {
      label: r.label != null ? String(r.label) : '',
      type: r.type != null ? String(r.type) : '',
    })
  }
  return map
}

/** `@propositions` rows → { "<table><variable>": { code: label } }. */
function readPropositions(rows: Record<string, unknown>[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>()
  for (const r of rows) {
    const table = String(r.table ?? '')
    const variable = String(r.variable ?? '')
    const prop = r.prop
    if (!variable || prop == null) continue
    const key = `${table}\t${variable}`
    const entry = map.get(key) ?? {}
    entry[String(prop)] = r.label != null ? String(r.label) : String(prop)
    map.set(key, entry)
  }
  return map
}

/**
 * Join every data sheet on `__tid` into one wide dataset and derive column
 * metadata from the dictionary sheets.
 *
 * @param sheets       all workbook sheets (data + `@definitions`/`@propositions`)
 * @param systemLabels display labels for `__tid`/`__sequence`/`__hid` (i18n by the caller)
 */
export function parseGoupileWorkbook(
  sheets: SheetMap,
  systemLabels: Partial<Record<(typeof GOUPILE_SYSTEM_COLUMNS)[number], string>> = {},
): GoupileParseResult {
  const defs = readDefinitions(sheets[DEFINITIONS_SHEET] ?? [])
  const props = readPropositions(sheets[PROPOSITIONS_SHEET] ?? [])

  // Data sheets = every sheet whose name does not start with '@', in workbook order.
  const dataSheetNames = Object.keys(sheets).filter((n) => !n.startsWith('@'))

  // First pass: figure out which non-system column names collide across ≥2 forms,
  // so we can prefix ONLY those (recours_mir.remarques vs perspectives.remarques).
  const nameOccurrences = new Map<string, Set<string>>()
  for (const sheetName of dataSheetNames) {
    const rows = sheets[sheetName] ?? []
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    for (const h of headers) {
      if ((GOUPILE_SYSTEM_COLUMNS as readonly string[]).includes(h)) continue
      const set = nameOccurrences.get(h) ?? new Set<string>()
      set.add(sheetName)
      nameOccurrences.set(h, set)
    }
  }
  const collides = (name: string) => (nameOccurrences.get(name)?.size ?? 0) > 1

  // The wide column name for a raw variable in a given form (collision-only prefix,
  // dot separator to match Goupile's own `var.prop` one-hot dotting).
  const wideName = (sheetName: string, rawName: string) =>
    collides(rawName) ? `${sheetName}.${rawName}` : rawName

  // Build the ordered column list + metadata, and accumulate rows keyed by __tid.
  const columns: string[] = [...GOUPILE_SYSTEM_COLUMNS]
  const columnMeta: Record<string, GoupileColumnMeta> = {}
  for (const sys of GOUPILE_SYSTEM_COLUMNS) {
    if (systemLabels[sys]) columnMeta[sys] = { label: systemLabels[sys] }
  }

  const byTid = new Map<string, Record<string, unknown>>()
  const tidOrder: string[] = []

  for (const sheetName of dataSheetNames) {
    const rows = sheets[sheetName] ?? []
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    const variableHeaders = headers.filter(
      (h) => !(GOUPILE_SYSTEM_COLUMNS as readonly string[]).includes(h),
    )

    // Register this sheet's columns (once) with their dictionary metadata.
    for (const raw of variableHeaders) {
      const wide = wideName(sheetName, raw)
      if (!columns.includes(wide)) columns.push(wide)
      columnMeta[wide] = deriveColumnMeta(sheetName, raw, defs, props)
    }

    // Merge each row into the joined table by __tid.
    for (const row of rows) {
      const tid = row.__tid != null ? String(row.__tid) : ''
      if (!tid) continue // a data sheet with no __tid can't be joined; skip the row
      let target = byTid.get(tid)
      if (!target) {
        target = {}
        byTid.set(tid, target)
        tidOrder.push(tid)
      }
      // System columns: take the first non-null seen (all sheets of a thread agree).
      for (const sys of GOUPILE_SYSTEM_COLUMNS) {
        if (target[sys] == null && row[sys] != null) target[sys] = denaturalize(row[sys])
      }
      for (const raw of variableHeaders) {
        target[wideName(sheetName, raw)] = denaturalize(row[raw])
      }
    }
  }

  const rows = tidOrder.map((tid) => {
    const merged = byTid.get(tid)!
    // Ensure every column key exists on every row (nulls for absent forms).
    const full: Record<string, unknown> = {}
    for (const col of columns) full[col] = merged[col] ?? null
    return full
  })

  return { columns, rows, columnMeta }
}

/**
 * Metadata for one wide column from the dictionary:
 * - one-hot `<var>.<prop>` (parent is a `multi`): label = the proposition label,
 *   description = the parent question label. It's a 0/1 flag, so no valueLabels.
 * - plain `enum`: label = the variable label, valueLabels = its propositions.
 * - plain number/text: label = the variable label.
 */
function deriveColumnMeta(
  table: string,
  rawName: string,
  defs: Map<string, Definition>,
  props: Map<string, Record<string, string>>,
): GoupileColumnMeta {
  // One-hot column? Its raw name is `<variable>.<prop>` and `<variable>` is a multi.
  const dot = rawName.indexOf('.')
  if (dot > 0) {
    const parentVar = rawName.slice(0, dot)
    const prop = rawName.slice(dot + 1)
    const parentDef = defs.get(`${table}\t${parentVar}`)
    if (parentDef?.type === 'multi') {
      const propLabels = props.get(`${table}\t${parentVar}`)
      const meta: GoupileColumnMeta = {}
      const propLabel = propLabels?.[prop]
      if (propLabel) meta.label = propLabel
      if (parentDef.label) meta.description = parentDef.label
      return meta
    }
  }

  const def = defs.get(`${table}\t${rawName}`)
  if (!def) return {}
  const meta: GoupileColumnMeta = {}
  if (def.label) meta.label = def.label
  if (def.type === 'enum') {
    const valueLabels = props.get(`${table}\t${rawName}`)
    if (valueLabels && Object.keys(valueLabels).length > 0) meta.valueLabels = { ...valueLabels }
  }
  return meta
}
