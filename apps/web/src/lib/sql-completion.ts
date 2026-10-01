/**
 * Context-aware SQL completion: given the text of an editor, the cursor offset
 * and a catalog of the database's schemas / tables / columns, decide what the
 * user is typing (a table after FROM, a column after `alias.`, an expression…)
 * and list the matching suggestions. Pure — the Monaco provider and the catalog
 * loader live elsewhere.
 *
 * Deliberately a lexer plus a few backward-looking rules, not a parser: the text
 * being completed is unfinished SQL, which no grammar accepts.
 */

export interface SqlCatalogColumn {
  name: string
  type?: string
}

export interface SqlCatalogTable {
  name: string
  columns: SqlCatalogColumn[]
}

export interface SqlCatalogSchema {
  name: string
  tables: SqlCatalogTable[]
}

export interface SqlCatalog {
  schemas: SqlCatalogSchema[]
  /** Schemas whose tables can be written without a qualifier (the search path). */
  defaultSchemas: string[]
}

export type SqlCompletionKind = 'schema' | 'table' | 'column' | 'keyword' | 'function'

export interface SqlCompletion {
  label: string
  kind: SqlCompletionKind
  insertText: string
  /** Where it comes from (a column's table, a table's schema) or its type. */
  detail?: string
  /** Lower sorts first: what fits the context ranks above keywords. */
  rank: number
}

export interface SqlCompletionResult {
  items: SqlCompletion[]
  /** Offset where the word being replaced starts. */
  wordStart: number
  /** What the cursor expects: lets the editor open the list unprompted only where
   *  it is short and wanted (a table after FROM). */
  slot: SqlSlot
}

export type SqlSlot = 'none' | 'keywords' | 'table' | 'qualified' | 'expression'

type Token =
  | { t: 'ident'; v: string; quoted: boolean; start: number; end: number; open?: boolean }
  | { t: 'punct'; v: string; start: number; end: number; open?: boolean }

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'UNION', 'UNION ALL', 'EXCEPT',
  'INTERSECT', 'WITH', 'ASC', 'DESC', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE FROM', 'CREATE TABLE', 'CREATE VIEW', 'DROP TABLE', 'OVER', 'PARTITION BY',
  'QUALIFY', 'TRUE', 'FALSE',
]

const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'ROUND',
  'LOWER', 'UPPER', 'TRIM', 'LENGTH', 'SUBSTRING', 'CONCAT', 'REPLACE', 'ABS',
  'DATE_TRUNC', 'DATE_PART', 'EXTRACT', 'DATE_DIFF', 'CURRENT_DATE', 'NOW',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'STRING_AGG', 'MEDIAN', 'QUANTILE_CONT',
]

/** Words that end a table reference, so they are never taken for an alias. */
const CLAUSE_WORDS = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'join', 'left', 'right', 'inner',
  'full', 'cross', 'outer', 'natural', 'on', 'using', 'union', 'except', 'intersect',
  'window', 'qualify', 'select', 'from', 'as', 'set', 'values', 'returning', 'lateral',
  'tablesample', 'pivot', 'unpivot', 'positional', 'asof', 'anti', 'semi',
])

/** Keywords after which a table name is expected. */
const TABLE_INTRODUCERS = new Set(['from', 'join', 'into', 'update', 'table', 'describe', 'summarize'])

/** Keywords that start a clause where a column / expression is expected. */
const EXPRESSION_INTRODUCERS = new Set([
  'select', 'where', 'on', 'by', 'having', 'and', 'or', 'not', 'when', 'then', 'else',
  'set', 'qualify', 'distinct', 'case', 'in', 'between', 'like', 'ilike', 'is', 'using',
])

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/

/** Quotes an identifier only when SQL would not read it as written. */
export function quoteIdent(name: string): string {
  if (SIMPLE_IDENT.test(name) && !RESERVED.has(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

const RESERVED = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'having', 'limit', 'join', 'on',
  'as', 'and', 'or', 'not', 'in', 'is', 'null', 'case', 'when', 'then', 'else', 'end',
  'table', 'union', 'all', 'distinct', 'with', 'user', 'default', 'check', 'column',
])

/**
 * Splits SQL into identifiers and punctuation. String literals, numbers, comments
 * and operators are dropped (they never carry a name worth completing), but a
 * `'` left open at the cursor still swallows the rest — so completion stays out
 * of string literals.
 */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
    } else if (c === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          break
        }
        j++
      }
      tokens.push({ t: 'punct', v: "'", start: i, end: Math.min(j + 1, n), open: j >= n })
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      let v = ''
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { v += '"'; j += 2; continue }
          break
        }
        v += sql[j]
        j++
      }
      tokens.push({ t: 'ident', v, quoted: true, start: i, end: Math.min(j + 1, n), open: j >= n })
      i = j + 1
    } else if (/[A-Za-z_À-￿]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$À-￿]/.test(sql[j])) j++
      tokens.push({ t: 'ident', v: sql.slice(i, j), quoted: false, start: i, end: j })
      i = j
    } else if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9.eE_]/.test(sql[j])) j++
      i = j
    } else if (c === '.' || c === ',' || c === '(' || c === ')' || c === ';' || c === '*') {
      tokens.push({ t: 'punct', v: c, start: i, end: i + 1 })
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      tokens.push({ t: 'punct', v: 'op', start: i, end: i + 1 })
      i++
    }
  }
  return tokens
}

const lower = (tok: Token | undefined) => (tok && tok.t === 'ident' && !tok.quoted ? tok.v.toLowerCase() : undefined)

interface TableRef {
  /** Qualified name as written, e.g. ['cdm', 'person']. */
  path: string[]
  alias?: string
}

/** Collects `FROM a.b x, c` / `JOIN d AS y` references and CTE names in a statement. */
function collectRefs(tokens: Token[]): { refs: TableRef[]; ctes: string[] } {
  const refs: TableRef[] = []
  const ctes: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    // WITH name AS (   and   , name AS (   at the head of a WITH list
    if (tok.t === 'ident' && tokens[i + 1] && lower(tokens[i + 1]) === 'as' && tokens[i + 2]?.v === '(') {
      const prev = tokens[i - 1]
      if (prev && (lower(prev) === 'with' || lower(prev) === 'recursive' || prev.v === ',')) ctes.push(tok.v)
    }
    const kw = lower(tok)
    if (kw !== 'from' && kw !== 'join') continue
    let j = i + 1
    for (;;) {
      const path: string[] = []
      while (tokens[j]?.t === 'ident' && !(lower(tokens[j]) && CLAUSE_WORDS.has(lower(tokens[j])!))) {
        path.push(tokens[j].v)
        if (tokens[j + 1]?.v === '.') j += 2
        else { j++; break }
      }
      if (path.length === 0) break
      let alias: string | undefined
      if (lower(tokens[j]) === 'as') j++
      const a = tokens[j]
      if (a?.t === 'ident' && !(lower(a) && CLAUSE_WORDS.has(lower(a)!))) {
        alias = a.v
        j++
      }
      refs.push({ path, alias })
      if (kw === 'from' && tokens[j]?.v === ',') { j++; continue }
      break
    }
  }
  return { refs, ctes }
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function findSchema(catalog: SqlCatalog, name: string) {
  return catalog.schemas.find((s) => eq(s.name, name))
}

/** Resolves a written table path (`t`, `s.t`, `db.s.t`) to catalog tables. */
function resolveTable(catalog: SqlCatalog, path: string[]): { schema: string; table: SqlCatalogTable }[] {
  const name = path[path.length - 1]
  const schemaName = path.length >= 2 ? path[path.length - 2] : undefined
  const out: { schema: string; table: SqlCatalogTable }[] = []
  const candidates = schemaName
    ? catalog.schemas.filter((s) => eq(s.name, schemaName))
    : catalog.schemas.filter((s) => catalog.defaultSchemas.some((d) => eq(d, s.name)))
  for (const s of candidates) {
    const t = s.tables.find((tb) => eq(tb.name, name))
    if (t) out.push({ schema: s.name, table: t })
  }
  // An unqualified name the search path doesn't hold: take it from any schema
  // rather than offer nothing — the user may rely on a USE we don't know about.
  if (!out.length && !schemaName) {
    for (const s of catalog.schemas) {
      const t = s.tables.find((tb) => eq(tb.name, name))
      if (t) out.push({ schema: s.name, table: t })
    }
  }
  return out
}

/** Index of the statement (between `;`) that contains `offset`. */
function statementBounds(tokens: Token[], offset: number): [number, number] {
  let from = 0
  let to = tokens.length
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v !== ';') continue
    if (tokens[i].end <= offset) from = i + 1
    else { to = i; break }
  }
  return [from, to]
}

type Context =
  | { kind: 'none' }
  | { kind: 'keywords' }
  | { kind: 'table' }
  | { kind: 'qualified'; path: string[]; tableClause: boolean }
  | { kind: 'expression' }

/** What the cursor expects, from the tokens before it (word being typed excluded). */
function cursorContext(before: Token[]): Context {
  const last = before[before.length - 1]
  if (last?.v === "'") return { kind: 'keywords' }
  // `a.` / `a.b.` — gather the dotted path ending at the cursor.
  if (last?.v === '.') {
    const path: string[] = []
    let k = before.length - 1
    while (before[k]?.v === '.' && before[k - 1]?.t === 'ident') {
      path.unshift(before[k - 1].v)
      k -= 2
    }
    if (!path.length) return { kind: 'none' }
    const head = clauseBefore(before.slice(0, k + 1))
    return { kind: 'qualified', path, tableClause: head === 'table' }
  }
  return { kind: clauseBefore(before) }
}

/**
 * Walks back from the cursor over the tokens at its own parenthesis depth and
 * classifies the slot: a table name expected (after FROM/JOIN, or a comma in a
 * FROM list), an expression, or only keywords (after a table: an alias or WHERE…).
 */
function clauseBefore(before: Token[]): 'table' | 'expression' | 'keywords' {
  let depth = 0
  let sawIdentSinceComma = false
  let prevWasComma = false
  for (let i = before.length - 1; i >= 0; i--) {
    const tok = before[i]
    if (tok.v === ')') { depth++; continue }
    if (tok.v === '(') {
      if (depth === 0) return 'expression'
      depth--
      continue
    }
    if (depth > 0) continue
    const kw = lower(tok)
    if (i === before.length - 1) {
      if (kw && TABLE_INTRODUCERS.has(kw)) return 'table'
      if (kw && EXPRESSION_INTRODUCERS.has(kw)) return 'expression'
      if (tok.v === ',') prevWasComma = true
      else if (tok.v === 'op' || tok.v === '*') return 'expression'
      else if (tok.t === 'ident') sawIdentSinceComma = true
      continue
    }
    if (kw && TABLE_INTRODUCERS.has(kw)) {
      // FROM t ⎸ → typing an alias or the next keyword; FROM t, ⎸ → a table again.
      return prevWasComma || !sawIdentSinceComma ? 'table' : 'keywords'
    }
    if (kw && (EXPRESSION_INTRODUCERS.has(kw) || kw === 'as')) return 'expression'
    if (tok.v === ',' && !sawIdentSinceComma) prevWasComma = true
    if (tok.t === 'ident') sawIdentSinceComma = true
  }
  return 'expression'
}

function matches(label: string, prefix: string): boolean {
  if (!prefix) return true
  return label.toLowerCase().startsWith(prefix.toLowerCase())
}

/** Suggestions for the cursor at `offset` in `sql`. */
export function sqlCompletions(sql: string, offset: number, catalog: SqlCatalog): SqlCompletionResult {
  const tokens = tokenizeSql(sql)
  // The word under the cursor is what gets replaced — exclude it from the context.
  let wordStart = offset
  while (wordStart > 0 && /[A-Za-z0-9_$À-￿]/.test(sql[wordStart - 1])) wordStart--
  const prefix = sql.slice(wordStart, offset)

  const [from, to] = statementBounds(tokens, offset)
  const statement = tokens.slice(from, to)
  const before = statement.filter((tok) => tok.end <= wordStart)
  // An unterminated string or quoted identifier swallows the cursor.
  const open = statement.find((tok) =>
    tok.start < offset && (tok.end > offset || tok.open) && (tok.v === "'" || (tok.t === 'ident' && tok.quoted)))
  if (open) return { items: [], wordStart, slot: 'none' }

  const ctx = cursorContext(before)
  const { refs, ctes } = collectRefs(statement)
  const items: SqlCompletion[] = []
  const push = (item: SqlCompletion) => { if (matches(item.label, prefix)) items.push(item) }

  const schemaItems = () => {
    for (const s of catalog.schemas) {
      push({ label: s.name, kind: 'schema', insertText: quoteIdent(s.name), rank: 1 })
    }
  }
  const tableItems = (schemas: SqlCatalogSchema[], rank: number, showSchema: boolean) => {
    for (const s of schemas) {
      for (const t of s.tables) {
        push({ label: t.name, kind: 'table', insertText: quoteIdent(t.name), detail: showSchema ? s.name : undefined, rank })
      }
    }
  }
  const columnItems = (tables: { schema: string; table: SqlCatalogTable; via?: string }[], rank: number) => {
    const seen = new Set<string>()
    for (const { table, via } of tables) {
      for (const c of table.columns) {
        const key = `${via ?? table.name}.${c.name}`
        if (seen.has(key)) continue
        seen.add(key)
        push({
          label: c.name,
          kind: 'column',
          insertText: quoteIdent(c.name),
          detail: [via ?? table.name, c.type].filter(Boolean).join(' · '),
          rank,
        })
      }
    }
  }
  const keywordItems = (rank: number) => {
    for (const k of KEYWORDS) push({ label: k, kind: 'keyword', insertText: k, rank })
    for (const f of FUNCTIONS) push({ label: f, kind: 'function', insertText: f, rank: rank + 1 })
  }

  if (ctx.kind === 'none') return { items: [], wordStart, slot: ctx.kind }
  if (ctx.kind === 'keywords') {
    keywordItems(0)
    return { items: dedupe(items), wordStart, slot: ctx.kind }
  }

  if (ctx.kind === 'table') {
    // Several schemas: offer them first, then the tables the search path makes
    // reachable without a qualifier (labelled with their schema).
    const multi = catalog.schemas.length > 1 || (catalog.schemas.length === 1 && !eq(catalog.schemas[0].name, 'main'))
    const defaults = catalog.schemas.filter((s) => catalog.defaultSchemas.some((d) => eq(d, s.name)))
    if (multi) schemaItems()
    tableItems(defaults, multi ? 2 : 1, multi)
    for (const c of ctes) push({ label: c, kind: 'table', insertText: quoteIdent(c), detail: 'CTE', rank: 0 })
    keywordItems(5)
    return { items: dedupe(items), wordStart, slot: ctx.kind }
  }

  if (ctx.kind === 'qualified') {
    const { path } = ctx
    const last = path[path.length - 1]
    // alias. / table. → its columns
    if (path.length === 1 && !ctx.tableClause) {
      const ref = refs.find((r) => (r.alias && eq(r.alias, last)) || (!r.alias && eq(r.path[r.path.length - 1], last)))
      if (ref) {
        columnItems(resolveTable(catalog, ref.path).map((x) => ({ ...x, via: ref.alias ?? x.table.name })), 0)
        return { items: dedupe(items), wordStart, slot: ctx.kind }
      }
    }
    // schema. → its tables (or, in an expression, schema.table. comes next)
    const schema = findSchema(catalog, last)
    if (schema) {
      tableItems([schema], 0, false)
      return { items: dedupe(items), wordStart, slot: ctx.kind }
    }
    // schema.table. / table. → columns
    const resolved = resolveTable(catalog, path)
    if (resolved.length) columnItems(resolved, 0)
    return { items: dedupe(items), wordStart, slot: ctx.kind }
  }

  // Expression: the columns of the tables in FROM, else every table's columns.
  const inScope = refs.flatMap((r) => resolveTable(catalog, r.path).map((x) => ({ ...x, via: r.alias ?? x.table.name })))
  if (inScope.length) {
    columnItems(inScope, 0)
    for (const r of refs) {
      const name = r.alias ?? r.path[r.path.length - 1]
      push({ label: name, kind: 'table', insertText: quoteIdent(name), detail: r.alias ? r.path.join('.') : undefined, rank: 2 })
    }
  } else if (!refs.length) {
    columnItems(catalog.schemas.flatMap((s) => s.tables.map((table) => ({ schema: s.name, table }))), 2)
  }
  keywordItems(3)
  return { items: dedupe(items), wordStart, slot: ctx.kind }
}

function dedupe(items: SqlCompletion[]): SqlCompletion[] {
  const seen = new Set<string>()
  return items.filter((it) => {
    const key = `${it.kind}:${it.label}:${it.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
