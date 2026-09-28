import type { RelationSpec, SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'
import { isSafeIdentifier } from '@/lib/format-helpers'
import { isMappingV1, mappingV1ToV2 } from '@/lib/schema-classes/v1'

// ---------------------------------------------------------------------------
// Trust boundary: schema-mapping identifiers
// ---------------------------------------------------------------------------
//
// Every table/column name in a SchemaMapping is interpolated into SQL as a bare
// `"${name}"` by the query builders (patient-overview-queries, cohort-query,
// concept-queries, patient-data-queries, data-quality, catalog-queries), so a
// single `"` in a name breaks out of the quoting.
//
// These names are NOT developer constants: they are free text in the schema
// editor and arrive verbatim from four untrusted paths — a workspace ZIP, a
// cloned git repo, a manually imported preset, and the seed loader. Validating
// here, once, is what makes the ~100 interpolation sites downstream safe;
// patching each site individually would leave the next one to be written
// unguarded.
//
// A rejected field is dropped rather than rewritten: a mapping that names a
// column `foo"bar` is broken regardless, and silently querying a *different*
// column would be worse than not querying it.

/** Fields holding a SQL identifier, by suffix. Matches `table`, `idColumn`,
 *  `careSiteNameTable`, `valueColumn`, … without enumerating all ~40 of them,
 *  so a field added later is covered by default rather than by remembering.
 *
 *  `schema` is named outright: it is interpolated exactly like a table name but
 *  ends in neither suffix, so the pattern alone would let it through unchecked. */
function isIdentifierField(key: string): boolean {
  return key === 'schema' || key === 'alias' || /(^|[a-z])(table|column)s?$/i.test(key)
}

/** `alias.column`, the only shape a visual field or a join side may take. */
const COLUMN_REF = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/

/** `fields`: a string is a column reference and must look like one; an
 *  expression or a constant is SQL/data like a cohort's custom SQL, checked by
 *  the generator and run read-only. */
function sanitizeFields(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      if (COLUMN_REF.test(v.trim())) out[k] = v.trim()
    } else if (v && typeof v === 'object' && ('expr' in v || 'value' in v)) {
      out[k] = v
    }
  }
  return out
}

/** A `Record<string, string>` whose VALUES are identifiers — `extraColumns`,
 *  where the key is a query alias and the value the real column name. */
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}

/** Drop every identifier-valued field that is not a safe SQL identifier.
 *  Recurses into the nested table descriptors, event tables and dictionaries.
 *
 *  The three shapes an identifier field takes must ALL be handled here: a bare
 *  string, a `string[]`, and a `Record<string, string>` whose values are the
 *  identifiers. Matching the field *name* is not enough — `extraColumns` passed
 *  the suffix test, fell through to the recursion, and its values reached SQL
 *  unchecked, because only the first two shapes were covered. */
function sanitizeNode<T>(node: T): T {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((v) => sanitizeNode(v)) as unknown as T

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'fields') {
      const fields = sanitizeFields(value)
      if (fields) out[key] = fields
      continue
    }
    if (key === 'on' && Array.isArray(value)) {
      out[key] = value.filter(
        (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((side) => typeof side === 'string' && COLUMN_REF.test(side)),
      )
      continue
    }
    if (isIdentifierField(key)) {
      if (typeof value === 'string') {
        if (isSafeIdentifier(value)) out[key] = value
        continue
      }
      // `knownTables: string[]` and `tables: string[]` (ERD groups) — keep only
      // the safe entries rather than dropping the whole list.
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        out[key] = (value as string[]).filter(isSafeIdentifier)
        continue
      }
      // `extraColumns: Record<alias, columnName>` — the values are what
      // `resolveActualColumn` returns straight into `"${…}"`, so filter on them
      // and keep the alias keys, which never reach SQL.
      if (isStringMap(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).filter(([, v]) => isSafeIdentifier(v)),
        )
        continue
      }
      // `conceptTables` / `eventTables` are collections of descriptors, not
      // identifiers — the suffix test catches them, so recurse instead.
      out[key] = sanitizeNode(value)
      continue
    }
    out[key] = sanitizeNode(value)
  }
  return out as T
}

/**
 * Validate every SQL identifier in a schema mapping, dropping the unsafe ones,
 * after converting a v1 mapping to v2 — the one place a v1 mapping is read.
 * Call this at each point a mapping enters the app from outside (import, clone,
 * seed, manual save) — never trust one that has not been through here.
 */
export function sanitizeSchemaMapping<T extends SchemaMapping | undefined | null>(mapping: T): T {
  if (!mapping || typeof mapping !== 'object') return mapping
  const v2 = isMappingV1(mapping) ? mappingV1ToV2(sanitizeNode(mapping)) : mapping
  return dropTablelessRefs(sanitizeNode(v2)) as T
}

/**
 * A `from` or join whose table was empty or unsafe has just lost its `table`;
 * what is left (an alias) names nothing, and every consumer expects a table
 * there. A relation added in the editor and saved before its table was typed
 * is the usual case.
 */
function dropTablelessRef<S extends RelationSpec>(spec: S): S {
  const out = { ...spec }
  if (out.from && !out.from.table) delete out.from
  if (out.joins) out.joins = out.joins.filter((j) => !!j.table)
  return out
}

function dropTablelessRefs(mapping: SchemaMapping): SchemaMapping {
  const out = { ...mapping }
  for (const key of ['patient', 'visit', 'visitDetail', 'note'] as const) {
    if (out[key]) (out as Record<string, unknown>)[key] = dropTablelessRef(out[key]!)
  }
  if (out.concepts) out.concepts = out.concepts.map((c) => dropTablelessRef(c))
  if (out.events) out.events = out.events.map((e) => dropTablelessRef(e))
  if (out.drugs) out.drugs = out.drugs.map((d) => dropTablelessRef(d))
  return out
}

/**
 * A database's overrides, validated like a mapping: their relations are merged
 * into the mapping every query reads (`effectiveMapping`), and `removed` lists
 * base relations it drops. Anything but an object, or an override left with no
 * relation and no removal, reads as no overrides.
 */
export function sanitizeSchemaOverrides(raw: unknown): SchemaOverrides | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { relations, baseAtOverride, removed } = raw as SchemaOverrides
  const clean: Record<string, RelationSpec> = {}
  if (relations && typeof relations === 'object' && !Array.isArray(relations)) {
    for (const [key, spec] of Object.entries(relations)) {
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) clean[key] = dropTablelessRef(sanitizeNode(spec))
    }
  }
  const cleanRemoved = Array.isArray(removed) ? removed.filter((k): k is string => typeof k === 'string') : []
  if (!Object.keys(clean).length && !cleanRemoved.length) return undefined
  const out: SchemaOverrides = {}
  if (Object.keys(clean).length) {
    out.relations = clean
    if (baseAtOverride && typeof baseAtOverride === 'object' && !Array.isArray(baseAtOverride)) {
      out.baseAtOverride = Object.fromEntries(
        Object.entries(baseAtOverride).filter(([k, v]) => k in clean && typeof v === 'string'),
      )
    }
  }
  if (cleanRemoved.length) out.removed = cleanRemoved
  return out
}

/**
 * A table reference for SQL: `"patients"`, or `"hosp"."patients"` when the
 * mapping names a schema.
 *
 * TWO quoted identifiers, never one — `"hosp.patients"` names a table whose name
 * *contains* a dot, which DuckDB reports as missing. That is the bug this whole
 * area exists to avoid, and it is silent wherever the caller turns an error into
 * an empty result.
 *
 * Names are already validated by `sanitizeSchemaMapping`, so quoting here is
 * belt-and-braces rather than the trust boundary.
 */
export function qualify(ref: { schema?: string; table: string }): string {
  const table = `"${ref.table}"`
  return ref.schema ? `"${ref.schema}".${table}` : table
}

/**
 * Does a discovered table list contain this table?
 *
 * `discoverTables` reports QUALIFIED names (`icu.d_items`) wherever the source
 * carries module directories or schemas — the server derives them that way, and the
 * WASM path mirrors it. A mapping stores the two halves separately, so comparing
 * against `ref.table` alone silently misses every table in a schema: on MIMIC-IV
 * that meant the Concepts page deciding the dictionary did not exist while its
 * cache held thousands of rows.
 *
 * The unqualified name is still accepted, since a flat import reports it that way.
 * Case-insensitive: DuckDB lowercases the schemas it derives from directories,
 * while a mapping keeps whatever the preset author typed.
 */
export function tableListHas(tables: readonly string[], ref: { schema?: string; table: string }): boolean {
  if (!ref.table) return false
  const wanted = new Set<string>([ref.table.toLowerCase()])
  if (ref.schema) wanted.add(`${ref.schema.toLowerCase()}.${ref.table.toLowerCase()}`)
  return tables.some((t) => wanted.has(t.toLowerCase()))
}
