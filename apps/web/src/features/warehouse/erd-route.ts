export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The way a link leaves its source or enters its target: +1 rightwards, -1 leftwards. */
export type Side = 1 | -1

interface RouteOptions {
  /** Straight run out of a connection point before the first turn. */
  stub?: number
  /** Distance from a box at which links may run past it. */
  clearance?: number
  /** Margin around a box that a link may not cross. */
  pad?: number
  /** Length a turn is worth: higher trades longer links for fewer corners. */
  bendCost?: number
}

// Directions: 0 east, 1 south, 2 west, 3 north.
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/**
 * An orthogonal path from `s` to `t` that runs around `obstacles` instead of
 * under them, or null when the boxes wall it in. The path leaves `s` and
 * enters `t` horizontally, on the given sides, as a link between two table
 * rows does.
 *
 * Links run along channels a `clearance` away from each box (plus the lines
 * of the two end points); a shortest path over that grid, where each turn
 * costs `bendCost`, picks the route. The grid is O(boxes²) points, a few
 * thousand for a DDL of tens of tables.
 */
export function routeOrthogonal(s: Point, sSide: Side, t: Point, tSide: Side, obstacles: readonly Rect[], opts: RouteOptions = {}): Point[] | null {
  const { stub = 16, clearance = 16, pad = 6, bendCost = 40 } = opts
  const s1 = { x: s.x + sSide * stub, y: s.y }
  // tSide is the side of the target the link arrives on: it approaches from there.
  const t1 = { x: t.x + tSide * stub, y: t.y }

  const boxes = obstacles.map((r) => ({ l: r.x - pad, r: r.x + r.w + pad, t: r.y - pad, b: r.y + r.h + pad }))
  const xs = uniqueSorted([s1.x, t1.x, ...obstacles.flatMap((r) => [r.x - clearance, r.x + r.w + clearance])])
  const ys = uniqueSorted([s1.y, t1.y, ...obstacles.flatMap((r) => [r.y - clearance, r.y + r.h + clearance])])
  const nx = xs.length
  const ny = ys.length

  const inside = (x: number, y: number) => boxes.some((b) => x > b.l && x < b.r && y > b.t && y < b.b)
  // Whether the step from grid point (i, j) one cell east / south crosses a box.
  const blockedE = new Uint8Array(nx * ny)
  const blockedS = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const y = ys[j]
    const across = boxes.filter((b) => y > b.t && y < b.b)
    for (let i = 0; i + 1 < nx; i++) {
      if (across.some((b) => b.l < xs[i + 1] && b.r > xs[i])) blockedE[j * nx + i] = 1
    }
  }
  for (let i = 0; i < nx; i++) {
    const x = xs[i]
    const across = boxes.filter((b) => x > b.l && x < b.r)
    for (let j = 0; j + 1 < ny; j++) {
      if (across.some((b) => b.t < ys[j + 1] && b.b > ys[j])) blockedS[j * nx + i] = 1
    }
  }

  const start = ys.indexOf(s1.y) * nx + xs.indexOf(s1.x)
  const goal = ys.indexOf(t1.y) * nx + xs.indexOf(t1.x)
  if (inside(s1.x, s1.y) || inside(t1.x, t1.y)) return null
  const startDir = sSide === 1 ? 0 : 2
  const goalDir = tSide === 1 ? 2 : 0

  const cost = new Float64Array(nx * ny * 4).fill(Infinity)
  const prev = new Int32Array(nx * ny * 4).fill(-1)
  const heap = new MinHeap()
  cost[start * 4 + startDir] = 0
  heap.push(0, start * 4 + startDir)

  let end = -1
  while (heap.size) {
    const [d, state] = heap.pop()
    if (d > cost[state]) continue
    const p = state >> 2
    const dir = state & 3
    if (p === goal && dir === goalDir) {
      end = state
      break
    }
    const i = p % nx
    const j = (p - i) / nx
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((dir + 2) & 3)) continue
      const ni = i + DX[nd]
      const nj = j + DY[nd]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const blocked =
        nd === 0 ? blockedE[j * nx + i] : nd === 2 ? blockedE[j * nx + ni] : nd === 1 ? blockedS[j * nx + i] : blockedS[nj * nx + i]
      if (blocked) continue
      const q = nj * nx + ni
      const nState = q * 4 + nd
      const step = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === dir ? 0 : bendCost)
      if (d + step < cost[nState]) {
        cost[nState] = d + step
        prev[nState] = state
        heap.push(d + step, nState)
      }
    }
    // A turn in place at the goal, so an arrival from above or below still ends inward.
    if (p === goal && dir !== goalDir && dir !== ((goalDir + 2) & 3)) {
      const nState = p * 4 + goalDir
      if (d + bendCost < cost[nState]) {
        cost[nState] = d + bendCost
        prev[nState] = state
        heap.push(d + bendCost, nState)
      }
    }
  }
  if (end < 0) return null

  const cells: number[] = []
  for (let st = end; st >= 0; st = prev[st]) {
    const p = st >> 2
    if (cells[cells.length - 1] !== p) cells.push(p)
  }
  cells.reverse()
  const pts = [s, ...cells.map((p) => ({ x: xs[p % nx], y: ys[Math.floor(p / nx)] })), t]
  return simplify(pts)
}

/** Drops points in the middle of a straight run, keeping only the corners. */
export function simplify(pts: Point[]): Point[] {
  const out: Point[] = []
  for (const p of pts) {
    const n = out.length
    if (n && out[n - 1].x === p.x && out[n - 1].y === p.y) continue
    if (n >= 2) {
      const a = out[n - 2]
      const b = out[n - 1]
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop()
    }
    out.push(p)
  }
  return out
}

/** An SVG path through `pts` with each corner rounded, like a smooth-step edge. */
export function roundedPath(pts: Point[], radius = 8): string {
  if (!pts.length) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1]
    const b = pts[k]
    const c = pts[k + 1]
    const r = Math.min(radius, dist(a, b) / 2, dist(b, c) / 2)
    const p1 = toward(b, a, r)
    const p2 = toward(b, c, r)
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const toward = (from: Point, to: Point, r: number) => {
  const len = dist(from, to) || 1
  return { x: from.x + ((to.x - from.x) / len) * r, y: from.y + ((to.y - from.y) / len) * r }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

class MinHeap {
  private keys: number[] = []
  private vals: number[] = []
  get size() {
    return this.keys.length
  }
  push(key: number, val: number) {
    const { keys, vals } = this
    let i = keys.length
    keys.push(key)
    vals.push(val)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      keys[i] = keys[parent]
      vals[i] = vals[parent]
      i = parent
    }
    keys[i] = key
    vals[i] = val
  }
  pop(): [number, number] {
    const { keys, vals } = this
    const top: [number, number] = [keys[0], vals[0]]
    const lastK = keys.pop()!
    const lastV = vals.pop()!
    const n = keys.length
    if (n) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const c = l + 1 < n && keys[l + 1] < keys[l] ? l + 1 : l
        if (keys[c] >= lastK) break
        keys[i] = keys[c]
        vals[i] = vals[c]
        i = c
      }
      keys[i] = lastK
      vals[i] = lastV
    }
    return top
  }
}
