/**
 * The versionable form of the similarity scores: one CSV per method.
 *
 * A parquet cannot be diffed or merged, so a method the user marks "versioned"
 * travels as `similarity-scores/<method>.csv` (e.g.
 * `similarity-scores/ai/claude-opus-4-8.csv`). One file per method keeps a diff
 * local to the method that changed, and removing a method removes a file.
 *
 * Twin of the CSV section of `apps/api/app/services/data/scores_service.py`: the
 * SQL built here is the same text on both sides, so a front-only and a server
 * instance write the same bytes. The path rule itself is part of the export
 * format, so it lives in @linkr/format with the validator that checks it.
 */
import {
  SCORES_CSV_REQUIRED_COLUMNS as CSV_REQUIRED_COLUMNS,
  scoreCsvPath as csvPathForMethod,
  scoreMethodOfPath as methodForCsvPath,
} from '@linkr/format'

export { SCORES_CSV_DIR } from '@linkr/format'
export { CSV_REQUIRED_COLUMNS, csvPathForMethod, methodForCsvPath }

export const SCORES_PARQUET_FILE = 'similarity-scores.parquet'
/** Written only when the method has a non-empty value in them, so an all-blank
 *  column does not cost a comma per row. */
export const CSV_OPTIONAL_COLUMNS = [
  'equivalence',
  'comment',
  'created_at',
  'concept_set_uid',
  'concept_set_source_repo',
] as const

export type ScoresExportFormat = 'csv' | 'parquet'

/** Above this, a versioned CSV gets a warning: GitHub rejects files over 100 MB
 *  and warns from 50 MB, GitLab instances often cap lower. */
export const GIT_FRIENDLY_CSV_BYTES = 50 * 1024 * 1024

export interface ScoreMethodStat {
  method: string
  rowCount: number
  /** Size its CSV would have, exact up to quoting. */
  csvBytes: number
  /** False when the method name cannot be a file path. */
  versionable: boolean
}

/** Does `bytes` open with a scores CSV header? Tells a real file from the HTML
 *  shell a static host serves for a missing path. */
export function isScoresCsv(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 64))
  return head.startsWith(`${CSV_REQUIRED_COLUMNS[0]},`)
}

/** The `{method: bytes}` of every per-method score CSV in an export tree. */
export function scoreCsvsInTree<T>(files: Record<string, T>): { method: string; content: T }[] {
  const out: { method: string; content: T }[] = []
  for (const [path, content] of Object.entries(files)) {
    const method = methodForCsvPath(path)
    if (method) out.push({ method, content })
  }
  return out.sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** SELECT list of a method's CSV: the key, the score rounded to four decimals
 *  (so an unchanged method rewrites the same bytes), then the optional columns
 *  the method fills. */
export function csvSelectList(presentOptional: readonly string[]): string {
  return [
    'source_vocabulary_id',
    'source_concept_code',
    'CAST(concept_id AS VARCHAR) AS concept_id',
    "printf('%.4f', score) AS score",
    ...presentOptional.map((c) => `NULLIF(CAST(${c} AS VARCHAR), '') AS ${c}`),
  ].join(', ')
}

/** The COPY writing one method's CSV from `source` (a parquet path) to `outPath`. */
export function methodCsvCopySql(source: string, method: string, presentOptional: readonly string[], outPath: string): string {
  return `COPY (SELECT ${csvSelectList(presentOptional)} FROM read_parquet(${sqlLiteral(source)}) `
    + `WHERE method = ${sqlLiteral(method)} ORDER BY source_vocabulary_id, source_concept_code, concept_id) `
    + `TO ${sqlLiteral(outPath)} (FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '"', ESCAPE '"', NULL '')`
}

/** Per-method row count + CSV size estimate over `source`. */
export function methodStatsSql(source: string, parquetColumns: ReadonlySet<string>): string {
  const optional = CSV_OPTIONAL_COLUMNS.filter((c) => parquetColumns.has(c))
  const lengths = [
    'strlen(source_vocabulary_id)',
    'strlen(source_concept_code)',
    'strlen(CAST(concept_id AS VARCHAR))',
    "strlen(printf('%.4f', score))",
    ...optional.map((c) => `coalesce(strlen(CAST(${c} AS VARCHAR)), 0)`),
  ].join(' + ')
  const separators = CSV_REQUIRED_COLUMNS.length + optional.length
  return `SELECT method, COUNT(*) AS n, SUM(${lengths} + ${separators}) AS bytes FROM read_parquet(${sqlLiteral(source)}) `
    + "WHERE method IS NOT NULL AND method <> '' GROUP BY method ORDER BY method"
}

/** SELECT reading one method's CSV back into the scores-parquet shape. */
export function csvToScoresSelect(csvSource: string, method: string, csvColumns: ReadonlySet<string>): string {
  const optional = CSV_OPTIONAL_COLUMNS.map((c) => `${csvColumns.has(c) ? c : 'NULL'}::VARCHAR AS ${c}`).join(', ')
  return 'SELECT source_vocabulary_id, source_concept_code, CAST(concept_id AS BIGINT) AS concept_id, '
    + `${sqlLiteral(method)} AS method, CAST(score AS DOUBLE) AS score, ${optional} `
    + `FROM read_csv(${sqlLiteral(csvSource)}, header=true, all_varchar=true)`
}

/** A byte size in MB, one decimal. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
