/**
 * Tool implementations: disk I/O plus the incremental edits, over `@linkr/format`.
 *
 * Kept apart from server.ts so they are testable without speaking JSON-RPC. The
 * rule from the plan holds here too — no format knowledge. Editing an existing
 * tree does read and rewrite dashboard JSON, but it only ever *places* records
 * whose shape and keys come from the format package.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  columnId, formatIssues, slugify, validateProject, type CopyFile, type WriteFile,
} from '@linkr/format'
import { FsTree } from '@linkr/format/node/fs-tree'

/**
 * Resolve `relativePath` inside `root`, refusing anything that escapes it.
 *
 * Every write in this file goes through here. Without it a `..` segment in a
 * caller-supplied path writes anywhere the server process can reach — and the
 * caller is a language model acting on text it was given, which may include
 * text the operator did not write. The server therefore never trusts a path,
 * exactly as it never trusts a tool name.
 *
 * `relative()` rather than a `startsWith` check on the prefix: `/tmp/proj-evil`
 * starts with `/tmp/proj` but is not inside it.
 */
function resolveInside(root: string, relativePath: string): string {
  const base = resolve(root)
  const full = resolve(base, relativePath)
  const rel = relative(base, full)
  if (rel.startsWith('..') || resolve(base, rel) !== full) {
    throw new Error(`Path "${relativePath}" escapes the project directory.`)
  }
  return full
}

export function writeTree(root: string, files: WriteFile[]): string[] {
  for (const file of files) {
    const full = resolveInside(root, file.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, file.content, 'utf-8')
  }
  return files.map((f) => f.path)
}

/**
 * Data files are gitignored by default, and re-included per file by the app's
 * "mark for versioning" action. A generated project ships the same rule so a
 * tree that lands in git does not carry its datasets by accident.
 */
/**
 * Copy the binary files a serializer declared, returning their total size.
 *
 * The destination is confined like every other write; the *source* is not, on
 * purpose — it is the operator's own file being published, and refusing paths
 * outside the target would make it impossible to package data that lives
 * anywhere but next to the repo.
 */
export function copyFiles(root: string, copies: CopyFile[]): { paths: string[]; bytes: number } {
  let bytes = 0
  for (const copy of copies) {
    const from = resolve(copy.source)
    let size: number
    try {
      size = statSync(from).size
    } catch {
      throw new Error(`Cannot read "${copy.source}" (for ${copy.path}): no such file.`)
    }
    const to = resolveInside(root, copy.path)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    bytes += size
  }
  return { paths: copies.map((c) => c.path), bytes }
}

/** Human-readable byte size, for a result line the user actually reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export const DEFAULT_GITIGNORE = 'datasets/**/*.csv\ndatasets/**/*.parquet\n.cache/\n'

/**
 * Bundle a tree as a ZIP, for the app's "Import a project" dialog.
 *
 * A folder is the better default — it is what the portal and the
 * linkr-public-content repos consume, and it diffs in git. A ZIP is what the
 * import dialog takes, so both are offered rather than forcing the author to
 * zip by hand and risk a wrapping directory the parser then has to strip.
 */
export async function writeZip(target: string, files: WriteFile[]): Promise<number> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const file of files) zip.file(file.path, file.content)
  zip.file('.gitignore', DEFAULT_GITIGNORE)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  mkdirSync(dirname(resolve(target)), { recursive: true })
  writeFileSync(resolve(target), buffer)
  return files.length + 1
}

function readJson<T>(root: string, path: string): T {
  try {
    return JSON.parse(readFileSync(resolveInside(root, path), 'utf-8')) as T
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${(e as Error).message}`)
  }
}

function writeJson(root: string, path: string, value: unknown): void {
  const full = resolveInside(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

/** Re-validate after an edit, so a tool result always says whether the tree still holds. */
function revalidate(root: string, summary: string): string {
  const issues = validateProject(new FsTree(root))
  if (issues.length === 0) return `${summary} Tree is valid.`
  const errors = issues.filter((i) => i.severity === 'error').length
  return errors === 0
    ? `${summary} Tree is valid (${issues.length} warning(s)).`
    : `${summary}\n\n${errors} error(s) now in the tree:\n${formatIssues(issues)}`
}

interface DashboardDoc {
  dashboard: Record<string, unknown>
  tabs: { name: unknown; key?: string; parentKey?: string | null; displayOrder?: number }[]
  widgets: {
    name: unknown
    key?: string
    tabKey?: string
    datasetFileId?: string
    layout: { x: number; y: number; w: number; h: number }
    source: { type: string; pluginId?: string; config?: Record<string, unknown> }
  }[]
}

interface DatasetEntry {
  id: string
  name: string
  columns?: { id: string; name: string; type?: string }[]
  rowCount?: number
}

/**
 * `dashboards/<name>.json` from a caller-supplied name.
 *
 * The name is reduced to a single path segment before it is used: it reaches
 * `readJson`/`writeJson`, which confine it to the project root, but a name is
 * never meant to carry a directory in the first place and rejecting it here says
 * so plainly instead of failing later with a confusing escape error.
 */
function dashboardPath(dashboard: string): string {
  const name = dashboard.replace(/\.json$/, '')
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '') {
    throw new Error(`Invalid dashboard name "${dashboard}" — it must be a file name, not a path.`)
  }
  return `dashboards/${name}.json`
}

/** Human-readable inventory: what exists, with the ids and keys to address it. */
export function describeTree(root: string): string {
  const tree = new FsTree(root)
  const lines: string[] = []

  const projectRaw = tree.read('project.json')
  if (!projectRaw) throw new Error(`No project.json in ${root}.`)
  const project = JSON.parse(projectRaw) as { name?: unknown; projectId?: string }
  lines.push(`Project: ${JSON.stringify(project.name)} (${project.projectId ?? 'no projectId'})`)

  const datasetsRaw = tree.read('datasets/_tree.json')
  lines.push('', 'Datasets:')
  if (!datasetsRaw) lines.push('  (none)')
  else {
    for (const d of JSON.parse(datasetsRaw) as DatasetEntry[]) {
      lines.push(`  ${d.id} — ${d.rowCount ?? '?'} rows`)
      for (const c of d.columns ?? []) lines.push(`    ${c.id} (${c.name}, ${c.type ?? 'string'})`)
    }
  }

  lines.push('', 'Dashboards:')
  const dashboards = tree.paths().filter((p) => p.startsWith('dashboards/') && p.endsWith('.json'))
  if (dashboards.length === 0) lines.push('  (none)')
  for (const path of dashboards) {
    const doc = JSON.parse(tree.read(path)!) as DashboardDoc
    lines.push(`  ${path}`)
    for (const tab of doc.tabs) {
      lines.push(`    tab ${tab.key ?? '(no key)'} — ${JSON.stringify(tab.name)}`)
      for (const w of doc.widgets.filter((x) => x.tabKey === tab.key)) {
        lines.push(`      widget ${w.key} — ${JSON.stringify(w.name)} [${w.source.pluginId ?? w.source.type}]`)
      }
    }
  }

  const scripts = tree.paths().filter((p) => p.startsWith('scripts/') && !p.endsWith('_tree.json'))
  lines.push('', 'Scripts:')
  lines.push(scripts.length ? scripts.map((s) => `  ${s}`).join('\n') : '  (none)')

  return lines.join('\n')
}

export function addDashboardTab(
  root: string,
  dashboard: string,
  name: Record<string, string>,
  parent?: string,
): string {
  const path = dashboardPath(dashboard)
  const doc = readJson<DashboardDoc>(root, path)
  const label = name.en || Object.values(name)[0] || ''
  if (!label) throw new Error('The tab needs a name.')

  if (parent && !doc.tabs.some((t) => t.key === parent)) {
    throw new Error(
      `Unknown parent tab "${parent}". Known: ${doc.tabs.map((t) => t.key).join(', ') || 'none'}.`,
    )
  }

  // Same key scheme as the exporter: `<dashboard-or-parent>/<slug>`.
  const dashKey = path.replace(/^dashboards\//, '').replace(/\.json$/, '')
  const key = `${parent ?? dashKey}/${slugify(label)}`
  if (doc.tabs.some((t) => t.key === key)) throw new Error(`A tab with key "${key}" already exists.`)

  doc.tabs.push({
    name,
    description: null,
    displayOrder: doc.tabs.length,
    key,
    parentKey: parent ?? null,
  } as DashboardDoc['tabs'][number])
  doc.tabs.sort((a, b) => ((a.key ?? '') < (b.key ?? '') ? -1 : 1))
  writeJson(root, path, doc)

  return revalidate(root, `Added tab "${label}" with key ${key}.`)
}

export interface AddWidgetArgs {
  path: string
  dashboard: string
  tabKey: string
  name: Record<string, string>
  pluginId: string
  dataset?: string
  config?: Record<string, unknown>
  layout: { x: number; y: number; w: number; h: number }
}

export function addWidget(args: AddWidgetArgs): string {
  const { path: root, dashboard, tabKey, name, pluginId, dataset, layout } = args
  const docPath = dashboardPath(dashboard)
  const doc = readJson<DashboardDoc>(root, docPath)

  if (!doc.tabs.some((t) => t.key === tabKey)) {
    throw new Error(
      `Unknown tab "${tabKey}". Known: ${doc.tabs.map((t) => t.key).join(', ') || 'none'}.`,
    )
  }
  const label = name.en || Object.values(name)[0] || ''
  if (!label) throw new Error('The widget needs a name.')

  const config = resolveConfigColumns(root, dataset, args.config ?? {})
  const key = `${tabKey}/${slugify(label)}@${layout.y},${layout.x}`
  if (doc.widgets.some((w) => w.key === key)) {
    throw new Error(`A widget with key "${key}" already exists — change its name or position.`)
  }

  doc.widgets.push({
    name,
    description: null,
    ...(dataset ? { datasetFileId: dataset } : {}),
    layout,
    source: { type: 'plugin', pluginId, config },
    key,
    tabKey,
  } as DashboardDoc['widgets'][number])
  doc.widgets.sort((a, b) =>
    (a.tabKey ?? '') < (b.tabKey ?? '') ? -1
      : (a.tabKey ?? '') > (b.tabKey ?? '') ? 1
        : (a.key ?? '') < (b.key ?? '') ? -1 : 1)
  writeJson(root, docPath, doc)

  return revalidate(root, `Added widget "${label}" with key ${key}.`)
}

/**
 * Rewrite config values that name a column into column ids.
 *
 * A config author writes `age` because that is what the data shows; the config
 * layer keys columns by id (`col_age`). Left unresolved the widget renders blank
 * with an empty column picker and no error anywhere — the same failure mode the
 * in-app copilot has, handled the same way.
 */
function resolveConfigColumns(
  root: string,
  dataset: string | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!dataset) return config
  let entries: DatasetEntry[]
  try {
    entries = readJson<DatasetEntry[]>(root, 'datasets/_tree.json')
  } catch {
    return config
  }
  const target = entries.find((d) => d.id === dataset)
  if (!target?.columns?.length) return config

  const ids = new Set(target.columns.map((c) => c.id))
  const byName = new Map(target.columns.map((c) => [c.name, c.id]))
  const resolve = (value: string): string => {
    if (ids.has(value)) return value
    return byName.get(value) ?? (byName.has(columnId(value)) ? byName.get(columnId(value))! : value)
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') out[key] = resolve(value)
    else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? resolve(v) : v))
    } else out[key] = value
  }
  return out
}

const SCRIPT_LANGUAGES: Record<string, string> = {
  py: 'python',
  r: 'r',
  sql: 'sql',
  md: 'markdown',
}

export function addScript(root: string, file: string, content: string): string {
  const clean = file.replace(/^scripts\//, '')
  const full = resolveInside(root, join('scripts', clean))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf-8')

  // The tree is what the import reads; a file absent from it never appears in
  // the IDE, so it is written in the same call rather than left to the caller.
  let entries: { path: string; type: string; language: string; createdAt: string }[] = []
  try {
    entries = readJson(root, 'scripts/_tree.json')
  } catch {
    entries = []
  }
  if (!entries.some((e) => e.path === clean)) {
    entries.push({
      path: clean,
      type: 'file',
      language: SCRIPT_LANGUAGES[clean.split('.').pop()?.toLowerCase() ?? ''] ?? 'text',
      createdAt: '',
    })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1))
  writeJson(root, 'scripts/_tree.json', entries)

  return revalidate(root, `Wrote scripts/${clean}.`)
}

/**
 * Spec fields per entity kind.
 *
 * Generated from one table rather than prose in a skill file: a field list
 * copied into Markdown is stale the day the schema moves, and this is what the
 * `linkr-authoring` skill defers to instead of restating.
 */
export function describeEntitySchema(kind: string): string | null {
  const docs: Record<string, string> = {
    project: [
      'project spec — the argument to write_project.',
      '',
      '  projectId   string    required. Stable identity, e.g. "icu-demo".',
      '  name        localized required. {"en": …, "fr": …}',
      '  description localized optional.',
      '  appVersion  string    required. Export-format version, e.g. "2.3.3".',
      '  readme      localized optional. Becomes README.md / README.<lang>.md.',
      '  license     object    optional. {"id": "Apache-2.0"}',
      '  createdBy   string    optional. Author display name.',
      '  datasets    array     optional. See kind "dataset".',
      '  dashboards  array     optional. See kind "dashboard".',
      '  scripts     array     optional. See kind "script".',
    ].join('\n'),

    dataset: [
      'dataset spec — one entry of project.datasets.',
      '',
      '  name  string required. Produces datasets/<name>/<name>.csv, addressed as "<name>.csv".',
      '  csv   string required. Raw CSV text, header included.',
      '  types object optional. Column name → string|number|date|boolean.',
      '',
      'Column ids are derived from the header: "mean SpO2 (%)" → col_mean_spo2.',
      'Types are inferred from the values when no hint is given.',
    ].join('\n'),

    dashboard: [
      'dashboard spec — one entry of project.dashboards.',
      '',
      '  name    localized required.',
      '  tabs    array     required. See kind "tab".',
      '  widgets array     optional. See kind "widget".',
      '  gridV   1 | 2     optional, default 2 (a 48-column grid; 1 is 12 columns).',
    ].join('\n'),

    tab: [
      'tab spec — one entry of dashboard.tabs.',
      '',
      '  name   localized required.',
      '  parent string    optional. English name of the parent tab; one level of nesting.',
    ].join('\n'),

    widget: [
      'widget spec — one entry of dashboard.widgets.',
      '',
      '  name     localized required.',
      '  tab      string    required. English name of the tab it belongs to.',
      '  pluginId string    required, e.g. "linkr-analysis-plot-builder",',
      '                     "linkr-analysis-key-indicator", "linkr-analysis-sankey".',
      '  dataset  string    optional. Dataset name, as given in datasets[].name.',
      '  config   object    optional. Plugin config; column NAMES are resolved to ids.',
      '  layout   object    required. {x, y, w, h} on a 48-column grid.',
      '',
      'Example: {"plotType": "histogram", "xColumn": "age", "groupColumn": "sex"}',
    ].join('\n'),

    script: [
      'script spec — one entry of project.scripts.',
      '',
      '  path    string required. Path under scripts/, e.g. "01_extract.sql".',
      '  content string required.',
      '',
      'Language is derived from the extension (.py .r .sql .md).',
    ].join('\n'),

    'sql-collection': [
      'sql-collection spec — a standalone tree, for write_entity.',
      '',
      '  name        localized required.',
      '  description localized optional.',
      '  files       array     required. {path, content, order?}',
      '',
      'Parent folders are declared in _tree.json automatically; a file whose folder',
      'is missing would be reparented to the root on import.',
    ].join('\n'),

    'etl-pipeline': [
      'etl-pipeline spec — a standalone tree, for write_entity.',
      '',
      '  name        localized required.',
      '  description localized optional.',
      '  files       array     required. {path, content, order?} — usually .sql',
      '  status      string    optional: draft (default) | ready | running | error',
      '',
      'Same file/tree handling as a sql-collection.',
    ].join('\n'),

    'dq-rule-set': [
      'dq-rule-set spec — a standalone tree, for write_entity.',
      '',
      '  name        localized required.',
      '  description localized optional.',
      '  checks      array     required. One entry per check:',
      '    name        string required.',
      '    sql         string required — without it the check runs nothing.',
      '    description string optional.',
      '    category    string optional, default "completeness".',
      '    severity    string optional: error (default) | warning | info',
      '    threshold   number optional — its meaning is the check\'s own.',
    ].join('\n'),

    'data-catalog': [
      'data-catalog spec — a standalone tree, for write_entity.',
      '',
      '  name              localized required.',
      '  description       localized optional.',
      '  dimensions        string[]  required — the columns it counts over.',
      '                              An empty list computes nothing.',
      '  categoryColumn    string    optional.',
      '  subcategoryColumn string    optional.',
    ].join('\n'),

    'mapping-project': [
      'mapping-project spec — a standalone tree, for write_entity.',
      '',
      '  name        localized required.',
      '  description localized optional.',
      '  sourceType  string    optional.',
      '  mappings    array     required. One entry per source concept:',
      '    sourceConceptCode string required — the row identity.',
      '    targetConceptId   number required WHEN status is "approved";',
      '                             an approved row without one maps nothing.',
      '    status            string optional: pending (default) | approved | rejected | draft',
      '    sourceConceptName, sourceVocabularyId, sourceDomainId, sourceCategoryId,',
      '    targetConceptName, targetVocabularyId, targetDomainId, targetConceptCode,',
      '    mappingType, equivalence — all optional passthrough.',
      '',
      'Rows are sorted by sourceConceptCode on write, so re-exporting the same',
      'alignments is byte-stable.',
    ].join('\n'),

    'schema-preset': [
      'schema-preset spec — a standalone tree, for write_entity.',
      'Describes how to read one database: which table holds patients, visits,',
      'notes, and where each kind of clinical event lives.',
      '',
      '  presetId    string    required. Stable identity, e.g. "omop-cdm-5-4".',
      '  presetLabel localized required. Shown wherever the schema is picked.',
      '  description localized optional.',
      '  eventTables object    optional. Label → event table, e.g. "Measurement":',
      '    table            string required — the table to read.',
      '    conceptIdColumn  string required — the concept the row is about.',
      '    dateColumn       string required — when the event happened.',
      '    sourceConceptIdColumn, patientIdColumn, endDateColumn, valueColumn,',
      '    valueStringColumn, valueUnitColumn, valueUnitConceptIdColumn,',
      '    routeColumn, routeConceptIdColumn, conceptVocabularyColumn,',
      '    conceptCodeColumn, conceptDictionaryKey — optional.',
      '  mapping     object    optional. The rest of the mapping, merged as-is:',
      '    patientTable, visitTable, visitDetailTable, noteTable, deathTable,',
      '    conceptTables, genderValues, knownTables, erdGroups.',
      '  ddl         string    optional. CREATE TABLE statements → schema.ddl.',
      '  templateId  string    optional. Built-in preset it derives from.',
      '  version     string    optional. Semver, default "0.1.0".',
      '',
      'The DDL is always written to schema.ddl, never inline in preset.json:',
      'a 50k blob on one JSON line makes every diff unreadable.',
      'Event tables and their fields are written in a canonical order, so two',
      'instances holding the same mapping produce identical bytes.',
    ].join('\n'),

    database: [
      'database spec — a standalone tree, for write_database.',
      '',
      'ONLY for synthetic or public open data. Never package data from a',
      'connected database or a hospital extract: the repo is public and a',
      'Parquet file carries no label saying whose data it is.',
      '',
      '  id          string    required. Stable identity, e.g. "mimic-iv-demo".',
      '  alias       string    required. DuckDB schema name, e.g. "mimic_iv_demo".',
      '  name        localized required.',
      '  description localized optional.',
      '  schema      object    required. THE MAPPING ITSELF, inline. A bare name is',
      '                             refused: it would only resolve against presets',
      '                             installed on the importing instance. Read it from',
      '                             the schema preset repo (preset.json → mapping).',
      '  schemaSource object    which published schema that mapping came from:',
      '    lineageId string required — the preset\'s `lineageId`, copied verbatim.',
      '                             NOT its presetId: that is a local primary key,',
      '                             regenerated on import, meaningless elsewhere.',
      '    label     localized — so the schema stays nameable where it is NOT installed.',
      '    version   string — the preset version this was taken from.',
      '  tables      array     required unless inMemory. One entry per table:',
      '    name   string required — the SQL table name; becomes data/<name>.parquet.',
      '    source string required — path of the Parquet file to COPY in.',
      '  inMemory    boolean   optional. True for a database meant to start empty',
      '                             (an ETL target). Then `tables` may be omitted.',
      '  isVocabularyReference boolean optional.',
      '  version     string    optional. Semver, default "0.1.0".',
      '',
      'Produces _database.json + data/*.parquet + a .gitattributes tracking',
      'Parquet with LFS (multi-MB blobs in normal git history bloat every clone',
      'forever). No connection config is ever written — the importing instance',
      'supplies its own, and a host or token in a public repo is a leak.',
    ].join('\n'),
  }
  return docs[kind] ?? null
}
