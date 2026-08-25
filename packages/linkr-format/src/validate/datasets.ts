/**
 * `datasets/_tree.json` + the CSV files it describes.
 *
 * Validated first and separately because everything else points here: dashboard
 * widgets reference a `datasetFileId` and column ids, and filters reference a
 * `columnId`. A bad dataset tree therefore turns into a cascade of misleading
 * "unknown column" issues elsewhere, so the resolved column table is built once
 * and handed to the other validators.
 */
import { checkArray, checkString, isObject } from '../check.js'
import { buildColumnIds, isLegacyColumnId } from '../ids.js'
import type { IssueBag } from '../issue.js'
import { listHint } from '../issue.js'
import { readJson, type EntityTree } from '../tree.js'

const TREE_PATH = 'datasets/_tree.json'

/** Column types the app understands. */
const COLUMN_TYPES = ['string', 'number', 'date', 'boolean'] as const

export interface DatasetColumn {
  id: string
  name: string
  type?: string
}

export interface DatasetInfo {
  /** The id widgets and filters reference. */
  id: string
  /** Display name, for hints. */
  name: string
  columns: DatasetColumn[]
  columnIds: Set<string>
}

export interface DatasetIndex {
  datasets: Map<string, DatasetInfo>
  /** Every column id across all datasets, for hints when the dataset is unknown. */
  allColumnIds: Set<string>
}

export function emptyDatasetIndex(): DatasetIndex {
  return { datasets: new Map(), allColumnIds: new Set() }
}

/**
 * Validate the dataset tree and return what the dashboard validator needs.
 *
 * Returns an index even when issues were found: a partially valid tree still
 * lets the dashboard checks run and report *their* problems, which is far more
 * useful to someone fixing a project than stopping at the first bad file.
 */
export function validateDatasets(tree: EntityTree, bag: IssueBag): DatasetIndex {
  const index = emptyDatasetIndex()
  const parsed = readJson(tree, TREE_PATH)

  if (!parsed.ok) {
    // Absent is legitimate — a project can have no dataset at all. Present but
    // unparseable is not.
    if (parsed.error !== 'missing') {
      bag.error(TREE_PATH, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
    }
    return index
  }

  const entries = parsed.value
  if (!checkArray(bag, TREE_PATH, '', entries, { required: true, label: 'The dataset tree' })) {
    return index
  }

  const seenIds = new Set<string>()

  entries.forEach((entry, i) => {
    const pointer = `/${i}`
    if (!isObject(entry)) {
      bag.error(TREE_PATH, pointer, 'wrong-type', 'Each tree entry must be an object.')
      return
    }
    if (entry.type === 'folder') return

    if (!checkString(bag, TREE_PATH, `${pointer}/id`, entry.id, { required: true, label: 'id' })) {
      return
    }
    const id = entry.id as string
    if (seenIds.has(id)) {
      bag.error(TREE_PATH, `${pointer}/id`, 'duplicate-key', `Duplicate dataset id "${id}".`)
      return
    }
    seenIds.add(id)

    // A dataset file's name is a plain string, not a LocalizedString (unlike
    // project/dashboard/tab names) — it names a file, not a label.
    checkString(bag, TREE_PATH, `${pointer}/name`, entry.name, { required: true, label: 'name' })

    const columns = validateColumns(bag, pointer, entry.columns, id)
    const info: DatasetInfo = {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      columns,
      columnIds: new Set(columns.map((c) => c.id)),
    }
    index.datasets.set(id, info)
    for (const c of columns) index.allColumnIds.add(c.id)

    validateCsv(tree, bag, id, entry, columns)
  })

  return index
}

function validateColumns(
  bag: IssueBag,
  parentPointer: string,
  raw: unknown,
  datasetId: string,
): DatasetColumn[] {
  const pointer = `${parentPointer}/columns`
  if (!checkArray(bag, TREE_PATH, pointer, raw, { required: true, label: 'columns' })) return []

  const columns: DatasetColumn[] = []
  const pointers: string[] = []
  const seen = new Set<string>()

  raw.forEach((col, i) => {
    const p = `${pointer}/${i}`
    if (!isObject(col)) {
      bag.error(TREE_PATH, p, 'wrong-type', 'Each column must be an object.')
      return
    }
    const okId = checkString(bag, TREE_PATH, `${p}/id`, col.id, { required: true, label: 'Column id' })
    const okName = checkString(bag, TREE_PATH, `${p}/name`, col.name, {
      required: true,
      label: 'Column name',
    })
    if (!okId || !okName) return

    const id = col.id as string
    const name = col.name as string

    if (seen.has(id)) {
      bag.error(TREE_PATH, `${p}/id`, 'duplicate-key', `Duplicate column id "${id}" in "${datasetId}".`)
      return
    }
    seen.add(id)

    if (col.type != null && !COLUMN_TYPES.includes(col.type as (typeof COLUMN_TYPES)[number])) {
      bag.error(TREE_PATH, `${p}/type`, 'wrong-type', `Unknown column type "${String(col.type)}".`,
        `allowed: ${COLUMN_TYPES.join(', ')}`)
    }

    columns.push({ id, name, type: typeof col.type === 'string' ? col.type : undefined })
    pointers.push(p)
  })

  checkDerivedIds(bag, columns, pointers)
  return columns
}

/**
 * Every id must be what the app would derive from the column NAMES, in order.
 *
 * Checked over the whole list rather than one id at a time because collision
 * suffixes (`_2`, `_3`) are handed out in header order: two names normalising to
 * the same slug are only correct in one arrangement, and validating each id
 * alone would accept them swapped — after which the app re-derives the other id
 * and orphans every filter and widget config pointing here.
 *
 * A legacy `col-<n>` id is reported apart: the app can still read it (there is a
 * rescue path keyed by name) but it is not reproducible, so a re-export renames
 * it.
 */
function checkDerivedIds(bag: IssueBag, columns: DatasetColumn[], pointers: string[]): void {
  const expected = buildColumnIds(columns.map((c) => c.name))
  columns.forEach((col, i) => {
    if (isLegacyColumnId(col.id)) {
      bag.warn(TREE_PATH, `${pointers[i]}/id`, 'legacy-format',
        `Column id "${col.id}" is a legacy positional id.`,
        `the deterministic id for "${col.name}" is "${expected[i]}"`)
      return
    }
    if (col.id !== expected[i]) {
      bag.error(TREE_PATH, `${pointers[i]}/id`, 'column-id-mismatch',
        `Column id "${col.id}" does not match its name "${col.name}".`,
        `expected "${expected[i]}"`)
    }
  })
}

/**
 * Cross-check the declared columns against the CSV header.
 *
 * This is the check that catches the failure mode where a dataset imports as
 * empty: the tree and the data file disagree, and nothing in the app says so —
 * the dashboard simply renders "no dataset".
 */
function validateCsv(
  tree: EntityTree,
  bag: IssueBag,
  datasetId: string,
  entry: Record<string, unknown>,
  columns: DatasetColumn[],
): void {
  if (columns.length === 0) return

  const name = typeof entry.name === 'string' ? entry.name : datasetId
  const csvPath = findCsv(tree, datasetId, name, entry)
  if (!csvPath) {
    // Not an error: data files are gitignored by default and re-included per
    // file through "mark for versioning", so a git-tracked tree legitimately
    // describes its columns without carrying the rows. The columns themselves
    // are still checked above — only the header cross-check is skipped.
    const folder = stripExtension(name)
    bag.warn('datasets/', '', 'missing-file',
      `No data file for dataset "${name}"; its columns cannot be cross-checked.`,
      `expected datasets/${folder}/${withCsv(name)} (normal if data is gitignored)`)
    return
  }

  const raw = tree.read(csvPath)
  if (raw == null) return
  const firstLine = raw.split('\n', 1)[0]?.replace(/\r$/, '') ?? ''
  if (!firstLine.trim()) {
    bag.error(csvPath, '', 'csv-header-mismatch', 'The data file is empty.')
    return
  }

  const header = parseCsvHeader(firstLine)
  const declared = columns.map((c) => c.name)

  const missing = declared.filter((n) => !header.includes(n))
  const extra = header.filter((n) => !declared.includes(n))

  if (missing.length > 0) {
    bag.error(csvPath, '', 'csv-header-mismatch',
      `${missing.length} column(s) declared in the tree are absent from the data file.`,
      listHint('missing', missing))
  }
  if (extra.length > 0) {
    bag.error(csvPath, '', 'csv-header-mismatch',
      `${extra.length} column(s) in the data file are not declared in the tree.`,
      listHint('undeclared', extra))
  }
}

/** `"icu_activity.csv"` → `"icu_activity"`. A dataset name may carry its extension. */
function stripExtension(name: string): string {
  return name.replace(/\.(csv|xlsx|parquet|json)$/i, '')
}

function withCsv(name: string): string {
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.csv`
}

/**
 * Data file for a dataset.
 *
 * The layout is `datasets/<folder>/<file>`, where the dataset's `name` may or may
 * not already carry its extension — both forms exist in real trees, so the
 * candidates cover the combinations rather than assuming one.
 */
function findCsv(
  tree: EntityTree,
  datasetId: string,
  name: string,
  entry: Record<string, unknown>,
): string | null {
  const folder = stripExtension(name)
  const file = withCsv(name)
  const candidates = [
    typeof entry.path === 'string' ? `datasets/${entry.path}` : null,
    `datasets/${folder}/${file}`,
    `datasets/${file}`,
    `datasets/${datasetId}`,
    `datasets/${stripExtension(datasetId)}/${withCsv(datasetId)}`,
  ].filter((p): p is string => p != null)

  for (const c of candidates) {
    if (tree.read(c) != null) return c
  }
  // Last resort: a single data file inside the dataset's own folder, whatever its name.
  const inFolder = tree
    .paths()
    .filter((p) => p.startsWith(`datasets/${folder}/`) && /\.(csv|tsv)$/i.test(p))
  return inFolder.length === 1 ? inFolder[0] : null
}

/** Header fields only — quoted, comma-separated, doubled quotes escaped. */
function parseCsvHeader(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}
