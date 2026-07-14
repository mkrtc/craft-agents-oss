import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WHIP_ROPE_CONFIG,
  MILD_WHIP_STRIKE,
  STRONG_WHIP_STRIKE,
  applyWhipImpulse,
  computeWhipCanvasSize,
  createWhipRope,
  lowPassTowards,
  offsetWhipEdges,
  resolveInitialWhipAnchor,
  resolveWhipHandleAnchor,
  setWhipAnchor,
  smoothWhipSpine,
  stepWhipRope,
  whipStrikePose,
  whipWidthAt,
  type WhipPoint,
  type WhipStrikeGeometry,
  type WhipVec,
} from '../whip-physics'

function cloneRope(points: WhipPoint[]): WhipPoint[] {
  return points.map(p => ({ ...p }))
}

function segmentLengths(points: WhipPoint[]): number[] {
  const lengths: number[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    lengths.push(Math.hypot(b.x - a.x, b.y - a.y))
  }
  return lengths
}

describe('createWhipRope', () => {
  test('creates segmentCount + 1 points', () => {
    const rope = createWhipRope({ x: 0, y: 0 }, { ...DEFAULT_WHIP_ROPE_CONFIG, segmentCount: 20 })
    expect(rope).toHaveLength(21)
  })

  test('pins only the first point', () => {
    const rope = createWhipRope({ x: 5, y: 5 }, DEFAULT_WHIP_ROPE_CONFIG)
    expect(rope[0].pinned).toBe(true)
    expect(rope.slice(1).every(p => !p.pinned)).toBe(true)
  })

  test('lays out points segmentLength apart, hanging straight down from the anchor', () => {
    const config = { ...DEFAULT_WHIP_ROPE_CONFIG, segmentCount: 4, segmentLength: 10 }
    const rope = createWhipRope({ x: 3, y: 7 }, config)
    expect(rope[0]).toMatchObject({ x: 3, y: 7 })
    expect(segmentLengths(rope)).toEqual([10, 10, 10, 10])
  })
})

describe('stepWhipRope', () => {
  test('preserves segment lengths approximately after many steps', () => {
    const config = { ...DEFAULT_WHIP_ROPE_CONFIG, segmentCount: 20, segmentLength: 10 }
    const rope = createWhipRope({ x: 100, y: 0 }, config)
    for (let i = 0; i < 120; i++) {
      stepWhipRope(rope, config)
    }
    // A damped decorative rope, not a rigid-body solver — allow some stretch under
    // sustained free fall but each link should stay within ~30% of its rest length.
    for (const length of segmentLengths(rope)) {
      expect(Math.abs(length - config.segmentLength)).toBeLessThan(config.segmentLength * 0.3)
    }
  })

  test('is deterministic for a fixed input/config (no randomness)', () => {
    const config = { ...DEFAULT_WHIP_ROPE_CONFIG, segmentCount: 12 }
    const ropeA = createWhipRope({ x: 40, y: 20 }, config)
    const ropeB = cloneRope(ropeA)

    for (let i = 0; i < 30; i++) {
      stepWhipRope(ropeA, config)
      stepWhipRope(ropeB, config)
    }

    expect(ropeA).toEqual(ropeB)
  })

  test('gravity pulls unpinned points downward over time', () => {
    const config = { ...DEFAULT_WHIP_ROPE_CONFIG, segmentCount: 6 }
    const rope = createWhipRope({ x: 0, y: 0 }, config)
    const initialTipY = rope[rope.length - 1].y
    for (let i = 0; i < 30; i++) {
      stepWhipRope(rope, config)
    }
    expect(rope[rope.length - 1].y).toBeGreaterThan(initialTipY)
  })

  test('the pinned anchor point never moves from integration alone', () => {
    const config = DEFAULT_WHIP_ROPE_CONFIG
    const rope = createWhipRope({ x: 12, y: 34 }, config)
    for (let i = 0; i < 50; i++) {
      stepWhipRope(rope, config)
    }
    expect(rope[0]).toMatchObject({ x: 12, y: 34 })
  })
})

describe('setWhipAnchor', () => {
  test('moves the first point and clears its residual velocity', () => {
    const rope = createWhipRope({ x: 0, y: 0 }, DEFAULT_WHIP_ROPE_CONFIG)
    rope[0].oldX = -50
    rope[0].oldY = -50
    setWhipAnchor(rope, { x: 25, y: 60 })
    expect(rope[0]).toMatchObject({ x: 25, y: 60, oldX: 25, oldY: 60 })
  })
})

describe('applyWhipImpulse', () => {
  test('shifts a point old-position to create velocity on the next integration step', () => {
    const rope = createWhipRope({ x: 0, y: 0 }, DEFAULT_WHIP_ROPE_CONFIG)
    const index = rope.length - 1
    const before = { ...rope[index] }
    applyWhipImpulse(rope, index, { x: 5, y: -3 })
    expect(rope[index].oldX).toBe(before.oldX - 5)
    expect(rope[index].oldY).toBe(before.oldY - (-3))
    expect(rope[index].x).toBe(before.x)
    expect(rope[index].y).toBe(before.y)
  })

  test('is a no-op on the pinned anchor point', () => {
    const rope = createWhipRope({ x: 1, y: 2 }, DEFAULT_WHIP_ROPE_CONFIG)
    const before = { ...rope[0] }
    applyWhipImpulse(rope, 0, { x: 100, y: 100 })
    expect(rope[0]).toEqual(before)
  })

  test('is a no-op for an out-of-range index', () => {
    const rope = createWhipRope({ x: 0, y: 0 }, DEFAULT_WHIP_ROPE_CONFIG)
    expect(() => applyWhipImpulse(rope, 999, { x: 1, y: 1 })).not.toThrow()
  })
})

describe('computeWhipCanvasSize', () => {
  test('passes through a normal devicePixelRatio', () => {
    const size = computeWhipCanvasSize({ width: 200, height: 100 }, 1.5)
    expect(size.scale).toBe(1.5)
    expect(size.pixelWidth).toBe(300)
    expect(size.pixelHeight).toBe(150)
  })

  test('caps devicePixelRatio at 2 for high-DPI displays', () => {
    const size = computeWhipCanvasSize({ width: 100, height: 50 }, 3)
    expect(size.scale).toBe(2)
    expect(size.pixelWidth).toBe(200)
    expect(size.pixelHeight).toBe(100)
  })

  test('falls back to a scale of 1 for zero/negative devicePixelRatio', () => {
    expect(computeWhipCanvasSize({ width: 10, height: 10 }, 0).scale).toBe(1)
    expect(computeWhipCanvasSize({ width: 10, height: 10 }, -1).scale).toBe(1)
  })

  test('never returns a zero-area backing store for a zero-size container', () => {
    const size = computeWhipCanvasSize({ width: 0, height: 0 }, 2)
    expect(size.pixelWidth).toBeGreaterThanOrEqual(1)
    expect(size.pixelHeight).toBeGreaterThanOrEqual(1)
  })
})

describe('resolveInitialWhipAnchor', () => {
  test('uses the pointer position when available', () => {
    const anchor = resolveInitialWhipAnchor({ x: 42, y: 17 }, { width: 400, height: 300 })
    expect(anchor).toEqual({ x: 42, y: 17 })
  })

  test('falls back to a top-center-ish default before the pointer has moved', () => {
    const anchor = resolveInitialWhipAnchor(null, { width: 400, height: 300 })
    expect(anchor).toEqual({ x: 200, y: 48 })
  })

  test('never throws for a zero-size container', () => {
    expect(() => resolveInitialWhipAnchor(null, { width: 0, height: 0 })).not.toThrow()
    expect(resolveInitialWhipAnchor(null, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('resolveWhipHandleAnchor', () => {
  test('offsets the grip up-and-left of the base point', () => {
    const anchor = resolveWhipHandleAnchor({ x: 200, y: 200 }, { width: 400, height: 400 })
    expect(anchor.x).toBeLessThan(200)
    expect(anchor.y).toBeLessThan(200)
  })

  test('clamps the grip inside the container', () => {
    const anchor = resolveWhipHandleAnchor({ x: 5, y: 5 }, { width: 400, height: 400 })
    expect(anchor.x).toBeGreaterThanOrEqual(4)
    expect(anchor.y).toBeGreaterThanOrEqual(4)
  })

  test('never throws for a zero-size container', () => {
    expect(() => resolveWhipHandleAnchor({ x: 0, y: 0 }, { width: 0, height: 0 })).not.toThrow()
  })
})

describe('whipWidthAt', () => {
  test('returns the base width at the grip and the tip width at the cracker', () => {
    expect(whipWidthAt(0, 5, 0.5)).toBeCloseTo(5)
    expect(whipWidthAt(1, 5, 0.5)).toBeCloseTo(0.5)
  })

  test('tapers monotonically from grip to tip', () => {
    let prev = Infinity
    for (let t = 0; t <= 1; t += 0.1) {
      const w = whipWidthAt(t, 5, 0.5)
      expect(w).toBeLessThanOrEqual(prev + 1e-9)
      prev = w
    }
  })

  test('clamps out-of-range t', () => {
    expect(whipWidthAt(-1, 5, 0.5)).toBeCloseTo(5)
    expect(whipWidthAt(2, 5, 0.5)).toBeCloseTo(0.5)
  })
})

describe('smoothWhipSpine', () => {
  const line: WhipVec[] = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 20 },
    { x: 0, y: 30 },
  ]

  test('produces (n-1)*subdivisions + 1 samples', () => {
    expect(smoothWhipSpine(line, 4)).toHaveLength((line.length - 1) * 4 + 1)
  })

  test('preserves the endpoints', () => {
    const spine = smoothWhipSpine(line, 4)
    expect(spine[0]).toEqual({ x: 0, y: 0 })
    expect(spine[spine.length - 1]).toEqual({ x: 0, y: 30 })
  })

  test('returns a copy of the points for degenerate input', () => {
    expect(smoothWhipSpine([{ x: 1, y: 2 }], 4)).toEqual([{ x: 1, y: 2 }])
    expect(smoothWhipSpine(line, 0)).toEqual(line)
  })
})

describe('offsetWhipEdges', () => {
  test('offsets a vertical spine horizontally by the half-width', () => {
    const spine: WhipVec[] = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 0, y: 20 },
    ]
    const { left, right } = offsetWhipEdges(spine, [2, 2, 2])
    // Left edge sits to one side, right edge to the other, each 2px off the spine.
    expect(Math.abs(left[1].x)).toBeCloseTo(2)
    expect(Math.abs(right[1].x)).toBeCloseTo(2)
    expect(left[1].x).toBeCloseTo(-right[1].x)
    expect(left[1].y).toBeCloseTo(10)
  })

  test('returns one edge point per spine sample', () => {
    const spine: WhipVec[] = [{ x: 0, y: 0 }, { x: 5, y: 5 }]
    const { left, right } = offsetWhipEdges(spine, [1, 1])
    expect(left).toHaveLength(2)
    expect(right).toHaveLength(2)
  })
})

describe('whipStrikePose', () => {
  const geom: WhipStrikeGeometry = {
    restTip: { x: 0, y: 200 },
    baseHandle: { x: 0, y: 0 },
    strike: { x: 100, y: 100 },
  }
  const axisLen = Math.hypot(geom.strike.x - geom.baseHandle.x, geom.strike.y - geom.baseHandle.y)
  const proj = (p: WhipVec) =>
    ((p.x - geom.baseHandle.x) * (geom.strike.x - geom.baseHandle.x) +
      (p.y - geom.baseHandle.y) * (geom.strike.y - geom.baseHandle.y)) / axisLen

  test('starts at rest (tip=restTip, grip=baseHandle) with no impact yet', () => {
    const pose = whipStrikePose(0, MILD_WHIP_STRIKE, geom)
    expect(pose.tip).toEqual(geom.restTip)
    expect(pose.handle).toEqual(geom.baseHandle)
    expect(pose.impact).toBe(false)
  })

  test('ends exactly on the strike coordinate with the grip returned, impact true', () => {
    const pose = whipStrikePose(1, MILD_WHIP_STRIKE, geom)
    expect(pose.tip).toEqual(geom.strike)
    expect(pose.handle).toEqual(geom.baseHandle)
    expect(pose.impact).toBe(true)
  })

  test('recoils the tip back (short of the target) during the backswing, no impact', () => {
    const pose = whipStrikePose(MILD_WHIP_STRIKE.recoilFraction * 0.999, MILD_WHIP_STRIKE, geom)
    expect(proj(pose.tip)).toBeLessThan(axisLen)
    expect(pose.impact).toBe(false)
  })

  test('drives the tip THROUGH (past) the target at the strike moment, impact true', () => {
    const pose = whipStrikePose(MILD_WHIP_STRIKE.strikeFraction, MILD_WHIP_STRIKE, geom)
    expect(proj(pose.tip)).toBeGreaterThan(axisLen)
    expect(pose.impact).toBe(true)
  })

  test('the strong strike drives farther through the target than the mild one', () => {
    const strong = whipStrikePose(STRONG_WHIP_STRIKE.strikeFraction, STRONG_WHIP_STRIKE, geom)
    const mild = whipStrikePose(MILD_WHIP_STRIKE.strikeFraction, MILD_WHIP_STRIKE, geom)
    expect(proj(strong.tip)).toBeGreaterThan(proj(mild.tip))
  })

  test('the grip visibly recoils backward during the backswing', () => {
    const pose = whipStrikePose(MILD_WHIP_STRIKE.recoilFraction * 0.999, MILD_WHIP_STRIKE, geom)
    // Grip pulled back along the axis (and lifted), so its projection goes negative-ish.
    expect(proj(pose.handle)).toBeLessThan(0)
  })
})

describe('lowPassTowards', () => {
  test('moves a fraction of the way toward the target', () => {
    expect(lowPassTowards({ x: 0, y: 0 }, { x: 100, y: 50 }, 0.18)).toEqual({ x: 18, y: 9 })
  })

  test('clamps the factor into [0,1]', () => {
    expect(lowPassTowards({ x: 0, y: 0 }, { x: 10, y: 10 }, 2)).toEqual({ x: 10, y: 10 })
    expect(lowPassTowards({ x: 5, y: 5 }, { x: 10, y: 10 }, -1)).toEqual({ x: 5, y: 5 })
  })

  test('converges toward the target over repeated steps', () => {
    let p: WhipVec = { x: 0, y: 0 }
    for (let i = 0; i < 50; i++) p = lowPassTowards(p, { x: 100, y: 100 }, 0.18)
    expect(p.x).toBeGreaterThan(95)
    expect(p.y).toBeGreaterThan(95)
  })
})
