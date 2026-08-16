/** Round a rough step up to the nearest "nice" value (1, 2, 5 × 10ⁿ). */
export function niceStep(rough: number): number {
  if (rough <= 0 || !isFinite(rough)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}

/**
 * Compute a "nice" axis domain and round tick values (e.g. 1500, 2000, 2500) for a
 * data range, so recharts doesn't pick ugly ticks like 1615, 2076. Returns null for
 * empty/degenerate data (caller falls back to recharts defaults).
 */
export function niceTicks(
  values: number[],
  startAtZero = false,
  targetTicks = 6,
): { domain: [number, number]; ticks: number[] } | null {
  const finite = values.filter((v) => isFinite(v))
  if (finite.length === 0) return null
  let lo = Math.min(...finite)
  let hi = Math.max(...finite)
  if (startAtZero && lo > 0) lo = 0
  if (startAtZero && hi < 0) hi = 0
  if (lo === hi) { lo -= 1; hi += 1 }
  const step = niceStep((hi - lo) / Math.max(1, targetTicks - 1))
  const niceLo = Math.floor(lo / step) * step
  const niceHi = Math.ceil(hi / step) * step
  // Round to the step's decimal precision to avoid float drift (e.g. 0.6000000000000001).
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const round = (v: number) => Number(v.toFixed(decimals + 1))
  const ticks: number[] = []
  for (let i = 0; niceLo + i * step <= niceHi + step * 1e-9; i++) ticks.push(round(niceLo + i * step))
  return { domain: [round(niceLo), round(niceHi)], ticks }
}

/**
 * Tight histogram axis: the domain hugs the real [min, max] (padded half a bin)
 * with round ticks laid *inside* it. Unlike niceTicks, the low bound tracks the
 * data min instead of flooring to 0, so a range like 467..6025 starts near 467.
 */
export function tightHistogramScale(
  xs: number[],
): { domain: [number, number]; ticks: number[] } | null {
  const finite = xs.filter((v) => isFinite(v))
  if (finite.length === 0) return null
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  if (min === max) return niceTicks(finite)
  const binWidth = finite.length > 1 ? (max - min) / (finite.length - 1) : 1
  const lo = min - binWidth / 2
  const hi = max + binWidth / 2
  const step = niceStep((max - min) / 7)
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const round = (v: number) => Number(v.toFixed(decimals + 1))
  const firstTick = Math.ceil(lo / step) * step
  const ticks: number[] = []
  for (let v = firstTick; v <= hi + step * 1e-9; v += step) ticks.push(round(v))
  return { domain: [round(lo), round(hi)], ticks }
}
