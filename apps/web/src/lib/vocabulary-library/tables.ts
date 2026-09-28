/**
 * The OHDSI vocabulary tables a workspace's vocabulary library holds, and how a
 * row belongs to a vocabulary. Twin of apps/api/app/services/vocabulary_library.py.
 *
 * Server-side the library is rewritten into one Parquet partition per vocabulary.
 * Front-only it is not rewritten (a full ATHENA would not fit in the browser's
 * memory): each ATHENA import stays a hidden vocabulary database, and the library
 * is a set of views taking, from each import, the rows of the vocabularies it
 * owns. Both read the same way.
 */

export const TABLE_COLUMNS: Record<string, readonly (readonly [string, string])[]> = {
  concept: [
    ['concept_id', 'BIGINT'], ['concept_name', 'VARCHAR'], ['domain_id', 'VARCHAR'],
    ['vocabulary_id', 'VARCHAR'], ['concept_class_id', 'VARCHAR'],
    ['standard_concept', 'VARCHAR'], ['concept_code', 'VARCHAR'],
    ['valid_start_date', 'DATE'], ['valid_end_date', 'DATE'], ['invalid_reason', 'VARCHAR'],
  ],
  concept_relationship: [
    ['concept_id_1', 'BIGINT'], ['concept_id_2', 'BIGINT'], ['relationship_id', 'VARCHAR'],
    ['valid_start_date', 'DATE'], ['valid_end_date', 'DATE'], ['invalid_reason', 'VARCHAR'],
  ],
  concept_ancestor: [
    ['ancestor_concept_id', 'BIGINT'], ['descendant_concept_id', 'BIGINT'],
    ['min_levels_of_separation', 'INTEGER'], ['max_levels_of_separation', 'INTEGER'],
  ],
  concept_synonym: [
    ['concept_id', 'BIGINT'], ['concept_synonym_name', 'VARCHAR'], ['language_concept_id', 'BIGINT'],
  ],
  drug_strength: [
    ['drug_concept_id', 'BIGINT'], ['ingredient_concept_id', 'BIGINT'],
    ['amount_value', 'DOUBLE'], ['amount_unit_concept_id', 'BIGINT'],
    ['numerator_value', 'DOUBLE'], ['numerator_unit_concept_id', 'BIGINT'],
    ['denominator_value', 'DOUBLE'], ['denominator_unit_concept_id', 'BIGINT'],
    ['box_size', 'INTEGER'], ['valid_start_date', 'DATE'], ['valid_end_date', 'DATE'],
    ['invalid_reason', 'VARCHAR'],
  ],
  vocabulary: [
    ['vocabulary_id', 'VARCHAR'], ['vocabulary_name', 'VARCHAR'],
    ['vocabulary_reference', 'VARCHAR'], ['vocabulary_version', 'VARCHAR'],
    ['vocabulary_concept_id', 'BIGINT'],
  ],
  domain: [['domain_id', 'VARCHAR'], ['domain_name', 'VARCHAR'], ['domain_concept_id', 'BIGINT']],
  concept_class: [
    ['concept_class_id', 'VARCHAR'], ['concept_class_name', 'VARCHAR'], ['concept_class_concept_id', 'BIGINT'],
  ],
  relationship: [
    ['relationship_id', 'VARCHAR'], ['relationship_name', 'VARCHAR'],
    ['is_hierarchical', 'VARCHAR'], ['defines_ancestry', 'VARCHAR'],
    ['reverse_relationship_id', 'VARCHAR'], ['relationship_concept_id', 'BIGINT'],
  ],
}

export const LIBRARY_TABLES = Object.keys(TABLE_COLUMNS)

/** Per-vocabulary tables → the column naming the owning concept (null: the
 *  table carries `vocabulary_id` itself). */
export const OWNED_BY: Record<string, string | null> = {
  concept: null,
  vocabulary: null,
  concept_relationship: 'concept_id_1',
  concept_ancestor: 'ancestor_concept_id',
  concept_synonym: 'concept_id',
  drug_strength: 'drug_concept_id',
}

/** Shared tables: the latest import's rows. */
export const SHARED_TABLES = ['domain', 'concept_class', 'relationship'] as const

/** The row ATHENA writes for the export itself: its version is the release. */
export const RELEASE_VOCABULARY_ID = 'None'

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function typedColumn(name: string, type: string, present: ReadonlySet<string>): string {
  if (!present.has(name)) return `CAST(NULL AS ${type}) AS ${name}`
  if (type === 'DATE') {
    // ATHENA writes 19700101; a typed Parquet already has a DATE.
    return `COALESCE(TRY_CAST(${name} AS DATE), TRY_STRPTIME(CAST(${name} AS VARCHAR), '%Y%m%d')::DATE) AS ${name}`
  }
  return `TRY_CAST(${name} AS ${type}) AS ${name}`
}

/** The library's column list for `table`, cast from whatever `from` holds. */
export function typedSelect(table: string, from: string, present: ReadonlySet<string>): string {
  const cols = (TABLE_COLUMNS[table] ?? []).map(([n, t]) => typedColumn(n, t, present)).join(', ')
  return `SELECT ${cols} FROM ${from}`
}

/** One import's contribution to the library. `ownsAll`: it owns every
 *  vocabulary its CONCEPT holds, so no filter is needed. */
export interface LibraryOwner {
  /** Fully qualified prefix of the import's tables, e.g. `"ds_abc".main`. */
  prefix: string
  vocabularies: readonly string[]
  ownsAll: boolean
  /** Tables the import has (lower-case), with their columns. */
  tables: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * The `SELECT` behind one library view: each owner's rows of the vocabularies it
 * owns, cast to the library's types when several owners are unioned (two CSV
 * imports need not infer the same types). Null when no owner has the table.
 */
export function libraryViewSql(table: string, owners: readonly LibraryOwner[], sharedFrom?: LibraryOwner): string | null {
  if ((SHARED_TABLES as readonly string[]).includes(table)) {
    const cols = sharedFrom?.tables.get(table)
    return sharedFrom && cols ? typedSelect(table, `${sharedFrom.prefix}.${table}`, cols) : null
  }
  const withTable = owners.filter((o) => o.tables.has(table) && o.vocabularies.length > 0)
  if (withTable.length === 0) return null
  const typed = withTable.length > 1
  const col = OWNED_BY[table]
  const parts = withTable.map((o) => {
    const source = `${o.prefix}.${table}`
    const inList = o.vocabularies.map(sqlLiteral).join(', ')
    const where = o.ownsAll
      ? ''
      : col == null
        ? ` WHERE vocabulary_id IN (${inList})`
        : ` WHERE ${col} IN (SELECT concept_id FROM ${o.prefix}.concept WHERE vocabulary_id IN (${inList}))`
    const cols = o.tables.get(table)!
    return typed ? `${typedSelect(table, source, cols)}${where}` : `SELECT * FROM ${source}${where}`
  })
  return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' UNION ALL BY NAME ')
}
