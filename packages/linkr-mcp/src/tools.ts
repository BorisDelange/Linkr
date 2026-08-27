/**
 * Tool implementations: disk I/O plus the incremental edits, over `@linkr/format`.
 *
 * Kept apart from server.ts so they are testable without speaking JSON-RPC. The
 * rule from the plan holds here too — no format knowledge. Editing an existing
 * tree does read and rewrite dashboard JSON, but it only ever *places* records
 * whose shape and keys come from the format package.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  ENTITY_MANIFEST, MANIFEST, SCRIPT_LANGUAGE as SCRIPT_LANGUAGES,
  columnId, detectTreeKind, findCsv, formatIssues, isReadableKind, moveWidget, READABLE_KINDS,
  readEntity, readProjectManifest, removeTab, removeWidget, renameDatasetColumns, renameTab,
  renameWidget,
  serializeEntity, serializeProject, slugify, tabCollateral, validateEntity, validateProject,
  type CopyFile, type DashboardDocument, type DatasetRecord, type DqRuleSetSpec,
  type EtlPipelineSpec, type MappingProjectSpec, type ReadableEntityKind,
  type SqlCollectionSpec, type WriteFile,
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
  // No trailing newline: the app's exporters write none, so adding one here
  // makes the first sync after an install commit a diff that only removes it.
  writeFileSync(full, JSON.stringify(value, null, 2), 'utf-8')
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

/** A filter as stored, with the tab/widget keys its scope points at. */
interface FilterDoc {
  columnId?: string
  columnName?: string
  inputType?: string
  scope?: { type: string; tabKeys?: string[]; widgetKeys?: string[] }
}

interface DashboardDoc {
  dashboard: Record<string, unknown> & { filterConfig?: FilterDoc[] }
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
  /** Location under `datasets/`, e.g. `stays/stays.csv`. */
  path?: string
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

  // Either name: a tree written before the manifest rename still says project.json.
  const projectRaw = tree.read(ENTITY_MANIFEST) ?? tree.read(MANIFEST.project)
  if (!projectRaw) throw new Error(`No ${ENTITY_MANIFEST} in ${root}.`)
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
    // Filters are listed before the tabs they scope: a filter restricted to one
    // tab is invisible from the tab itself, so an agent editing that tab would
    // not know a filter points at its key until the rename orphaned it.
    for (const f of doc.dashboard?.filterConfig ?? []) {
      const where = f.scope?.type === 'tabs'
        ? ` scope=tabs:${f.scope.tabKeys?.join(',')}`
        : f.scope?.type === 'widgets'
          ? ` scope=widgets:${f.scope.widgetKeys?.join(',')}`
          : ''
      lines.push(`    filter ${f.columnId} (${f.columnName}, ${f.inputType})${where}`)
    }
    for (const tab of doc.tabs) {
      lines.push(`    tab ${tab.key ?? '(no key)'} — ${JSON.stringify(tab.name)}`)
      for (const w of doc.widgets.filter((x) => x.tabKey === tab.key)) {
        const l = w.layout
        const at = l ? ` @${l.y},${l.x} ${l.w}x${l.h}` : ''
        lines.push(`      widget ${w.key} — ${JSON.stringify(w.name)} [${w.source.pluginId ?? w.source.type}]${at}`)
        if (w.datasetFileId) lines.push(`        dataset ${w.datasetFileId}`)
        // The config is what an edit actually targets. Omitting it was what forced
        // an agent to open the file, and from there to hand-edit derived ids.
        const config = w.source.config as Record<string, unknown> | undefined
        for (const [k, v] of Object.entries(config ?? {})) {
          lines.push(`        config.${k} = ${JSON.stringify(v)}`)
        }
      }
    }
  }

  const scripts = tree.paths().filter((p) => p.startsWith('scripts/') && !p.endsWith('_tree.json'))
  lines.push('', 'Scripts:')
  lines.push(scripts.length ? scripts.map((s) => `  ${s}`).join('\n') : '  (none)')
  if (scripts.length) lines.push('  (read one with read_file)')

  return lines.join('\n')
}

/**
 * One file of a tree, verbatim.
 *
 * `describe_tree` lists script paths but no tool returned their content, so an
 * agent that wanted to change a query had to reach for its own file reader — and
 * an agent already reading the tree directly is one step from editing a derived
 * id by hand. Reading through the server keeps the traversal guard in play and
 * keeps "do not touch the files" a rule it can follow.
 */
export function readTreeFile(root: string, file: string): string {
  const full = resolveInside(root, file)
  try {
    return readFileSync(full, 'utf-8')
  } catch {
    const tree = new FsTree(root)
    const known = tree.paths().filter((p) => !p.endsWith('_tree.json'))
    throw new Error(
      `No file "${file}" in the tree. Known: ${known.slice(0, 40).join(', ') || 'none'}.`,
    )
  }
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
  // Shared by every standalone kind rather than repeated five times: these are
  // what make an authored tree survive install → re-export with no diff.
  const IDENTITY_DOC = [
    '',
    'Identity — write these so the tree round-trips cleanly. Without them Linkr',
    'fills them in on import and writes them back, so the first sync after an',
    'install carries a diff nobody authored:',
    '',
    '  entityId      string readable, URL-safe identifier. Set once, never changes.',
    '                       This is the name; it does NOT identify the entity',
    '                       across instances — lineageId does.',
    '  lineageId     uuid   cross-instance identity, preserved by every import.',
    '                       Generate one; it is what makes two installs of this',
    '                       repo recognisable as the same published entity, and',
    '                       what makes a re-import update in place rather than',
    '                       land as a duplicate. Write it on every entity.',
    '  createdAt     string ISO 8601, the real creation date, kept as provenance.',
    '  version       string semver, default "0.1.0".',
    '',
    'Do NOT write `id`. It was the writing instance\'s local primary key and no',
    'longer travels in an export: an importer either mints its own or keeps the',
    'row it already has, so an authored one is silently dropped.',
  ].join('\n')

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
    ].join('\n') + IDENTITY_DOC,

    'etl-pipeline': [
      'etl-pipeline spec — a standalone tree, for write_entity.',
      '',
      '  name        localized required.',
      '  description localized optional.',
      '  files       array     required. {path, content, order?} — usually .sql',
      '  status      string    optional: draft (default) | ready | running | error',
      '',
      'Same file/tree handling as a sql-collection.',
    ].join('\n') + IDENTITY_DOC,

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
    ].join('\n') + IDENTITY_DOC,

    'data-catalog': [
      'data-catalog spec — a standalone tree, for write_entity.',
      '',
      '  name              localized required.',
      '  description       localized optional.',
      '  dimensions        string[]  required — the columns it counts over.',
      '                              An empty list computes nothing.',
      '  categoryColumn    string    optional.',
      '  subcategoryColumn string    optional.',
    ].join('\n') + IDENTITY_DOC,

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
    ].join('\n') + IDENTITY_DOC,

    'schema-preset': [
      'schema-preset spec — a standalone tree, for write_entity.',
      'Describes how to read one database: which table holds patients, visits,',
      'notes, and where each kind of clinical event lives.',
      '',
      '  presetId    string    required. The readable identity, e.g. "omop-cdm-5-4".',
      '                        Written to `entityId` (the field every entity uses',
      '                        for its slug) and to `mapping.presetId`, which is a',
      '                        label inside the mapping, not an identity.',
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
      '  version     string    optional. Semver, default "0.1.0".',
      '',
      'The DDL is always written to schema.ddl, never inline in the manifest:',
      'a 50k blob on one JSON line makes every diff unreadable.',
      'Event tables and their fields are written in a canonical order, so two',
      'instances holding the same mapping produce identical bytes.',
    ].join('\n') + IDENTITY_DOC,

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
      '                             the schema preset repo (its mapping.json).',
      '  schemaSource object    which published schema that mapping came from:',
      '    lineageId string required — the preset\'s `lineageId`, copied verbatim.',
      '                             NOT its entityId or the retired presetId: those',
      '                             name the schema, they do not identify it across',
      '                             instances. Only lineageId survives an import.',
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

// ---------------------------------------------------------------------------
// Mutating an existing tree
//
// Each of these is a facade over `@linkr/format`'s rekey functions: the key
// cascade is format knowledge and lives there, so these only read the file,
// call it, write, and revalidate. A mutator that computed a key itself would
// have broken the layering the plan sets out in §4.
// ---------------------------------------------------------------------------

/** Report the keys a cascade rewrote, so the caller can see what else moved. */
function describeChanges(changes: Map<string, string>): string {
  if (!changes.size) return ''
  const lines = [...changes].map(([from, to]) => `  ${from} → ${to}`)
  return `\n\nKeys rewritten (anything referencing them was updated):\n${lines.join('\n')}`
}

export function renameDashboardTab(
  root: string,
  dashboard: string,
  key: string,
  name: Record<string, string>,
): string {
  const docPath = dashboardPath(dashboard)
  const { doc, changes } = renameTab(readJson<DashboardDocument>(root, docPath), key, name)
  writeJson(root, docPath, doc)
  const label = name.en || Object.values(name)[0] || ''
  return revalidate(root, `Renamed tab ${key} to "${label}".${describeChanges(changes)}`)
}

export function renameDashboardWidget(
  root: string,
  dashboard: string,
  key: string,
  name: Record<string, string>,
): string {
  const docPath = dashboardPath(dashboard)
  const { doc, changes } = renameWidget(readJson<DashboardDocument>(root, docPath), key, name)
  writeJson(root, docPath, doc)
  const label = name.en || Object.values(name)[0] || ''
  return revalidate(root, `Renamed widget ${key} to "${label}".${describeChanges(changes)}`)
}

export function moveDashboardWidget(
  root: string,
  dashboard: string,
  key: string,
  to: { tabKey?: string; x?: number; y?: number; w?: number; h?: number },
): string {
  const docPath = dashboardPath(dashboard)
  const { doc, changes } = moveWidget(readJson<DashboardDocument>(root, docPath), key, to)
  writeJson(root, docPath, doc)
  return revalidate(root, `Moved widget ${key}.${describeChanges(changes)}`)
}

export interface UpdateWidgetArgs {
  path: string
  dashboard: string
  key: string
  config?: Record<string, unknown>
  dataset?: string
  pluginId?: string
}

/**
 * Change a widget's config, dataset or plugin — everything that does NOT move its key.
 *
 * Renaming is `rename_widget` and moving is `move_widget`, deliberately: those
 * cascade, this does not, and folding them into one tool would hide which calls
 * rewrite other records.
 */
export function updateWidget(args: UpdateWidgetArgs): string {
  const { path: root, dashboard, key } = args
  const docPath = dashboardPath(dashboard)
  const doc = readJson<DashboardDoc>(root, docPath)
  const widget = doc.widgets.find((w) => w.key === key)
  if (!widget) {
    throw new Error(
      `Unknown widget "${key}". Known: ${doc.widgets.map((w) => w.key).join(', ') || 'none'}.`,
    )
  }

  if (args.dataset !== undefined) widget.datasetFileId = args.dataset
  if (args.pluginId !== undefined) widget.source.pluginId = args.pluginId
  if (args.config !== undefined) {
    // Merged, not replaced: a caller changing one option should not have to
    // re-send the other sixteen a real widget carries.
    widget.source.config = resolveConfigColumns(
      root,
      widget.datasetFileId,
      { ...(widget.source.config ?? {}), ...args.config },
    )
  }
  writeJson(root, docPath, doc)
  return revalidate(root, `Updated widget ${key}.`)
}

export function removeDashboardTab(root: string, dashboard: string, key: string): string {
  const docPath = dashboardPath(dashboard)
  const before = readJson<DashboardDocument>(root, docPath)
  const { removes, scopes } = tabCollateral(before, key)
  const { doc } = removeTab(before, key)
  writeJson(root, docPath, doc)

  // D2: name the collateral. A tab looks like one record but owns its subtree,
  // and there is no undo on a file the agent just rewrote.
  const also = removes.filter((r) => r !== key)
  const detail = [
    also.length ? `Also removed: ${also.join(', ')}.` : '',
    scopes.length ? `Filters that lost a scope reference: ${scopes.join(', ')}.` : '',
  ].filter(Boolean).join(' ')
  return revalidate(root, `Removed tab ${key}. ${detail}`.trim())
}

export function removeDashboardWidget(root: string, dashboard: string, key: string): string {
  const docPath = dashboardPath(dashboard)
  const before = readJson<DashboardDocument>(root, docPath)
  const scoped = (before.dashboard?.filterConfig ?? [])
    .filter((f) => f.scope?.widgetKeys?.includes(key))
    .map((f) => String(f.columnId ?? '(filter)'))
  const { doc } = removeWidget(before, key)
  writeJson(root, docPath, doc)
  const detail = scoped.length ? ` Filters that lost a scope reference: ${scoped.join(', ')}.` : ''
  return revalidate(root, `Removed widget ${key}.${detail}`)
}

/**
 * Rename dataset columns, re-deriving their ids and repointing every reference.
 *
 * Loads *every* dashboard, not only one: a column id is referenced from any widget
 * or filter bound to that dataset, and rewriting one dashboard would leave the
 * others pointing at an id nothing answers to — a widget that renders blank with
 * no error.
 */
export function renameColumns(
  root: string,
  dataset: string,
  renames: { from: string; to: string }[],
): string {
  const entries = readJson<DatasetEntry[]>(root, 'datasets/_tree.json')
  const fileId = dataset.endsWith('.csv') ? dataset : `${dataset}.csv`
  const index = entries.findIndex((e) => e.id === fileId || e.name === fileId)
  if (index < 0) {
    throw new Error(
      `Unknown dataset "${dataset}". Known: ${entries.map((e) => e.id).join(', ') || 'none'}.`,
    )
  }

  const tree = new FsTree(root)
  const paths = tree.paths().filter((p) => p.startsWith('dashboards/') && p.endsWith('.json'))
  const dashboards = new Map<string, DashboardDocument>(
    paths.map((p) => [p, readJson<DashboardDocument>(root, p)]),
  )

  const out = renameDatasetColumns(entries[index] as DatasetRecord, dashboards, renames)

  entries[index] = out.dataset as DatasetEntry
  writeJson(root, 'datasets/_tree.json', entries)
  for (const [path, doc] of out.dashboards) writeJson(root, path, doc)

  // The CSV header carries the same names, and the validator requires the two to
  // agree — leaving it alone produced a tree with a `csv-header-mismatch` error
  // every time. The header is metadata about the columns, not the data itself.
  // Resolved the way the validator does: published trees put the file flat at
  // `datasets/<name>.csv` as often as under its own folder, and guessing one
  // shape would edit the metadata while leaving the data untouched.
  const csvPath = findCsv(tree, entries[index].id, entries[index].name, entries[index] as unknown as Record<string, unknown>)
  const renamed = csvPath ? rewriteCsvHeader(root, csvPath, out.dataset.columns ?? []) : false

  // The id changes are the load-bearing part of the report: anything the caller
  // quoted from an earlier describe_tree is stale, and a config it was about to
  // send would silently point at nothing.
  const moved = [...out.changes].map(([from, to]) => `  ${from} → ${to}`).join('\n')
  const summary = out.changes.size
    ? `Renamed ${renames.length} column(s) in ${fileId}.\n\nColumn ids rewritten `
      + `(every widget config and filter pointing at them was updated):\n${moved}`
    : `Renamed ${renames.length} column(s) in ${fileId}. No id changed, so nothing else moved.`

  const note = renamed
    ? '\n\nThe CSV header was updated to match.'
    : csvPath
      ? `\n\n${csvPath} is not a text CSV, so its header still holds the old names.`
      : '\n\nNo data file was found, so only the metadata changed.'
  return revalidate(root, summary + note)
}

/**
 * Rewrite a data file's header row to the declared column names.
 *
 * Only the first line is touched, and only for a text CSV: a dataset keeps its
 * original upload, so the resolved file may be XLSX or Parquet, whose columns live
 * in a binary structure this must not corrupt. Those are left alone — the caller is
 * told, since their header will then disagree with the tree.
 */
function rewriteCsvHeader(
  root: string,
  csvPath: string,
  columns: { name: string }[],
): boolean {
  if (!csvPath || !/\.csv$/i.test(csvPath)) return false
  let raw: string
  try {
    raw = readFileSync(resolveInside(root, csvPath), 'utf-8')
  } catch {
    return false
  }
  const breakAt = raw.indexOf('\n')
  const rest = breakAt < 0 ? '' : raw.slice(breakAt)
  const header = columns.map((c) => quoteCsv(c.name)).join(',')
  writeFileSync(resolveInside(root, csvPath), header + rest, 'utf-8')
  return true
}

/** Quote a header field only when it needs it, so untouched names stay byte-identical. */
function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// ---------------------------------------------------------------------------
// Standalone entities: read back, and edit one record out of many
// ---------------------------------------------------------------------------

/**
 * A standalone entity tree as the spec that would rewrite it.
 *
 * The edit loop for these six kinds is read → change → `write_entity`, so this is
 * the half that was missing. It is lossless: anything the spec does not model
 * comes back in `extra` and is re-emitted in place, so an unrelated field is
 * never dropped by an edit.
 */
export function readEntitySpec(root: string): string {
  const tree = new FsTree(root)
  const kind = detectTreeKind(tree)
  if (!kind) {
    throw new Error(`No Linkr entity found in ${root}: nothing declares what it is.`)
  }
  if (kind === 'project') {
    throw new Error('This is a project tree — use describe_tree and the dashboard tools.')
  }
  if (!isReadableKind(kind)) {
    throw new Error(
      `Reading a ${kind} tree is not supported yet. Readable: ${READABLE_KINDS.join(', ')}.`,
    )
  }
  const { spec } = readEntity(tree, kind)
  return `kind: ${kind}\n\n${JSON.stringify(spec, null, 2)}`
}

/** Load a standalone tree, or explain why it cannot be edited. */
function loadEntity(root: string, expected?: ReadableEntityKind) {
  const tree = new FsTree(root)
  const kind = detectTreeKind(tree)
  if (!kind || !isReadableKind(kind)) {
    throw new Error(`No editable Linkr entity in ${root} (found: ${kind ?? 'nothing'}).`)
  }
  if (expected && kind !== expected) {
    throw new Error(`This is a ${kind} tree, not a ${expected}.`)
  }
  return { tree, ...readEntity(tree, kind) }
}

/** Write a spec back over its own tree, then revalidate. */
function writeEntitySpec(root: string, kind: ReadableEntityKind, spec: unknown, summary: string): string {
  writeTree(root, serializeEntity(kind as never, spec as never))
  const issues = validateEntity(new FsTree(root), kind as never)
  const errors = issues.filter((i) => i.severity === 'error').length
  if (!issues.length) return `${summary} Tree is valid.`
  return errors === 0
    ? `${summary} Tree is valid (${issues.length} warning(s)).`
    : `${summary}\n\n${errors} error(s) now in the tree:\n${formatIssues(issues)}`
}

export interface DqCheckInput {
  name: string
  sql?: string
  description?: string
  category?: string
  severity?: 'error' | 'warning' | 'info'
  threshold?: number
}

/**
 * Add or update one quality check, by name.
 *
 * Granular because a rule set is a list: re-emitting every check to edit one
 * means sending them all through the model's context, which is both wasteful and
 * a chance to mangle the ones that were not meant to change.
 */
export function upsertDqCheck(root: string, check: DqCheckInput): string {
  const { kind, spec } = loadEntity(root, 'dq-rule-set')
  const s = spec as DqRuleSetSpec
  const index = s.checks.findIndex((c) => c.name === check.name)
  const existing = index >= 0 ? s.checks[index] : undefined
  const merged = { ...existing, ...check } as DqRuleSetSpec['checks'][number]
  if (!merged.sql) throw new Error(`Check "${check.name}" needs a sql query.`)

  if (index >= 0) s.checks[index] = merged
  else s.checks.push(merged)
  return writeEntitySpec(
    root, kind, s,
    `${index >= 0 ? 'Updated' : 'Added'} check "${check.name}" (${s.checks.length} total).`,
  )
}

export function removeDqCheck(root: string, name: string): string {
  const { kind, spec } = loadEntity(root, 'dq-rule-set')
  const s = spec as DqRuleSetSpec
  const index = s.checks.findIndex((c) => c.name === name)
  if (index < 0) {
    throw new Error(
      `Unknown check "${name}". Known: ${s.checks.map((c) => c.name).join(', ') || 'none'}.`,
    )
  }
  s.checks.splice(index, 1)
  return writeEntitySpec(root, kind, s, `Removed check "${name}" (${s.checks.length} left).`)
}

/**
 * Add or update mapping rows, keyed by source concept code.
 *
 * The code is the natural key: it is what the source dictionary calls the
 * concept, and what a re-import matches on. Rows are merged field by field, so
 * setting a target does not erase the source metadata beside it.
 */
export function upsertMappings(
  root: string,
  rows: Record<string, unknown>[],
): string {
  const { kind, spec } = loadEntity(root, 'mapping-project')
  const s = spec as MappingProjectSpec
  const byCode = new Map(s.mappings.map((m, i) => [m.sourceConceptCode, i]))

  let added = 0
  let updated = 0
  for (const row of rows) {
    const code = String(row.sourceConceptCode ?? '')
    if (!code) throw new Error('Every mapping row needs a sourceConceptCode.')
    const at = byCode.get(code)
    if (at != null) {
      s.mappings[at] = { ...s.mappings[at], ...row } as unknown as MappingProjectSpec['mappings'][number]
      updated++
    } else {
      s.mappings.push(row as unknown as MappingProjectSpec['mappings'][number])
      byCode.set(code, s.mappings.length - 1)
      added++
    }
  }
  return writeEntitySpec(
    root, kind, s,
    `${added} row(s) added, ${updated} updated (${s.mappings.length} total).`,
  )
}

export function removeMappings(root: string, codes: string[]): string {
  const { kind, spec } = loadEntity(root, 'mapping-project')
  const s = spec as MappingProjectSpec
  const doomed = new Set(codes)
  const before = s.mappings.length
  s.mappings = s.mappings.filter((m) => !doomed.has(String(m.sourceConceptCode)))
  const removed = before - s.mappings.length
  if (!removed) {
    throw new Error(`No row matched: ${codes.join(', ')}.`)
  }
  return writeEntitySpec(root, kind, s, `Removed ${removed} row(s) (${s.mappings.length} left).`)
}

/**
 * Add, replace or delete one file of a SQL collection or ETL pipeline.
 *
 * `content: null` deletes. Ordering is preserved: an ETL pipeline runs its files
 * in `order`, so a new file goes last unless one is given.
 */
export function writeEntityFile(
  root: string,
  filePath: string,
  content: string | null,
  order?: number,
): string {
  const { kind, spec } = loadEntity(root)
  if (kind !== 'sql-collection' && kind !== 'etl-pipeline') {
    throw new Error(`A ${kind} has no script files.`)
  }
  const s = spec as SqlCollectionSpec | EtlPipelineSpec
  const index = s.files.findIndex((f) => f.path === filePath)

  if (content == null) {
    if (index < 0) {
      throw new Error(
        `Unknown file "${filePath}". Known: ${s.files.map((f) => f.path).join(', ') || 'none'}.`,
      )
    }
    s.files.splice(index, 1)
    // The old file is still on disk: the serializer only writes what the spec
    // lists, so a delete must remove it explicitly or it survives untracked.
    rmSync(resolveInside(root, `scripts/${filePath}`), { force: true })
    return writeEntitySpec(root, kind, s, `Removed ${filePath} (${s.files.length} file(s) left).`)
  }

  if (index >= 0) {
    s.files[index] = { ...s.files[index], content, ...(order != null ? { order } : {}) }
  } else {
    s.files.push({ path: filePath, content, order: order ?? s.files.length })
  }
  return writeEntitySpec(
    root, kind, s,
    `${index >= 0 ? 'Replaced' : 'Added'} ${filePath} (${s.files.length} file(s)).`,
  )
}

export interface UpdateProjectArgs {
  path: string
  name?: Record<string, string>
  description?: Record<string, string>
  shortDescription?: Record<string, string>
  status?: string
  version?: string
  license?: { id: string; name?: string }
  readme?: Record<string, string>
}

/**
 * Change a project's own metadata, leaving its content alone.
 *
 * Only the manifest (and README when given) is rewritten — not the datasets,
 * dashboards or scripts, which have their own tools. Going through
 * `readProjectManifest` first is what makes that safe: a project carries 17
 * fields and the spec models 8, so writing a hand-built spec would drop the
 * organization, the badges and the provenance.
 */
export function updateProject(args: UpdateProjectArgs): string {
  const { path: root } = args
  const tree = new FsTree(root)
  const kind = detectTreeKind(tree)
  if (kind !== 'project') {
    throw new Error(`This is not a project tree (found: ${kind ?? 'nothing'}).`)
  }

  const spec = readProjectManifest(tree) as Record<string, unknown>
  const changed: string[] = []
  for (const field of ['name', 'description', 'shortDescription', 'status'] as const) {
    if (args[field] !== undefined) { spec[field] = args[field]; changed.push(field) }
  }
  if (args.license !== undefined) { spec.license = args.license; changed.push('license') }
  if (args.version !== undefined) {
    // `version` is provenance, not a modelled spec field, so it rides in `extra`
    // — where the manifest's own key order is recorded, so it stays in place.
    const extra = (spec.extra ?? {}) as Record<string, unknown>
    extra.version = args.version
    spec.extra = extra
    changed.push('version')
  }
  if (!changed.length && !args.readme) {
    throw new Error('Nothing to change: pass at least one field.')
  }

  // Only the manifest is rewritten. serializeProject emits the whole tree from a
  // spec, and this spec deliberately holds no datasets or dashboards — writing
  // all of it would delete them.
  const files = serializeProject(spec as unknown as Parameters<typeof serializeProject>[0])
  const manifest = files.find((f) => f.path === ENTITY_MANIFEST)
  if (!manifest) throw new Error('The serializer produced no manifest.')
  writeTree(root, [manifest])

  if (args.readme) {
    writeTree(root, Object.entries(args.readme)
      .filter(([, body]) => typeof body === 'string' && body.length)
      .map(([lang, body]) => ({ path: lang === 'en' ? 'README.md' : `README.${lang}.md`, content: body })))
    changed.push('readme')
  }

  return revalidate(root, `Updated ${changed.join(', ')}.`)
}
