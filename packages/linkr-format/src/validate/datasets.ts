/**
 * `datasets/_tree.json` + the CSV files it describes.
 *
 * Validated first and separately because everything else points here: dashboard
 * widgets reference a `datasetFileId` and column ids, and filters reference a
 * `columnId`. A bad dataset tree therefore turns into a cascade of misleading
 * "unknown column" issues elsewhere, so the resolved column table is built once
 * and handed to the other validators.
 */
import { checkArray, checkLocalized, checkString, isObject } from '../check.js'
import { buildColumnIds, isLegacyColumnId } from '../ids.js'
import type { IssueBag } from '../issue.js'
import { listHint } from '../issue.js'
import { editsFileName } from '../layout.js'
import { readJson, type EntityTree } from '../tree.js'

const TREE_PATH = 'datasets/_tree.json'

/**
 * Column types the app understands.
 *
 * `unknown` belongs here: it is what the parser assigns to a column it could not
 * type (an all-empty column, say) and what a column added by an edit starts as, so
 * a perfectly valid export carries it. Leaving it out made a round-trip through
 * export and import report errors on its own output.
 */
const COLUMN_TYPES = ['string', 'number', 'date', 'boolean', 'unknown'] as const

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

    // Editorial metadata, localized like every other authored text in the format.
    // A bare string is still read (checkLocalized warns rather than errors), since
    // datasets exported before the change carry one.
    if (col.label != null) {
      checkLocalized(bag, TREE_PATH, `${p}/label`, col.label, { label: 'column label' })
    }
    if (col.description != null) {
      checkLocalized(bag, TREE_PATH, `${p}/description`, col.description, {
        label: 'column description',
      })
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
    // Silent, not a warning: data files are gitignored by default and re-included
    // one by one through "mark for versioning", so a tree that describes its
    // columns without carrying the rows is the NORMAL, recommended shape — for
    // health data it is the whole point. Reporting it made importing a
    // correctly-anonymised project announce format problems it did not have, which
    // teaches people to ignore the panel that also carries the real errors. The
    // columns themselves are still checked above; only the header cross-check,
    // which has nothing to read, is skipped.
    return
  }

  // A dataset keeps its original upload, so the resolved file is often XLSX or
  // Parquet. Their columns live in a binary structure, not in a first text line:
  // reading one as a header found no delimiters and reported a valid dataset as
  // empty. The columns themselves are still checked above.
  if (isBinaryData(csvPath)) return

  const raw = tree.read(csvPath)
  if (raw == null) return
  const firstLine = raw.split('\n', 1)[0]?.replace(/\r$/, '') ?? ''
  if (!firstLine.trim()) {
    bag.error(csvPath, '', 'csv-header-mismatch', 'The data file is empty.')
    return
  }

  const header = parseCsvHeader(firstLine)
  // A dataset is `raw -> parse -> replay(journal)`, so the tree describes the
  // MATERIALISED columns while the file holds only the raw ones. Comparing the two
  // directly reported every hand-added column as missing — which is exactly what a
  // manual collection is made of, so a perfectly valid export errored on its own
  // output. Fold the journal in first and compare like with like.
  const { added, removed, renamed } = editedColumns(tree, csvPath)
  const declared = columns
    .map((c) => c.name)
    .filter((n) => !added.has(n))
  // A renamed column appears under its new name in the tree and its old one in the
  // file; the journal is what ties the two together.
  const effectiveHeader = header
    .map((n) => renamed.get(n) ?? n)
    .filter((n) => !removed.has(n))

  const missing = declared.filter((n) => !effectiveHeader.includes(n))
  const extra = effectiveHeader.filter((n) => !declared.includes(n) && !added.has(n))

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

/**
 * What the edit journal did to a dataset's COLUMNS, read from `<name>.edits.json`.
 *
 * The journal sits beside the data file and is gitignored with it, so it is often
 * absent — an unversioned dataset carries neither. Everything here degrades to
 * "no edits", which simply restores the plain header comparison.
 *
 * `renamed` maps the file's name to the tree's, since that is the direction the
 * check reads in.
 */
function editedColumns(tree: EntityTree, csvPath: string): {
  added: Set<string>
  removed: Set<string>
  renamed: Map<string, string>
} {
  const empty = { added: new Set<string>(), removed: new Set<string>(), renamed: new Map<string, string>() }
  const slash = csvPath.lastIndexOf('/')
  const dir = slash === -1 ? '' : csvPath.slice(0, slash + 1)
  const raw = tree.read(`${dir}${editsFileName(csvPath.slice(slash + 1))}`)
  if (raw == null) return empty

  let ops: unknown
  try {
    ops = (JSON.parse(raw) as { ops?: unknown }).ops
  } catch {
    // A malformed journal is reported where the journal itself is checked, not
    // here: this check's job is the header, and guessing would turn one problem
    // into a misleading second one.
    return empty
  }
  if (!Array.isArray(ops)) return empty

  const added = new Set<string>()
  const removed = new Set<string>()
  const renamed = new Map<string, string>()
  // Current name per column id. A rename REKEYS (ids derive from names), so an id
  // is only a valid handle until the next rename of that column — following the
  // chain by id is what keeps the first name tied to the last.
  const nameById = new Map<string, string>()
  // The name the FILE holds, for a column that came from the raw file. Hand-added
  // columns are absent here, which is what tells the two apart.
  const fileNameById = new Map<string, string>()

  for (const op of ops) {
    if (!isObject(op)) continue
    const column = typeof op.column === 'string' ? op.column : null
    if (op.type === 'addColumn') {
      const name = typeof op.name === 'string' ? op.name : null
      if (!name) continue
      added.add(name)
      if (column) nameById.set(column, name)
    } else if (op.type === 'removeColumn' && column) {
      const current = nameById.get(column)
      // Removing a column the journal itself added cancels out: it never reached
      // the file, and it is not in the tree either.
      if (current != null && !fileNameById.has(column)) {
        added.delete(current)
        nameById.delete(column)
      } else {
        removed.add(fileNameById.get(column) ?? columnNameGuess(column))
      }
    } else if (op.type === 'renameColumn' && column) {
      // The op carries the NEW id (`to`) and the new name (`toName`) — a rename is
      // a rekey, so the column is addressed by a different id from here on.
      const to = typeof op.to === 'string' ? op.to : null
      const toName = typeof op.toName === 'string' ? op.toName : null
      if (!to || !toName) continue
      const current = nameById.get(column)
      const fromFile = fileNameById.get(column)
      if (current != null && fromFile == null) {
        // A hand-added column renamed: only its latest name reaches the tree.
        added.delete(current)
        added.add(toName)
      } else {
        // A raw column renamed: the file still says the name it was created with.
        renamed.set(fromFile ?? columnNameGuess(column), toName)
        fileNameById.set(to, fromFile ?? columnNameGuess(column))
        fileNameById.delete(column)
      }
      nameById.set(to, toName)
      nameById.delete(column)
    }
  }
  return { added, removed, renamed }
}

/** A column id's source name — ids are `col_<slug of name>`. */
function columnNameGuess(columnId: string): string {
  return columnId.startsWith('col_') ? columnId.slice(4) : columnId
}

/** `"icu_activity.csv"` → `"icu_activity"`. A dataset name may carry its extension. */
function stripExtension(name: string): string {
  return name.replace(/\.(csv|xlsx|parquet|json)$/i, '')
}

function withCsv(name: string): string {
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.csv`
}

/** Data files whose columns cannot be read from a first text line. */
function isBinaryData(path: string): boolean {
  return /\.(xlsx?|parquet|pq)$/i.test(path)
}

/**
 * Data file for a dataset.
 *
 * The layout is `datasets/<folder>/<file>`, where the dataset's `name` may or may
 * not already carry its extension — both forms exist in real trees, so the
 * candidates cover the combinations rather than assuming one.
 */
/**
 * Where a dataset's data file actually lives.
 *
 * Exported because the resolution order is real knowledge, not a validator
 * detail: trees in the wild put the file at `datasets/<name>/<name>.csv`, at
 * `datasets/<name>.csv`, or wherever `entry.path` says — the published
 * icu-activity-dashboard uses the flat form. Anything that has to open the file
 * (the column-rename cascade, for one) must resolve it the same way or it edits
 * the tree and misses the data.
 */
export function findCsv(
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
