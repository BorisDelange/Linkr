import { describe, it, expect } from 'vitest'
import { buildClusterIndex, clusterBackground, clusterDiameter, MAP_CLUSTER_MAX_ZOOM, type MapPoint } from './map-clusters'

const pt = (lat: number, lon: number, color = '#f00'): MapPoint => ({ lat, lon, color, radius: 6 })
const WORLD: [number, number, number, number] = [-180, -85, 180, 85]

describe('buildClusterIndex', () => {
  // Two tight groups: around Rennes and around Marseille.
  const points = [
    pt(48.11, -1.68), pt(48.111, -1.681), pt(48.112, -1.679, '#00f'),
    pt(43.30, 5.37, '#00f'), pt(43.301, 5.371, '#00f'),
  ]

  it('groups nearby points when zoomed out, keeping the total count and color tally', () => {
    const items = buildClusterIndex(points).getClusters(WORLD, 5)
    const clusters = items.filter(f => 'cluster' in f.properties && f.properties.cluster)
    expect(clusters).toHaveLength(2)
    const counts = clusters.map(c => (c.properties as { point_count: number }).point_count).sort()
    expect(counts).toEqual([2, 3])
    const rennes = clusters.find(c => (c.properties as { point_count: number }).point_count === 3)!
    expect((rennes.properties as unknown as { colors: Record<string, number> }).colors).toEqual({ '#f00': 2, '#00f': 1 })
  })

  it('shows every point individually past the max zoom', () => {
    const items = buildClusterIndex(points).getClusters(WORLD, MAP_CLUSTER_MAX_ZOOM + 1)
    expect(items).toHaveLength(points.length)
    expect(items.map(f => (f.properties as { index: number }).index).sort()).toEqual([0, 1, 2, 3, 4])
  })
})

describe('clusterBackground', () => {
  it('slices the colors by share, largest first', () => {
    expect(clusterBackground({ a: 1, b: 3 }, 'x')).toBe('conic-gradient(b 0.00% 75.00%, a 75.00% 100.00%)')
  })
  it('keeps a single color flat', () => {
    expect(clusterBackground({ a: 4 }, 'x')).toBe('a')
  })
  it('falls back when empty', () => {
    expect(clusterBackground({}, 'x')).toBe('x')
  })
})

describe('clusterDiameter', () => {
  it('grows with the order of magnitude', () => {
    expect(clusterDiameter(1)).toBe(24)
    expect(clusterDiameter(10)).toBe(32)
    expect(clusterDiameter(10_000)).toBe(56)
  })
})
