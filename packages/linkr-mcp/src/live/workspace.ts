/**
 * Workspaces, projects and databases as the app's dialogs build them: request
 * bodies, validation and the text a model reads. Pure — the tools fetch and send.
 */
import { ensureUniqueAlias, generateAlias } from '@/lib/alias'
import { addBadge, categoryOf } from '@/lib/badge-categories'
import { buildPointer } from '@/lib/import-identity'
import { localized, setLocalized } from '@/lib/localized'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'
import type {
  BadgeCategory, BadgeColor, CustomSchemaPreset, DataSource, DatabaseConnectionConfig, LocalizedString, Project,
  ProjectBadge, ProjectStatus, SchemaMapping, SchemaSource, TodoItem, Workspace,
} from '@/types'

export type Language = 'en' | 'fr'
export const LANGUAGES: Language[] = ['en', 'fr']
export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']
export const BADGE_COLORS = ['red', 'blue', 'green', 'violet', 'amber', 'rose', 'cyan', 'slate'] as const

// Same rule as `isEntityIdValid` (components/ui/entity-id-field.tsx), which
// lives in a React module this package cannot load.
const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

// Must match `DB_ERROR_NO_DATA_ON_IMPORT` in lib/entity-io.ts: the app shows its
// own message for this code. entity-io is too heavy to load here.
const DB_ERROR_NO_DATA = 'linkr:db-imported-without-data'

const text = (v: LocalizedString | string | null | undefined, lang: Language = 'en') => localized(v, lang)

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Why an identifier is refused, or null when it is valid and free. */
export function entityIdError(value: string, taken: string[]): string | null {
  if (value.length < 2 || value.length > 50) return 'must be 2 to 50 characters'
  if (!ENTITY_ID_PATTERN.test(value)) return 'lowercase letters, digits and hyphens only, not starting or ending with a hyphen'
  if (taken.includes(value)) return 'already used by another project of this workspace'
  return null
}

/** The identifier the create dialog would submit: the requested one if valid, else
 *  the name's slug (made unique, as the dialog cannot submit a taken one). */
export function projectEntityId(name: string, requested: string | undefined, taken: string[]): { id: string } | { error: string } {
  if (requested !== undefined && requested !== '') {
    const error = entityIdError(requested, taken)
    return error ? { error: `Invalid entity_id "${requested}": ${error}.` } : { id: requested }
  }
  return { id: uniqueEntityId(slugifyId(name), taken) }
}

// ---------------------------------------------------------------------------
// Workspaces and projects
// ---------------------------------------------------------------------------

/** Body of `POST /workspaces`, as `addWorkspace` sends it. The server stamps the author. */
export function workspaceCreateBody(input: {
  id: string; lineageId: string; name: string; description?: string; organizationId?: string
  badges?: ProjectBadge[]; lang: Language
}): Record<string, unknown> {
  return {
    id: input.id,
    name: { [input.lang]: input.name },
    description: { [input.lang]: input.description ?? '' },
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.badges?.length ? { badges: input.badges } : {}),
    lineageId: input.lineageId,
  }
}

/** Body of `POST /projects`, as `addProject` + the create dialog's follow-ups send it. */
export function projectCreateBody(input: {
  uid: string; lineageId: string; workspaceId: string; entityId: string; name: string; description?: string
  status?: ProjectStatus; badges?: ProjectBadge[]; version?: string; lang: Language
}): Record<string, unknown> {
  return {
    uid: input.uid,
    entityId: input.entityId,
    projectId: input.entityId,
    workspaceId: input.workspaceId,
    name: { [input.lang]: input.name },
    description: { [input.lang]: input.description ?? '' },
    shortDescription: {},
    config: {},
    lineageId: input.lineageId,
    version: input.version?.trim() || '0.1.0',
    ...(input.status && input.status !== 'active' ? { status: input.status } : {}),
    ...(input.badges?.length ? { badges: input.badges } : {}),
  }
}

export interface BadgeInput { label: string; color?: string }

/**
 * The entity's badges after setting them to `wanted`: a badge already there
 * (same label) keeps its id and colour unless one is given; a new one takes
 * its category's colour, else blue, as the badge editor does. Exclusive
 * categories hold one value, as in `addBadge`.
 */
export function setBadges(
  existing: ProjectBadge[], wanted: BadgeInput[], categories: BadgeCategory[], lang: Language, newId: () => string,
): ProjectBadge[] {
  let out: ProjectBadge[] = []
  for (const w of wanted) {
    const label = w.label.trim()
    if (!label) continue
    const kept = existing.find((b) => text(b.label, lang).trim().toLowerCase() === label.toLowerCase())
    const draft: ProjectBadge = kept
      ? { ...kept, ...(w.color ? { color: w.color as BadgeColor } : {}) }
      : { id: newId(), label: setLocalized({}, lang, label), color: 'blue' }
    if (!kept) draft.color = (w.color as BadgeColor | undefined) ?? categoryOf(draft, categories, lang)?.color ?? 'blue'
    out = addBadge(out, draft, categories, lang)
  }
  return out
}

export interface TodoChanges {
  add?: string[]
  done?: string[]
  undone?: string[]
  remove?: string[]
  rename?: { id: string; text: string }[]
}

/** The task list after the changes, as the Summary's Tasks tab edits it. */
export function applyTodoChanges(
  todos: TodoItem[], changes: TodoChanges, lang: Language, now: number,
): { todos: TodoItem[] } | { error: string } {
  const ids = new Set(todos.map((t) => t.id))
  const unknown = [...(changes.done ?? []), ...(changes.undone ?? []), ...(changes.remove ?? []),
    ...(changes.rename ?? []).map((r) => r.id)].filter((id) => !ids.has(id))
  if (unknown.length) return { error: `Unknown task id(s): ${[...new Set(unknown)].join(', ')}. See get_project_summary.` }
  const done = new Set(changes.done)
  const undone = new Set(changes.undone)
  const removed = new Set(changes.remove)
  const renamed = new Map((changes.rename ?? []).filter((r) => r.text.trim()).map((r) => [r.id, r.text.trim()]))
  const next = todos
    .filter((t) => !removed.has(t.id))
    .map((t) => ({
      ...t,
      ...(done.has(t.id) ? { done: true } : undone.has(t.id) ? { done: false } : {}),
      ...(renamed.has(t.id) ? { text: setLocalized(t.text, lang, renamed.get(t.id)!) } : {}),
    }))
  const added = (changes.add ?? []).map((s) => s.trim()).filter(Boolean)
    .map((s, i): TodoItem => ({ id: `t-${now + i}`, text: setLocalized({}, lang, s), done: false }))
  return { todos: [...next, ...added] }
}

/** `linkedDataSourceIds` + `linkedDataSourceRefs` after linking, kept index-aligned like `linkDataSource`. */
export function linkedAfterLink(project: Project, databases: DataSource[], databaseId: string) {
  const ids = project.linkedDataSourceIds ?? []
  if (ids.includes(databaseId)) return null
  const refs = alignedRefs(project)
  return {
    linkedDataSourceIds: [...ids, databaseId],
    linkedDataSourceRefs: [...refs, buildPointer(databases, databaseId) ?? {}],
  }
}

/** Same, after unlinking — the other databases keep their own pointer. */
export function linkedAfterUnlink(project: Project, databaseId: string) {
  const ids = project.linkedDataSourceIds ?? []
  if (!ids.includes(databaseId)) return null
  const refs = alignedRefs(project)
  const keep = ids.flatMap((id, i) => (id === databaseId ? [] : [i]))
  return {
    linkedDataSourceIds: keep.map((i) => ids[i]),
    linkedDataSourceRefs: keep.map((i) => refs[i] ?? {}),
  }
}

const alignedRefs = (project: Project): object[] => {
  const ids = project.linkedDataSourceIds ?? []
  const refs: object[] = [...(project.linkedDataSourceRefs ?? [])].slice(0, ids.length)
  while (refs.length < ids.length) refs.push({})
  return refs
}

/** Why a database cannot be linked to a project, as the link dialog filters it. */
export function linkRefusal(project: Project, db: DataSource): string | null {
  if (db.isVocabularyReference) return 'it is a vocabulary reference (used by concept mapping), not a database a project queries'
  if (db.workspaceId && db.workspaceId !== project.workspaceId) return 'it belongs to another workspace than the project'
  return null
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export type DatabaseKind = 'managed' | 'server-file' | 'server-folder' | 'uploaded-file' | 'uploaded-folder'
  | 'in-browser' | 'external' | 'fhir' | 'unknown'

/** What a database is, from its config — never where it is nor how to log in. */
export function databaseKind(db: Pick<DataSource, 'sourceType' | 'connectionConfig'>): { kind: DatabaseKind; engine?: string } {
  if (db.sourceType === 'fhir') return { kind: 'fhir' }
  const c = (db.connectionConfig ?? {}) as DatabaseConnectionConfig
  const engine = c.engine
  if (engine === 'postgresql' || engine === 'mysql' || engine === 'sqlserver' || engine === 'oracle') return { kind: 'external', engine }
  if (c.managed) return { kind: 'managed', engine }
  if (c.serverPath) return { kind: /\.(duckdb|sqlite|db)$/i.test(c.serverPath) ? 'server-file' : 'server-folder', engine }
  if (c.fileIds?.length) return { kind: 'uploaded-folder', engine }
  if (c.fileId) return { kind: 'uploaded-file', engine }
  if (c.inMemory || c.useFileHandles) return { kind: 'in-browser', engine }
  return { kind: 'unknown', engine }
}

const KIND_WORDS: Record<DatabaseKind, string> = {
  managed: 'Linkr-created DuckDB (writable)',
  'server-file': 'file on the server',
  'server-folder': 'Parquet folder on the server',
  'uploaded-file': 'uploaded file',
  'uploaded-folder': 'uploaded Parquet files',
  'in-browser': 'browser-only storage',
  external: 'external server',
  fhir: 'FHIR server',
  unknown: 'no data attached',
}

export const kindWords = (db: Pick<DataSource, 'sourceType' | 'connectionConfig'>): string => {
  const { kind, engine } = databaseKind(db)
  return `${engine ? `${engine}, ` : ''}${KIND_WORDS[kind]}`
}

/** One line of a database list. */
export function databaseLine(db: DataSource, linkedBy: string[]): string {
  const stats = db.stats ?? {}
  const counts = [
    stats.patientCount != null ? `${stats.patientCount} patients` : '',
    stats.tableCount != null ? `${stats.tableCount} tables` : '',
  ].filter(Boolean).join(', ')
  return `- ${text(db.name)} — database_id: ${db.id} · alias ${db.alias} · ${db.status}`
    + ` · ${kindWords(db)}`
    + ` · ${db.schemaMapping ? `schema: ${text(db.schemaSource?.label ?? db.schemaMapping.presetLabel) || db.schemaMapping.presetId}` : 'no schema mapping'}`
    + (counts ? ` · ${counts}` : '')
    + (db.isVocabularyReference ? ' · vocabulary reference' : '')
    + (db.derivedFrom ? ` · derived from cohort "${text(db.derivedFrom.cohort?.name)}"` : '')
    + ` · ${linkedBy.length ? `linked to ${linkedBy.join(', ')}` : 'linked to no project'}`
}

/** A unique alias for a new database, as `addDataSource` generates it. */
export function newAlias(name: string, requested: string | undefined, existing: DataSource[]): string {
  return ensureUniqueAlias(generateAlias(requested?.trim() || name), existing.map((d) => d.alias).filter(Boolean))
}

/** The dialog refuses a name another database already has (case-insensitive). */
export function nameTaken(name: string, existing: DataSource[], exceptId?: string): boolean {
  const key = name.trim().toLowerCase()
  return existing.some((d) => d.id !== exceptId && LANGUAGES.some((l) => text(d.name, l).toLowerCase() === key))
}

/** Provenance of a mapping copied from a preset — none without a lineage (a local key identifies nothing elsewhere). */
export function presetSchemaSource(preset: CustomSchemaPreset): SchemaSource | undefined {
  if (!preset.lineageId) return undefined
  return { lineageId: preset.lineageId, label: preset.mapping.presetLabel, ...(preset.version ? { version: preset.version } : {}) }
}

export const presetKey = (p: CustomSchemaPreset): string => p.id ?? p.presetId ?? ''

/** A preset by its id, slug or former presetId. */
export function findPreset(presets: CustomSchemaPreset[], key: string): CustomSchemaPreset | undefined {
  return presets.find((p) => p.id === key) ?? presets.find((p) => p.entityId === key) ?? presets.find((p) => p.presetId === key)
}

/** The installed preset a database's schema came from — `findSourcePreset` of the add dialog. */
export function sourcePreset(
  db: Pick<DataSource, 'schemaSource' | 'schemaMapping'>, presets: CustomSchemaPreset[],
): CustomSchemaPreset | undefined {
  const lineageId = db.schemaSource?.lineageId
  const byLineage = lineageId ? presets.find((p) => p.lineageId === lineageId) : undefined
  if (byLineage) return byLineage
  const stored = db.schemaMapping?.presetId
  if (!stored || stored === 'none') return undefined
  return presets.find((p) => p.presetId === stored || presetKey(p) === stored)
}

/**
 * The PATCH that puts a preset's mapping on a database. Its own preset again is
 * the Mapping tab's "Update from preset": the local overrides stay on top. Another
 * preset is the edit dialog's change of schema: the overrides name relations the
 * new schema may not have, so they go.
 */
export function presetMappingChange(db: DataSource, preset: CustomSchemaPreset, presets: CustomSchemaPreset[]) {
  const mapping = sanitizeSchemaMapping(preset.mapping) as SchemaMapping
  if (sourcePreset(db, presets) === preset) {
    return {
      update: true,
      changes: {
        schemaMapping: mapping,
        ...(db.schemaSource ? { schemaSource: { ...db.schemaSource, ...(preset.version ? { version: preset.version } : {}) } } : {}),
      },
    }
  }
  const schemaSource = presetSchemaSource(preset)
  return {
    update: false,
    changes: { schemaMapping: mapping, ...(schemaSource ? { schemaSource } : {}), schemaOverrides: null },
  }
}

export const CREATED_FROM_PRESET: Record<Language, (preset: string) => string> = {
  en: (p) => `Created from ${p} preset (empty)`,
  fr: (p) => `Créée depuis le preset ${p} (vide)`,
}

export type NewDatabase =
  | { kind: 'empty-from-schema'; preset: CustomSchemaPreset; path?: string }
  | { kind: 'server-path'; engine: 'duckdb' | 'sqlite'; path: string; preset?: CustomSchemaPreset }
  | {
      kind: 'external'; engine: 'postgresql' | 'mysql'; host: string; port?: number; database: string; schema?: string
      allowWrites?: boolean; requireSessionOnly?: boolean; preset?: CustomSchemaPreset
    }

/** Body of `POST /data-sources` for a new database, as `createEmptyDatabase` /
 *  `addDataSource` build it. Never carries a login: each user enters their own. */
export function databaseCreateBody(input: {
  id: string; lineageId: string; workspaceId: string; name: string; description?: string; alias: string
  badges?: ProjectBadge[]; version?: string; lang: Language; spec: NewDatabase
}): Record<string, unknown> {
  const { spec, lang } = input
  const preset = spec.preset
  const connectionConfig: DatabaseConnectionConfig =
    spec.kind === 'empty-from-schema' ? { engine: 'duckdb', managed: true }
      : spec.kind === 'server-path' ? { engine: spec.engine, serverPath: spec.path }
        : {
            engine: spec.engine,
            host: spec.host,
            ...(spec.port ? { port: spec.port } : {}),
            database: spec.database,
            ...(spec.schema ? { schema: spec.schema } : {}),
            ...(spec.engine === 'postgresql' && spec.allowWrites ? { allowWrites: true } : {}),
          }
  const description = input.description?.trim()
    || (spec.kind === 'empty-from-schema' ? CREATED_FROM_PRESET[lang](text(spec.preset.mapping.presetLabel, lang)) : '')
  const schemaSource = preset ? presetSchemaSource(preset) : undefined
  return {
    id: input.id,
    alias: input.alias,
    name: { [lang]: input.name },
    description: { [lang]: description },
    sourceType: 'database',
    connectionConfig,
    ...(preset ? { schemaMapping: sanitizeSchemaMapping(preset.mapping) } : {}),
    ...(schemaSource ? { schemaSource } : {}),
    status: 'configuring',
    ...(spec.kind === 'external' && spec.requireSessionOnly ? { requireSessionOnly: true } : {}),
    ...(spec.kind !== 'empty-from-schema' && input.badges?.length ? { badges: input.badges } : {}),
    ...(spec.kind !== 'empty-from-schema' ? { version: input.version?.trim() || '0.1.0' } : {}),
    workspaceId: input.workspaceId,
    lineageId: input.lineageId,
  }
}

/** The status + stats a re-test writes, from what the server answered — `retestDataSource`. */
export function retestUpdate(
  db: DataSource,
  outcome: { ok: true; tableCount: number } | { ok: false; error: string },
  isFileDatabase: boolean,
): Record<string, unknown> {
  if (!outcome.ok) return { status: 'error', errorMessage: outcome.error }
  if (isFileDatabase && outcome.tableCount === 0) return { status: 'disconnected', errorMessage: DB_ERROR_NO_DATA }
  return { status: 'connected', errorMessage: null, stats: { ...db.stats, tableCount: outcome.tableCount } }
}

/** A file database has no connection to test: reading its schema back is the test. */
export const isFileDatabase = (db: DataSource): boolean => {
  const engine = (db.connectionConfig as DatabaseConnectionConfig | undefined)?.engine
  return db.sourceType !== 'database' || engine === 'duckdb' || engine === 'sqlite'
}

/** The error a database shows, in words (the app's own codes translated). */
export const errorWords = (message: string | null | undefined): string =>
  message === DB_ERROR_NO_DATA ? 'no data attached (imported without its files, or empty)' : message ?? ''

// ---------------------------------------------------------------------------
// Text for the model
// ---------------------------------------------------------------------------

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more characters)`

export const badgeList = (badges: ProjectBadge[] | undefined): string =>
  (badges ?? []).map((b) => text(b.label)).join(', ')

export function workspaceLine(ws: Workspace, projects: number, databases: number): string {
  return `- ${text(ws.name)} — workspace_id: ${ws.id} · ${projects} project(s) · ${databases} database(s)`
    + (ws.badges?.length ? ` · badges: ${badgeList(ws.badges)}` : '')
}

export function projectLines(p: Project, databases: DataSource[], lang: Language = 'en'): string[] {
  const linked = (p.linkedDataSourceIds ?? []).map((id) => {
    const db = databases.find((d) => d.id === id)
    return db ? `${text(db.name, lang)} (${id}, ${db.status})` : `${id} (not accessible or deleted)`
  })
  const todos = p.todos ?? []
  const out = [
    `Project "${text(p.name, lang)}" — project_uid: ${p.uid} · entity_id: ${p.entityId ?? p.projectId ?? '—'} · workspace_id: ${p.workspaceId ?? '—'}`,
    `Status: ${p.status ?? 'active'} · version ${p.version ?? '0.1.0'}${p.badges?.length ? ` · badges: ${badgeList(p.badges)}` : ''}`,
    `Created by ${p.createdBy ?? '—'} on ${p.createdAt?.slice(0, 10) ?? '—'} · updated ${p.updatedAt?.slice(0, 10) ?? '—'}`,
  ]
  if (text(p.shortDescription, lang)) out.push(`Short description: ${text(p.shortDescription, lang)}`)
  if (text(p.description, lang)) out.push(`Description: ${truncate(text(p.description, lang), 1500)}`)
  out.push(`Linked databases (${linked.length}): ${linked.join('; ') || 'none'}`)
  out.push(`Tasks (${todos.filter((t) => t.done).length}/${todos.length} done):`)
  for (const t of todos.slice(0, 50)) out.push(`  [${t.done ? 'x' : ' '}] ${text(t.text, lang)} (id ${t.id})`)
  if (todos.length > 50) out.push(`  … ${todos.length - 50} more`)
  const notes = text(p.notes, lang)
  out.push(notes ? `Notes:\n${truncate(notes, 2000)}` : 'Notes: none')
  const readme = text(p.readme, lang)
  out.push(readme ? `README (Markdown):\n${truncate(readme, 4000)}` : 'README: empty')
  return out
}
