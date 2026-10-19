/**
 * Coercion of DuckDB result values into JS primitives.
 *
 * The same logical timestamp comes back in different shapes depending on the
 * path it took: DuckDB-WASM returns Arrow values (Date, or BigInt microseconds),
 * while the server mode returns JSON (ISO strings, or numbers). Widgets that
 * plot time have to accept all of them, so the rule lives here once instead of
 * being re-derived per widget.
 */

/** Epoch milliseconds for a DuckDB timestamp value, or null when unusable. */
export function toMs(value: unknown): number | null {
  if (value == null) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : ms
  }
  // Arrow timestamps arrive as BigInt microseconds since epoch.
  if (typeof value === 'bigint') return Number(value / 1000n)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  const s = String(value).trim()
  if (!s) return null
  // "2024-01-15 14:30:00" is not ISO-8601 until the space becomes a T; without
  // this, Safari returns NaN where Chrome happens to parse it.
  const normalized = s.includes('T') || !s.includes(' ') ? s : s.replace(' ', 'T')
  // A naive timestamp (the server's `.isoformat()` of a TIMESTAMP) is read as
  // UTC, as DuckDB-WASM's epoch values and `epoch_ms()` are: read as local
  // time, it would shift by the browser's offset.
  const ms = new Date(NAIVE_DATETIME.test(normalized) ? `${normalized}Z` : normalized).getTime()
  return Number.isNaN(ms) ? null : ms
}

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** Same as `toMs`, as a Date, falling back to the epoch for unusable values. */
export function toDate(value: unknown): Date {
  return new Date(toMs(value) ?? 0)
}

const ARROW_BIG_NUM = Symbol.for('isArrowBigNum')

/**
 * A 128-bit Arrow value (DuckDB's HUGEINT — what `SUM` of an integer returns —
 * and DECIMAL) as a number, `scale` digits after the point. Arrow hands these
 * back as typed-array objects whose JSON form is a quoted string, so left as is
 * they showed as `"\"15\""` and typed as text. Anything else is returned as is.
 */
export function fromArrowBigNum(value: unknown, scale = 0): unknown {
  if (value == null || typeof value !== 'object' || !(ARROW_BIG_NUM in value)) return value
  // Arrow's own conversion divides by `BigInt(Math.pow(10, scale))`, which is no
  // longer a power of ten past 10^22: parse the exact integer digits instead.
  if (scale > 15) return Number(`${String(value)}e-${scale}`)
  return (value as { valueOf(scale?: number): number }).valueOf(scale)
}
