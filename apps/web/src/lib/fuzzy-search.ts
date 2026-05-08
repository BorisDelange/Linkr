/** Strip diacritics + lowercase. Mirrors DuckDB `strip_accents(LOWER(...))`. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Jaro-Winkler similarity in [0, 1]. Same algorithm as DuckDB's. */
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array(a.length).fill(false)
  const bMatches = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(i + matchWindow + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  const m = matches
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3
  // Winkler prefix bonus (up to 4 chars, scale 0.1).
  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Canonical text matcher — same rules as the SQL helper:
 *    exact, prefix, substring (every word), or whole-string Jaro-Winkler ≥ 0.75
 *  Accent-folded, case-insensitive. Use this for client-side text filters that
 *  need typo / accent tolerance (e.g. "plquettes" → "plaquettes"). */
export function fuzzyTextMatch(value: string | null | undefined, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  if (value == null) return false
  const v = fold(value)
  const fq = fold(q)
  if (v === fq) return true
  if (v.startsWith(fq)) return true
  const words = fq.split(/\s+/).filter(Boolean)
  if (words.every((w) => v.includes(w))) return true
  return jaroWinkler(v, fq) >= JW_FUZZY_THRESHOLD
}

/** Canonical fuzzy-search SQL helpers for DuckDB.
 *
 *  All user-facing text searches that need typo / accent tolerance route
 *  through here so the ranking stays consistent across the app. See the
 *  "Fuzzy Search" section in CLAUDE.md for the contract.
 *
 *  Tier semantics — lower rank = better match:
 *    0 — exact id  (numeric only, requires `idColumn`)
 *    1 — exact code  (requires `codeColumn`)
 *    2 — exact name  (case-insensitive equality on `nameColumn`)
 *    3 — prefix  (name starts with the full term)
 *    4 — substring  (every space-separated word appears in name OR code)
 *    5 — fuzzy whole-string Jaro-Winkler ≥ JW_FUZZY_THRESHOLD on name OR code
 *  Within a tier, rows are ordered by `jaro_winkler_similarity DESC`.
 */
import { escSql as esc } from '@/lib/format-helpers'

/** JW threshold for the fuzzy tier. Tuned for high recall — the design
 *  philosophy is "show me everything that might be relevant, even loose
 *  matches; the exact-name / prefix / substring tiers above will keep the
 *  best hits at the top." Accent differences are folded away before
 *  comparison so they don't cost similarity points. */
export const JW_FUZZY_THRESHOLD = 0.75

/** Wrap a SQL expression with `strip_accents(LOWER(...))` for case- AND
 *  accent-insensitive comparison: `é → e`, `É → e`, `ç → c`, etc. DuckDB's
 *  `strip_accents` is Unicode-aware (NFD decompose + strip combining marks). */
function foldSql(expr: string): string {
  return `strip_accents(LOWER(${expr}))`
}

export interface FuzzySearchColumns {
  /** Required: the column whose contents we rank against (typically a
   *  human-readable label like `concept_name`). */
  nameColumn: string
  /** Optional second searchable column (e.g. `concept_code`). When set, exact
   *  / prefix / substring / fuzzy tiers also match against this column. */
  codeColumn?: string
  /** Optional id column. Only consulted when the search term is numeric
   *  (becomes tier 0 — the strongest possible match). */
  idColumn?: string
  /** Optional table alias to prefix every column reference with (e.g. `d`).
   *  When omitted, columns are referenced bare. */
  alias?: string
}

export interface FuzzySearchSql {
  /** SQL predicate that selects every row matching at least one tier. Compose
   *  with `AND` into the caller's own WHERE clause. */
  where: string
  /** SQL expression evaluating to a numeric rank (lower = better). Use as
   *  `ORDER BY <rankExpr> ASC` to apply the tier ordering. */
  rankExpr: string
  /** Same predicate broken into individual tier clauses. Use this when the
   *  caller wants to materialise tiers via `UNION ALL` (so each row carries
   *  its own integer tier in `_rank` and can be deduplicated by `MIN(_rank)`).
   *  Tier 0 (exact id) is omitted when the term is non-numeric. */
  tierClauses: { tier: number; where: string }[]
}

/** Build the SQL clauses for a fuzzy search over one or two text columns.
 *  Returns `null` for empty terms. */
export function buildFuzzySearchSql(term: string, cols: FuzzySearchColumns): FuzzySearchSql | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const escaped = esc(trimmed)
  const isNumeric = /^\d+$/.test(trimmed)
  const words = trimmed.split(/\s+/).filter(Boolean)

  const prefix = cols.alias ? `${cols.alias}.` : ''
  // Comparand expressions: lowercased AND accent-stripped on both sides so
  // "fréquence cardiaque" matches "Frequence cardiqeu" (modulo typo).
  const nameFolded = foldSql(`${prefix}${cols.nameColumn}`)
  const codeFolded = cols.codeColumn ? foldSql(`${prefix}${cols.codeColumn}`) : null
  const q = foldSql(`'${escaped}'`)

  // Per-tier predicates (each tier's WHERE clause).
  const exactCode = codeFolded ? `${codeFolded} = ${q}` : null
  const exactName = `${nameFolded} = ${q}`
  const prefixName = `${nameFolded} LIKE ${q} || '%'`
  const substring = words.map((w) => {
    const we = foldSql(`'%${esc(w)}%'`)
    const onName = `${nameFolded} LIKE ${we}`
    return codeFolded ? `(${onName} OR ${codeFolded} LIKE ${we})` : onName
  }).join(' AND ')
  const fuzzyName = `jaro_winkler_similarity(${nameFolded}, ${q}) >= ${JW_FUZZY_THRESHOLD}`
  const fuzzyAny = codeFolded
    ? `(${fuzzyName} OR jaro_winkler_similarity(${codeFolded}, ${q}) >= ${JW_FUZZY_THRESHOLD})`
    : fuzzyName

  // Tier-by-tier list (used by callers that want UNION ALL semantics).
  const tierClauses: { tier: number; where: string }[] = []
  if (isNumeric && cols.idColumn) {
    tierClauses.push({ tier: 0, where: `${prefix}${cols.idColumn} = ${escaped}` })
  }
  if (exactCode) tierClauses.push({ tier: 1, where: exactCode })
  tierClauses.push({ tier: 2, where: exactName })
  tierClauses.push({ tier: 3, where: prefixName })
  if (substring) tierClauses.push({ tier: 4, where: substring })
  tierClauses.push({ tier: 5, where: fuzzyAny })

  // CASE-based rank expression: tier number + (1 - similarity) so within-tier
  // order is best-similarity-first.
  const simExpr = codeFolded
    ? `GREATEST(jaro_winkler_similarity(${nameFolded}, ${q}), jaro_winkler_similarity(${codeFolded}, ${q}))`
    : `jaro_winkler_similarity(${nameFolded}, ${q})`
  const tierExpr = [
    isNumeric && cols.idColumn ? `WHEN ${prefix}${cols.idColumn} = ${escaped} THEN 0` : '',
    exactCode ? `WHEN ${exactCode} THEN 1` : '',
    `WHEN ${exactName} THEN 2`,
    `WHEN ${prefixName} THEN 3`,
    substring ? `WHEN (${substring}) THEN 4` : '',
    `ELSE 5`,
  ].filter(Boolean).join(' ')
  const rankExpr = `(CASE ${tierExpr} END * 1.0 + (1.0 - ${simExpr}))`

  // Combined WHERE: any tier matches.
  const whereParts = tierClauses.map((c) => c.where)
  const where = whereParts.length === 1 ? whereParts[0] : `(${whereParts.join(' OR ')})`

  return { where, rankExpr, tierClauses }
}
