/** Scatter and line plots draw one SVG element per point; past a few thousand the chart
 *  stalls on every redraw (resize, hover) without showing anything more. Server parity:
 *  `_linkr_sample_points` in apps/api/app/services/execution/render/plot_builder.py
 *  (same cap and strategies; the random picks themselves differ). */
export const MAX_PLOT_POINTS = 5000

/** `max` items evenly spaced over `items`, in order — for a line sorted on X, so the
 *  sample keeps the line's full span. */
export function sampleEvenly<T>(items: readonly T[], max = MAX_PLOT_POINTS): T[] {
  if (items.length <= max) return [...items]
  const out: T[] = []
  for (let k = 0; k < max; k++) out.push(items[Math.floor((k * items.length) / max)])
  return out
}

/** `max` items picked at random with a fixed seed, kept in their original order — for a
 *  scatter, where a stride would alias with a periodic row order (interleaved groups,
 *  repeated visits). Deterministic, so a re-render shows the same points. */
export function sampleRandom<T>(items: readonly T[], max = MAX_PLOT_POINTS): T[] {
  if (items.length <= max) return [...items]
  const random = mulberry32(0)
  const idx = Array.from(items, (_, i) => i)
  // Partial Fisher–Yates: the first `max` slots end up a uniform sample.
  for (let k = 0; k < max; k++) {
    const j = k + Math.floor(random() * (idx.length - k))
    ;[idx[k], idx[j]] = [idx[j], idx[k]]
  }
  return idx.slice(0, max).sort((a, b) => a - b).map(i => items[i])
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
