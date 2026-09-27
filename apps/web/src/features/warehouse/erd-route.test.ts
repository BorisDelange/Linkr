import { describe, expect, it } from 'vitest'
import { roundedPath, routeOrthogonal, simplify, type Point, type Rect } from './erd-route'

/** Whether a horizontal or vertical segment passes through the inside of a box. */
function crosses(a: Point, b: Point, r: Rect): boolean {
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
  return x1 < r.x + r.w && x2 > r.x && y1 < r.y + r.h && y2 > r.y
}

const orthogonal = (pts: Point[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y)

describe('routeOrthogonal', () => {
  it('goes straight between two facing boxes', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 }
    const b = { x: 300, y: 0, w: 100, h: 100 }
    expect(routeOrthogonal({ x: 100, y: 50 }, 1, { x: 300, y: 50 }, -1, [a, b])).toEqual([{ x: 100, y: 50 }, { x: 300, y: 50 }])
  })

  it('runs around a box in the way instead of under it', () => {
    const src = { x: 0, y: 0, w: 100, h: 100 }
    const wall = { x: 200, y: -50, w: 100, h: 200 }
    const dst = { x: 400, y: 0, w: 100, h: 100 }
    const path = routeOrthogonal({ x: 100, y: 50 }, 1, { x: 400, y: 50 }, -1, [src, wall, dst])!
    expect(path).not.toBeNull()
    expect(orthogonal(path)).toBe(true)
    for (let k = 1; k < path.length; k++) expect(crosses(path[k - 1], path[k], wall)).toBe(false)
  })

  it('reaches a target to the left of its source, entering it from the left', () => {
    // An FK table right of the table it references: the link must loop round.
    const dst = { x: 0, y: 0, w: 100, h: 100 }
    const src = { x: 200, y: 0, w: 100, h: 100 }
    const path = routeOrthogonal({ x: 300, y: 50 }, 1, { x: 0, y: 30 }, -1, [dst, src])!
    expect(orthogonal(path)).toBe(true)
    for (let k = 2; k < path.length - 1; k++) {
      expect(crosses(path[k - 1], path[k], dst)).toBe(false)
      expect(crosses(path[k - 1], path[k], src)).toBe(false)
    }
    const [beforeLast, last] = path.slice(-2)
    expect(beforeLast.y).toBe(last.y)
    expect(beforeLast.x).toBeLessThan(last.x)
  })

  it('gives up when the target is walled in', () => {
    const dst = { x: 100, y: 0, w: 100, h: 100 }
    const cage = [
      { x: -40, y: -40, w: 300, h: 20 },
      { x: -40, y: 120, w: 300, h: 20 },
      { x: -40, y: -40, w: 20, h: 180 },
      { x: 240, y: -40, w: 20, h: 180 },
    ]
    expect(routeOrthogonal({ x: 600, y: 50 }, 1, { x: 100, y: 50 }, -1, [dst, ...cage, { x: 500, y: 0, w: 100, h: 100 }])).toBeNull()
  })
})

describe('simplify', () => {
  it('keeps only the corners', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }])).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 },
    ])
  })
})

describe('roundedPath', () => {
  it('rounds each corner with a curve', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], 5)).toBe('M 0 0 L 15 0 Q 20 0 20 5 L 20 20')
  })
})
