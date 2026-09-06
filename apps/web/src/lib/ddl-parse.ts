/**
 * Parse a `CREATE TABLE` DDL into the tables the ERD draws.
 *
 * Deliberately lenient: a DDL is authored by hand in the schema editor and pasted
 * from every dialect there is, so anything unrecognised is skipped rather than
 * raising. The diagram is a drawing, not a contract — a missed constraint costs
 * an edge, and refusing the whole file would cost the screen.
 *
 * **Schema-qualified names are kept qualified.** A preset that declares
 * `hosp.patients` and `icu.patients` has two tables, and folding them onto their
 * bare name silently merged them into one node, with the constraints of whichever
 * came last. eHOP 4.4 is the case that matters: `EDBM_EDS.EHOP_PATIENT` (the
 * de-identified table) and `EDBM_ZPAT.EHOP_PATIENT` (the nominative one) are
 * different tables holding different data.
 *
 * Known limit, unchanged from the original: the body is split on newlines, so a
 * `CREATE TABLE` writing several columns on one line only yields the first. Every
 * DDL the app ships or generates is one column per line.
 */

export interface ParsedColumn {
  name: string
  type: string
  nullable: boolean
  isPk: boolean
}

export interface ParsedTable {
  /** Qualified when the DDL qualified it: `hosp.patients`, else `patients`. */
  name: string
  /** Set only when the DDL named one. */
  schema?: string
  /** Name without its schema — what the node shows, and what a bare reference matches. */
  bareName: string
  columns: ParsedColumn[]
  pkColumns: string[]
  fks: { columns: string[]; refTable: string; refColumns: string[] }[]
}

/** `hosp.patients`, or `patients` when there is no schema. */
export function qualifiedName(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table
}

/**
 * Resolve a reference to a parsed table, preferring the schema it was written in.
 *
 * A FK inside `CREATE TABLE hosp.admissions` that says `REFERENCES patients`
 * means `hosp.patients` — SQL resolves an unqualified reference in the current
 * schema first. Only when that misses do we accept a table of the same name in
 * another schema, which is what makes a cross-schema FK still draw an edge.
 *
 * The ambiguous case (a bare reference matching several schemas, none of them the
 * current one) resolves to the first declared. That is a genuinely ambiguous DDL;
 * picking one keeps the edge rather than dropping it.
 */
export function resolveTableRef(
  byQualified: Map<string, ParsedTable>,
  byBare: Map<string, ParsedTable[]>,
  ref: { schema?: string; table: string },
  currentSchema?: string,
): ParsedTable | undefined {
  const table = ref.table.toLowerCase()
  if (ref.schema) return byQualified.get(`${ref.schema.toLowerCase()}.${table}`)
  if (currentSchema) {
    const sameSchema = byQualified.get(`${currentSchema.toLowerCase()}.${table}`)
    if (sameSchema) return sameSchema
  }
  return byQualified.get(table) ?? byBare.get(table)?.[0]
}

/**
 * Does a stored name refer to this table?
 *
 * `erdGroups` and `erdLayout` are persisted in `mapping.json`, and every preset
 * written before schemas were parsed stores the BARE name. Accepting both keeps
 * those files working — and keeps a re-export from rewriting a file nobody
 * edited, which is the churn this codebase has paid for before.
 *
 * A bare stored name matches every schema's table of that name. For a layout that
 * means two homonyms start stacked until one is dragged; for a group it means
 * both are grouped. Both beat dropping the table out of the diagram.
 */
export function matchesTableName(table: Pick<ParsedTable, 'name' | 'bareName'>, stored: string): boolean {
  const s = stored.toLowerCase()
  return s === table.name.toLowerCase() || s === table.bareName.toLowerCase()
}

/** The stored key for a table, preferring an exact qualified match. */
export function lookupByTableName<T>(
  store: Record<string, T> | undefined,
  table: Pick<ParsedTable, 'name' | 'bareName'>,
): T | undefined {
  if (!store) return undefined
  for (const key of [table.name, table.name.toLowerCase(), table.bareName, table.bareName.toLowerCase()]) {
    if (key in store) return store[key]
  }
  return undefined
}

/** Index the parsed tables both ways, for `resolveTableRef`. */
export function indexTables(tables: ParsedTable[]): {
  byQualified: Map<string, ParsedTable>
  byBare: Map<string, ParsedTable[]>
} {
  const byQualified = new Map<string, ParsedTable>()
  const byBare = new Map<string, ParsedTable[]>()
  for (const t of tables) {
    byQualified.set(t.name.toLowerCase(), t)
    const bare = t.bareName.toLowerCase()
    const siblings = byBare.get(bare)
    if (siblings) siblings.push(t)
    else byBare.set(bare, [t])
  }
  return { byQualified, byBare }
}

const TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\);/gi
const ALTER_PK_RE = /ALTER\s+TABLE\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s+ADD\s+CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)/gi
const ALTER_FK_RE = /ALTER\s+TABLE\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s+ADD\s+CONSTRAINT\s+\w+\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([^)]+)\)/gi

const splitColumns = (raw: string): string[] =>
  raw.split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean)

export function parseDdl(ddl: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  let match: RegExpExecArray | null

  TABLE_RE.lastIndex = 0
  while ((match = TABLE_RE.exec(ddl)) !== null) {
    const schema = match[1] || undefined
    const bareName = match[2]
    if (!bareName) continue

    const body = match[3]
    const columns: ParsedColumn[] = []
    const pkColumns: string[] = []
    const fks: ParsedTable['fks'] = []

    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '')
      if (!trimmed) continue

      const pkMatch = trimmed.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i)
      if (pkMatch) {
        for (const col of splitColumns(pkMatch[1])) {
          if (!pkColumns.includes(col)) pkColumns.push(col)
        }
        continue
      }

      const fkMatch = trimmed.match(
        /^(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([^)]+)\)/i,
      )
      if (fkMatch) {
        fks.push({
          columns: splitColumns(fkMatch[1]),
          // Qualified as written; `resolveTableRef` applies the current schema.
          refTable: qualifiedName(fkMatch[2], fkMatch[3]).toLowerCase(),
          refColumns: splitColumns(fkMatch[4]),
        })
        continue
      }

      if (/^(CONSTRAINT|UNIQUE|CHECK|INDEX)/i.test(trimmed)) continue

      const colMatch = trimmed.match(/^"?(\w+)"?\s+(\w+(?:\s*\([^)]*\))?)\s*(NOT\s+NULL\s*)?(NULL\s*)?(PRIMARY\s+KEY)?/i)
      if (colMatch) {
        const colName = colMatch[1]
        const isPk = !!colMatch[5]
        columns.push({
          name: colName,
          type: colMatch[2].trim(),
          nullable: !colMatch[3] && !isPk,
          isPk,
        })
        if (isPk && !pkColumns.includes(colName)) pkColumns.push(colName)
      }
    }

    for (const col of columns) {
      if (pkColumns.includes(col.name)) col.isPk = true
    }

    tables.push({ name: qualifiedName(schema, bareName), schema, bareName, columns, pkColumns, fks })
  }

  const { byQualified, byBare } = indexTables(tables)

  ALTER_PK_RE.lastIndex = 0
  while ((match = ALTER_PK_RE.exec(ddl)) !== null) {
    const table = resolveTableRef(byQualified, byBare, { schema: match[1], table: match[2] })
    if (!table) continue
    for (const col of splitColumns(match[3])) {
      if (!table.pkColumns.includes(col)) table.pkColumns.push(col)
      const colDef = table.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())
      if (colDef) colDef.isPk = true
    }
  }

  ALTER_FK_RE.lastIndex = 0
  while ((match = ALTER_FK_RE.exec(ddl)) !== null) {
    const table = resolveTableRef(byQualified, byBare, { schema: match[1], table: match[2] })
    if (!table) continue
    if (!match[5]) continue
    table.fks.push({
      columns: splitColumns(match[3]),
      refTable: qualifiedName(match[4], match[5]).toLowerCase(),
      refColumns: splitColumns(match[6]),
    })
  }

  return tables
}
