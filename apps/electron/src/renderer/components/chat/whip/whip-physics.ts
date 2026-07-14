/**
 * Small, original Verlet-integration rope solver used by the Whip physics overlay.
 * Standard distance-constraint rope simulation (point-mass chain + relaxation) —
 * not a port of any third-party whip/rope implementation. Kept free of the DOM
 * so it can be unit tested directly.
 */

export interface WhipVec {
  x: number
  y: number
}

export interface WhipPoint extends WhipVec {
  oldX: number
  oldY: number
  pinned: boolean
}

export interface WhipRopeConfig {
  /** Point count is segmentCount + 1. */
  segmentCount: number
  segmentLength: number
  gravity: number
  /** Per-step velocity retention, 0..1. */
  damping: number
  constraintIterations: number
}

export const DEFAULT_WHIP_ROPE_CONFIG: WhipRopeConfig = {
  segmentCount: 20,
  segmentLength: 10,
  gravity: 0.45,
  damping: 0.94,
  constraintIterations: 6,
}

/** Builds a straight, taut rope hanging from `anchor`, pinned only at the first point. */
export function createWhipRope(anchor: WhipVec, config: WhipRopeConfig = DEFAULT_WHIP_ROPE_CONFIG): WhipPoint[] {
  const points: WhipPoint[] = []
  for (let i = 0; i <= config.segmentCount; i++) {
    const x = anchor.x
    const y = anchor.y + i * config.segmentLength
    points.push({ x, y, oldX: x, oldY: y, pinned: i === 0 })
  }
  return points
}

/** Repins the rope's anchor (point 0) to a new position and clears any residual velocity there. */
export function setWhipAnchor(points: WhipPoint[], anchor: WhipVec): void {
  const head = points[0]
  if (!head) return
  head.x = anchor.x
  head.y = anchor.y
  head.oldX = anchor.x
  head.oldY = anchor.y
}

/** Nudges a point's previous position to give it Verlet velocity on the next step. No-op on pinned points. */
export function applyWhipImpulse(points: WhipPoint[], index: number, impulse: WhipVec): void {
  const p = points[index]
  if (!p || p.pinned) return
  p.oldX -= impulse.x
  p.oldY -= impulse.y
}

function integrateWhipRope(points: WhipPoint[], config: WhipRopeConfig): void {
  for (const p of points) {
    if (p.pinned) continue
    const vx = (p.x - p.oldX) * config.damping
    const vy = (p.y - p.oldY) * config.damping
    const nextX = p.x + vx
    const nextY = p.y + vy + config.gravity
    p.oldX = p.x
    p.oldY = p.y
    p.x = nextX
    p.y = nextY
  }
}

function satisfyWhipConstraints(points: WhipPoint[], config: WhipRopeConfig): void {
  for (let iter = 0; iter < config.constraintIterations; iter++) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001
      const diff = (dist - config.segmentLength) / dist
      const offsetX = dx * 0.5 * diff
      const offsetY = dy * 0.5 * diff
      if (!a.pinned) {
        a.x += offsetX
        a.y += offsetY
      }
      if (!b.pinned) {
        b.x -= offsetX
        b.y -= offsetY
      }
    }
  }
}

/** Advances the rope one simulation step: Verlet integration + distance-constraint relaxation. Mutates `points` in place. */
export function stepWhipRope(points: WhipPoint[], config: WhipRopeConfig = DEFAULT_WHIP_ROPE_CONFIG): void {
  integrateWhipRope(points, config)
  satisfyWhipConstraints(points, config)
}

export interface WhipCanvasSize {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  scale: number
}

/** Caps devicePixelRatio at 2 and computes backing-store pixel dimensions for a crisp, bounded canvas. */
export function computeWhipCanvasSize(rect: { width: number; height: number }, devicePixelRatio: number): WhipCanvasSize {
  const scale = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, 2)
  const cssWidth = Math.max(0, rect.width)
  const cssHeight = Math.max(0, rect.height)
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.round(cssWidth * scale)),
    pixelHeight: Math.max(1, Math.round(cssHeight * scale)),
    scale,
  }
}

/** Picks a sensible rope anchor before any pointer movement has been recorded in the container, so the rope never spawns at a crash-prone/undefined position. */
export function resolveInitialWhipAnchor(pointer: WhipVec | null, container: { width: number; height: number }): WhipVec {
  if (pointer) return pointer
  return { x: container.width / 2, y: Math.min(48, container.height * 0.18) }
}

// ---------------------------------------------------------------------------
// Presentation geometry + strike timeline (pure, DOM-free, unit-tested).
//
// The overlay renders a tapered leather lash rather than a flat line, and drives
// a staged "crack" (windup -> snap -> follow-through) instead of teleporting the
// tip. Both need deterministic geometry helpers, kept here alongside the solver.
// ---------------------------------------------------------------------------

/**
 * Handle sits up-and-to-the-left of the pointer/strike point, so the grip reads
 * like a hand holding the whip while the lash cracks down toward the click. A
 * fixed direction also gives the snap a consistent axis to travel along.
 */
export const WHIP_HANDLE_OFFSET: WhipVec = { x: -34, y: -46 }

/** Places the whip's grip relative to a base point (pointer or strike), clamped inside the container so it never drifts off-canvas. */
export function resolveWhipHandleAnchor(base: WhipVec, container: { width: number; height: number }): WhipVec {
  const maxX = Math.max(4, container.width - 4)
  const maxY = Math.max(4, container.height - 4)
  return {
    x: Math.min(Math.max(base.x + WHIP_HANDLE_OFFSET.x, 4), maxX),
    y: Math.min(Math.max(base.y + WHIP_HANDLE_OFFSET.y, 4), maxY),
  }
}

/** Half-width of the lash at normalized length `t` (0 = grip end, 1 = tip). Eased taper so the cord is fat near the handle and needle-thin at the cracker. */
export function whipWidthAt(t: number, base: number, tip: number, exponent = 1.6): number {
  const c = Math.min(Math.max(t, 0), 1)
  return tip + (base - tip) * Math.pow(1 - c, exponent)
}

function catmullRom(p0: WhipVec, p1: WhipVec, p2: WhipVec, p3: WhipVec, t: number): WhipVec {
  const t2 = t * t
  const t3 = t2 * t
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}

/**
 * Smooths the jointed Verlet chain into a flowing centerline via Catmull-Rom
 * interpolation. Returns `(points.length - 1) * subdivisions + 1` samples with
 * the original endpoints preserved, so the rendered lash curves instead of
 * showing polygon kinks.
 */
export function smoothWhipSpine(points: WhipVec[], subdivisions: number): WhipVec[] {
  const n = points.length
  if (n < 2 || subdivisions < 1) return points.map(p => ({ x: p.x, y: p.y }))
  const out: WhipVec[] = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? points[i + 1]
    for (let s = 0; s < subdivisions; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / subdivisions))
    }
  }
  out.push({ x: points[n - 1].x, y: points[n - 1].y })
  return out
}

/** Offsets a spine into left/right edge polylines by pushing each sample along its local normal by the matching half-width — the outline of the tapered ribbon. */
export function offsetWhipEdges(spine: WhipVec[], halfWidths: number[]): { left: WhipVec[]; right: WhipVec[] } {
  const left: WhipVec[] = []
  const right: WhipVec[] = []
  const n = spine.length
  for (let i = 0; i < n; i++) {
    const prev = spine[Math.max(0, i - 1)]
    const next = spine[Math.min(n - 1, i + 1)]
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const len = Math.hypot(tx, ty) || 1
    tx /= len
    ty /= len
    const nx = -ty
    const ny = tx
    const hw = halfWidths[i] ?? halfWidths[halfWidths.length - 1] ?? 0
    left.push({ x: spine[i].x + nx * hw, y: spine[i].y + ny * hw })
    right.push({ x: spine[i].x - nx * hw, y: spine[i].y - ny * hw })
  }
  return { left, right }
}

export interface WhipStrikeConfig {
  /** Fraction of the strike spent recoiling back (visible backswing/anticipation). */
  recoilFraction: number
  /** Fraction (of the whole) at which the forward strike completes and impact lands. */
  strikeFraction: number
  /** Pixels the tip is drawn back along the strike axis during the recoil. */
  cockBack: number
  /** Pixels the tip lifts up during the recoil. */
  cockLift: number
  /** Pixels the tip drives past the target at the moment of the strike. */
  overshoot: number
  /** Pixels the grip recoils backward along the strike axis. */
  handleBack: number
  /** Pixels the grip thrusts forward along the strike axis during the strike. */
  handleThrust: number
  /** Pixels the grip lifts up during the recoil. */
  handleLift: number
}

// A whip strike is a planned attack, not a physics curl: the whole whip recoils
// away from the target (visible backswing), holds a beat of tension, then drives
// forward THROUGH the clicked point (accelerating snap) before following through.
/** Left-click tease: a lighter but still obvious backswing-and-strike. */
export const MILD_WHIP_STRIKE: WhipStrikeConfig = {
  recoilFraction: 0.34, strikeFraction: 0.56, cockBack: 46, cockLift: 34, overshoot: 42,
  handleBack: 14, handleThrust: 10, handleLift: 10,
}
/** Right-click interrupt: violent — deep recoil, explosive strike, big drive through the target. */
export const STRONG_WHIP_STRIKE: WhipStrikeConfig = {
  recoilFraction: 0.30, strikeFraction: 0.5, cockBack: 74, cockLift: 56, overshoot: 82,
  handleBack: 26, handleThrust: 20, handleLift: 18,
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}
/** Accelerating ease — slow, tense start then an explosive finish; drives the strike. */
function easeInQuart(t: number): number {
  return t * t * t * t
}
function lerpVec(a: WhipVec, b: WhipVec, t: number): WhipVec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

export interface WhipStrikeGeometry {
  /** Where the tip currently sits when the strike begins. */
  restTip: WhipVec
  /** The grip's resting position for this strike. */
  baseHandle: WhipVec
  /** The clicked coordinate — the attack target. */
  strike: WhipVec
}

export interface WhipStrikePose {
  /** Kinematic grip position for this frame (drives the whole-body recoil/thrust). */
  handle: WhipVec
  /** Kinematic tip position for this frame (pinned; middle segments lag into a wave). */
  tip: WhipVec
  /** True from the instant the forward strike lands through the target onward. */
  impact: boolean
}

/**
 * Staged, planned whip-strike pose for a given progress in [0,1]. Three stages:
 * recoil (whole whip pulls back/up from the target — anticipation), strike (grip
 * thrusts forward while the tip accelerates THROUGH the target past it), and settle
 * (tip eases back onto the exact target, grip returns). Driving BOTH the grip and
 * the tip kinematically — not just physics — makes the hit read as a forceful
 * back-then-strike rather than a decorative curl. `impact` flips true at the strike
 * moment so the caller can fire the crack flash exactly when the lash lands. Pure.
 */
export function whipStrikePose(progress: number, config: WhipStrikeConfig, geom: WhipStrikeGeometry): WhipStrikePose {
  const { restTip, baseHandle, strike } = geom
  if (progress <= 0) return { handle: { ...baseHandle }, tip: { ...restTip }, impact: false }
  if (progress >= 1) return { handle: { ...baseHandle }, tip: { ...strike }, impact: true }

  let dx = strike.x - baseHandle.x
  let dy = strike.y - baseHandle.y
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len

  const cockedTip: WhipVec = { x: strike.x - dx * config.cockBack, y: strike.y - dy * config.cockBack - config.cockLift }
  const throughTip: WhipVec = { x: strike.x + dx * config.overshoot, y: strike.y + dy * config.overshoot }
  const backHandle: WhipVec = { x: baseHandle.x - dx * config.handleBack, y: baseHandle.y - dy * config.handleBack - config.handleLift }
  const fwdHandle: WhipVec = { x: baseHandle.x + dx * config.handleThrust, y: baseHandle.y + dy * config.handleThrust }

  const r = config.recoilFraction
  const s = config.strikeFraction
  if (progress < r) {
    const lp = easeOutCubic(progress / r)
    return { handle: lerpVec(baseHandle, backHandle, lp), tip: lerpVec(restTip, cockedTip, lp), impact: false }
  }
  if (progress < s) {
    const lp = easeInQuart((progress - r) / (s - r))
    return { handle: lerpVec(backHandle, fwdHandle, lp), tip: lerpVec(cockedTip, throughTip, lp), impact: false }
  }
  const lp = easeOutCubic((progress - s) / (1 - s))
  return { handle: lerpVec(fwdHandle, baseHandle, lp), tip: lerpVec(throughTip, strike, lp), impact: true }
}

/** Low-pass step toward a target (target-following with inertia); `factor` in (0,1] is the per-frame catch-up fraction. Pure — used to smooth the grip so it feels heavy, not jittery. */
export function lowPassTowards(current: WhipVec, target: WhipVec, factor: number): WhipVec {
  const f = Math.min(Math.max(factor, 0), 1)
  return { x: current.x + (target.x - current.x) * f, y: current.y + (target.y - current.y) * f }
}
