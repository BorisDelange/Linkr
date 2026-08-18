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
  const ms = new Date(normalized).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Same as `toMs`, as a Date, falling back to the epoch for unusable values. */
export function toDate(value: unknown): Date {
  return new Date(toMs(value) ?? 0)
}
