import Supercluster from 'supercluster'

export interface MapPoint {
  lat: number
  lon: number
  color: string
  radius: number
  label?: string
  popup?: { key: string; value: string }[]
}

interface PointProps { index: number; color: string }
/** Point count per marker color, so a cluster can take its majority color. */
interface ClusterProps { colors: Record<string, number> }

export type MapClusterIndex = Supercluster<PointProps, ClusterProps>

/** Past this zoom every point is drawn on its own (a building, roughly). */
export const MAP_CLUSTER_MAX_ZOOM = 16
/** Points closer than this many screen pixels at the current zoom are grouped. Wide
 *  enough that the bubbles (≤ ~60 px) don't overlap. */
const CLUSTER_RADIUS_PX = 60

export function buildClusterIndex(points: readonly MapPoint[]): MapClusterIndex {
  const index: MapClusterIndex = new Supercluster<PointProps, ClusterProps>({
    radius: CLUSTER_RADIUS_PX,
    // Leaflet's 256 px tiles; supercluster's default (512) would halve the radius on screen.
    extent: 256,
    maxZoom: MAP_CLUSTER_MAX_ZOOM,
    map: (p) => ({ colors: { [p.color]: 1 } }),
    // Supercluster copies the accumulator shallowly: `colors` must be replaced, not
    // mutated, or the tally leaks into the clusters of the other zoom levels.
    reduce: (acc, p) => {
      const colors = { ...acc.colors }
      for (const [color, n] of Object.entries(p.colors)) colors[color] = (colors[color] ?? 0) + n
      acc.colors = colors
    },
  })
  index.load(points.map((p, i) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
    properties: { index: i, color: p.color },
  })))
  return index
}

/** CSS background for a cluster bubble: its points' colors as pie slices, largest
 *  first, so a 50/50 mix doesn't read as one category. A single color stays flat. */
export function clusterBackground(colors: Record<string, number>, fallback: string): string {
  const slices = Object.entries(colors).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (slices.length === 0) return fallback
  if (slices.length === 1) return slices[0][0]
  const total = slices.reduce((sum, [, n]) => sum + n, 0)
  let start = 0
  const stops = slices.map(([color, n]) => {
    const end = start + (n / total) * 100
    const stop = `${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`
    start = end
    return stop
  })
  return `conic-gradient(${stops.join(', ')})`
}

/** Bubble diameter in px: grows with the order of magnitude, not linearly, so a
 *  10 000-point cluster stays readable next to a 20-point one. */
export function clusterDiameter(count: number): number {
  return Math.round(24 + 8 * Math.log10(Math.max(1, count)))
}
