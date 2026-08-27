/**
 * Canonical ordering for a schema mapping.
 *
 * A schema preset's `eventTables` is a user-keyed map of user-keyed objects, so
 * its insertion order carries no meaning — but it is written to git, where an
 * arbitrary order makes a re-export churn the diff even when nothing changed.
 * Sorting everything alphabetically would fix that and scatter the pairs
 * (`dateColumn` far from `endDateColumn`, a unit far from its value), so the
 * field order is declared, grouped by what the fields mean, and anything
 * unlisted is appended sorted — a new field is stable before it is placed here.
 *
 * **This has three implementations that must emit identical bytes**: this one,
 * `canonicalSchemaMapping` in `apps/web/src/lib/entity-io.ts`, and
 * `_canonical_schema_mapping` in `apps/api/.../workspace_export_assemble.py`.
 * The app re-exports this module's constant rather than keeping its own copy;
 * the Python twin is guarded by the export golden tests.
 */

/**
 * Top-level mapping keys in declared order.
 *
 * Follows what a reader looks for: identity, then the tables that anchor a
 * record (patient → death → visit → note → visit detail), then the concept
 * tables and events, then the lookups and presentation. Every preset the app
 * has exported already uses this order — declaring it here is what lets the
 * authoring writer reproduce an existing preset byte for byte instead of
 * emitting its own arrangement and churning the diff.
 */
export const MAPPING_FIELD_ORDER = [
  'presetId',
  'presetLabel',
  'patientTable',
  'deathTable',
  'visitTable',
  'noteTable',
  'visitDetailTable',
  'conceptTables',
  'eventTables',
  'genderValues',
  'knownTables',
  'erdGroups',
  'templateId',
  'description',
] as const

/** Event-table fields in declared order; unlisted keys are appended sorted. */
export const EVENT_TABLE_FIELD_ORDER = [
  'table',
  'conceptIdColumn',
  'sourceConceptIdColumn',
  'conceptVocabularyColumn',
  'conceptCodeColumn',
  'conceptDictionaryKey',
  'patientIdColumn',
  'dateColumn',
  'endDateColumn',
  'valueColumn',
  'valueStringColumn',
  'valueUnitColumn',
  'valueUnitConceptIdColumn',
  'routeColumn',
  'routeConceptIdColumn',
] as const

/** One object's keys in a declared order, with unlisted keys appended sorted. */
export function orderKeys(
  obj: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const rest = Object.keys(obj).filter((k) => !order.includes(k)).sort()
  const out: Record<string, unknown> = {}
  for (const k of [...order, ...rest]) if (k in obj) out[k] = obj[k]
  return out
}

/**
 * A mapping with its top-level keys, its event tables, and their keys in a
 * deterministic order.
 *
 * The top level is ordered here, not just at the call sites that remember to:
 * a mapping is assembled by spreading, and a spread appends keys the source
 * lacked. `reassemblePresetMapping` re-adds `presetId`/`presetLabel` after
 * spreading (a preset's repo keeps them in entity.json, not in mapping.json),
 * so an installed database wrote them at the END of its copy while the same
 * mapping exported anywhere else had them first — a pure reordering diff on a
 * file nothing had edited.
 */
export function canonicalSchemaMapping(
  mapping: Record<string, unknown>,
): Record<string, unknown> {
  const out = orderKeys(mapping, MAPPING_FIELD_ORDER)
  const tables = out.eventTables
  if (!tables || typeof tables !== 'object') return out
  const src = tables as Record<string, Record<string, unknown>>
  const ordered: Record<string, unknown> = {}
  // Table labels sorted too: they are a user-keyed map, so their insertion order
  // is just as arbitrary as the fields'.
  for (const label of Object.keys(src).sort()) {
    const et = src[label]
    // A null or non-object entry is passed through rather than ordered, which is
    // what the server twin does. Throwing here instead meant a hand-edited or
    // partially-written preset exported fine from the server and not at all
    // from the browser.
    ordered[label] = et && typeof et === 'object' ? orderKeys(et, EVENT_TABLE_FIELD_ORDER) : et
  }
  return { ...out, eventTables: ordered }
}
