/**
 * Perturbation of published counts — the cell key method (Eurostat's
 * recommendation for the 2021 census, ABS TableBuilder).
 *
 * Every patient gets a fixed pseudo-random key in [0, 2^32): md5 of the
 * database id and the patient id, so every catalog of a database shares it.
 * A cell's key is the sum of its patients' keys, mod 2^32 — the computation
 * stores it with the counts (`key` on a crossing row, `patientKey` on a
 * concept, `totalKey` on the totals). The key fixes each count's noise, an
 * integer in [-noise, noise]:
 * - the same cell always gets the same noise, in every table and every
 *   republication, so publishing again and averaging learns nothing;
 * - a cell with other patients gets another noise, so subtracting two
 *   publications does not cancel it;
 * - a total and the cells it adds up get independent noises, so the
 *   subtractions a masked cell was recovered by only give it within a few
 *   times the noise.
 *
 * The threshold still applies to the exact counts: a cell below it is masked,
 * never shown perturbed. A published cell's patients never read below the
 * threshold, so the noise cannot make a shown cell look like a masked one.
 */

import type { CatalogMeasure } from '@/types/catalog'

/** Cell keys live in [0, KEY_SPACE). */
export const KEY_SPACE = 2 ** 32

/** The SQL of one patient's key: stable across DuckDB builds (md5, not `hash`). */
export function patientKeySql(patientIdExpr: string, salt: string): string {
  return `(md5_number_lower('${salt.replace(/'/g, "''")}' || CAST(${patientIdExpr} AS VARCHAR)) % ${KEY_SPACE})`
}

/** Two cell keys added, as the sum of two disjoint sets of patients. */
export function addKeys(a: number | undefined, b: number | undefined): number | undefined {
  if (a == null || b == null) return a ?? b
  return (a + b) % KEY_SPACE
}

const MEASURE_INDEX: Record<CatalogMeasure, number> = { patients: 0, stays: 1, unit_stays: 2, records: 3 }

/** A 32-bit mix (murmur3's finaliser): nearby keys and measures give unrelated noises. */
function mix32(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** The noise of one count of a cell: an integer in [-noise, noise], uniform over the keys. */
export function noiseOf(key: number, measure: CatalogMeasure, noise: number): number {
  if (noise <= 0) return 0
  const u = mix32(key ^ Math.imul(MEASURE_INDEX[measure] + 1, 0x9e3779b9)) / KEY_SPACE
  return Math.min(noise, Math.floor(u * (2 * noise + 1)) - noise)
}

/**
 * A key for a cell whose results predate the keys: from what the cell is,
 * not who is in it. Stable, so republishing still gives the same noise; but
 * two publications of a changed warehouse share it, and their difference
 * cancels it — recomputing gives the real keys.
 */
export function fallbackKey(...parts: string[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) h = Math.imul(h ^ part.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ 0x1f, 0x01000193)
  }
  return mix32(h)
}

/**
 * A count as published: moved by its noise, never negative, and for the
 * patients of a published cell never below the threshold.
 */
export function perturbed(value: number, key: number, measure: CatalogMeasure, noise: number, threshold: number): number {
  if (noise <= 0) return value
  const moved = value + noiseOf(key, measure, noise)
  return Math.max(measure === 'patients' && value >= threshold ? threshold : 0, moved)
}
