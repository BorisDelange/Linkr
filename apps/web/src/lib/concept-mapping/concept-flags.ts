/**
 * OMOP flag columns as stored: `standard_concept` is 'S' (standard), 'C'
 * (classification) or NULL; `invalid_reason` is 'D' (deleted), 'U' (upgraded)
 * or NULL.
 *
 * Vocabulary tables reach us through DuckDB over parquet/CSV, where these are
 * often fixed-width CHAR(1) — so a value arrives padded ('S ') or, on a CSV
 * import, lowercased. Comparing it raw against 'S' silently fails and every row
 * reads as non-standard, which is what the OHDSI vocabulary browser did.
 */
export function normalizeConceptFlag(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim().toUpperCase()
  return text === '' ? null : text
}
