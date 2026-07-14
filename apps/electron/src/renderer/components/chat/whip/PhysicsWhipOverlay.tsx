import * as React from "react"
import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
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
  type WhipStrikeConfig,
  type WhipStrikeGeometry,
  type WhipPoint,
  type WhipVec,
} from "./whip-physics"

export interface WhipEffect {
  id: number
  x: number
  y: number
  /** Right-click (interrupt) hits crack harder/longer than left-click (tease) hits. */
  strong?: boolean
}

interface PhysicsWhipOverlayProps {
  armed: boolean
  effect: WhipEffect | null
  onEffectComplete: () => void
  /** Explicit disarm from the overlay's cancel control. The whip stays armed after hits until this (or processing end/session change) fires. */
  onCancel: () => void
  /** Latest pointer position inside the message container (container-local px), updated by a container-scoped pointermove handler. Null until the pointer has moved while armed. */
  pointerRef: React.RefObject<WhipVec | null>
}

type WhipPhase = 'idle' | 'swing' | 'strike' | 'follow' | 'fade'

interface ImpactState {
  x: number
  y: number
  /** 0 at the moment of impact, 1 when fully faded. */
  progress: number
  strong: boolean
}

// Staged timings: strike (recoil + backswing + drive-through) -> follow-through.
// Follow-through returns to the swing while armed; alpha fade is disarm-only.
// Keep values long enough for a visible backswing and snappy strike.
const STRIKE_DURATION_MS = { mild: 360, strong: 440 }
const FOLLOW_DURATION_MS = { mild: 240, strong: 460 }
const FADE_DURATION_MS = { mild: 260, strong: 360 }
const DISARM_FADE_MS = 200
// Neutral (white/dark) crack flash fired at the strike moment when the lash lands
// through the clicked point — so the impact is felt exactly when it hits.
const IMPACT_MS = { mild: 180, strong: 260 }

// Leather art direction: warm browns for the body, a light warm highlight along
// the upper edge, a dark core near the tip, and a soft drop shadow underneath.
const LEATHER = {
  shadow: '20, 12, 4',
  bodyHandle: '#7a4a22',
  bodyMid: '#8c5a2c',
  bodyTip: '#3f2712',
  highlight: '214, 158, 94',
  grip: '#43290f',
  gripBand: '#26170a',
  brass: '#c8a24a',
  collar: '#d9a15e',
}
// Lash half-widths (css px) at the grip end vs. the cracker tip.
const LASH_BASE_HALF_WIDTH = 4.2
const LASH_TIP_HALF_WIDTH = 0.5
const SPINE_SUBDIVISIONS = 4

/** Ephemeral visual layer for the Whip easter egg: a small original Verlet rope physics rig driving the leather-lash hit/tease animation. */
export function PhysicsWhipOverlay({ armed, effect, onEffectComplete, onCancel, pointerRef }: PhysicsWhipOverlayProps) {
  const { t } = useTranslation()
  const reducedMotion = useReducedMotion()

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const scaleRef = useRef(1)

  const ropeRef = useRef<WhipPoint[] | null>(null)
  const phaseRef = useRef<WhipPhase>('idle')
  const phaseStartRef = useRef(0)
  const strikeConfigRef = useRef<WhipStrikeConfig>(MILD_WHIP_STRIKE)
  const strikeGeomRef = useRef<WhipStrikeGeometry>({ restTip: { x: 0, y: 0 }, baseHandle: { x: 0, y: 0 }, strike: { x: 0, y: 0 } })
  const strikeDurationRef = useRef(STRIKE_DURATION_MS.mild)
  const followDurationRef = useRef(FOLLOW_DURATION_MS.mild)
  const fadeDurationRef = useRef(FADE_DURATION_MS.mild)
  const strongRef = useRef(false)
  const prevTipRef = useRef<WhipVec>({ x: 0, y: 0 })
  // Heavily-smoothed grip position for the idle swing, so moving the pointer eases
  // the whip along instead of snapping it (kills the jitter on fast mouse moves).
  const smoothAnchorRef = useRef<WhipVec | null>(null)
  const armedRef = useRef(armed)
  const impactRef = useRef<{ x: number; y: number; start: number; strong: boolean } | null>(null)
  const impactFiredRef = useRef(false)
  const pendingCompletionRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const lastEffectIdRef = useRef<number | null>(null)
  const onEffectCompleteRef = useRef(onEffectComplete)
  onEffectCompleteRef.current = onEffectComplete

  useEffect(() => {
    armedRef.current = armed
  }, [armed])

  const clearCanvas = useCallback(() => {
    const ctx = ctxRef.current
    const canvas = canvasRef.current
    if (!ctx || !canvas) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
  }, [])

  const draw = useCallback((points: WhipPoint[], alpha: number, impact?: ImpactState | null) => {
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.save()
    ctx.setTransform(scaleRef.current, 0, 0, scaleRef.current, 0, 0)
    ctx.clearRect(0, 0, sizeRef.current.width, sizeRef.current.height)
    if (alpha > 0 && points.length > 1) {
      drawLeatherWhip(ctx, points, alpha)
    }
    if (impact) {
      drawImpactSpark(ctx, impact.x, impact.y, impact.progress, impact.strong)
    }
    ctx.restore()
  }, [])

  // Sharp crack flash at the click point, active for a short window from the hit
  // start; returns null (and self-clears) once it has fully faded.
  const currentImpact = useCallback((now: number): ImpactState | null => {
    const imp = impactRef.current
    if (!imp) return null
    const duration = imp.strong ? IMPACT_MS.strong : IMPACT_MS.mild
    const progress = (now - imp.start) / duration
    if (progress >= 1) {
      impactRef.current = null
      return null
    }
    return { x: imp.x, y: imp.y, progress: Math.max(0, progress), strong: imp.strong }
  }, [])

  const tick = useCallback((now: number) => {
    const points = ropeRef.current
    const phase = phaseRef.current
    if (!points || phase === 'idle') {
      rafRef.current = null
      return
    }

    if (phase === 'swing') {
      // Ease the grip toward the pointer (low-pass) instead of pinning it to the raw
      // position, so the idle whip feels heavy and stable rather than jittery.
      const target = resolveWhipHandleAnchor(resolveInitialWhipAnchor(pointerRef.current, sizeRef.current), sizeRef.current)
      const smoothed = lowPassTowards(smoothAnchorRef.current ?? target, target, 0.18)
      smoothAnchorRef.current = smoothed
      setWhipAnchor(points, smoothed)
      stepWhipRope(points, DEFAULT_WHIP_ROPE_CONFIG)
      draw(points, 1)
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    if (phase === 'strike') {
      // Planned attack: drive BOTH the grip and the tip along the staged strike path
      // (recoil -> drive through the target -> settle). Pinning both ends and letting
      // the middle lag makes the whole whip recoil and crack, not just curl.
      const tip = points[points.length - 1]
      const progress = Math.min(1, (now - phaseStartRef.current) / strikeDurationRef.current)
      const pose = whipStrikePose(progress, strikeConfigRef.current, strikeGeomRef.current)
      setWhipAnchor(points, pose.handle)
      prevTipRef.current = { x: tip.x, y: tip.y }
      tip.pinned = true
      tip.x = pose.tip.x
      tip.y = pose.tip.y
      stepWhipRope(points, DEFAULT_WHIP_ROPE_CONFIG)
      // Fire the crack flash the instant the lash drives through the target.
      if (pose.impact && !impactFiredRef.current) {
        impactFiredRef.current = true
        const strike = strikeGeomRef.current.strike
        impactRef.current = { x: strike.x, y: strike.y, start: now, strong: strongRef.current }
      }
      draw(points, 1, currentImpact(now))
      if (progress >= 1) {
        // Release the tip carrying its last-frame velocity, plus a sharp
        // follow-through kick (much stronger for the interrupt) so it whips out.
        tip.pinned = false
        tip.oldX = prevTipRef.current.x
        tip.oldY = prevTipRef.current.y
        const kick = strongRef.current ? 5.2 : 2.4
        applyWhipImpulse(points, points.length - 1, { x: 0, y: kick })
        applyWhipImpulse(points, points.length - 2, { x: 0, y: kick * 0.6 })
        phaseRef.current = 'follow'
        phaseStartRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    stepWhipRope(points, DEFAULT_WHIP_ROPE_CONFIG)

    if (phase === 'follow') {
      draw(points, 1, currentImpact(now))
      if (now - phaseStartRef.current >= followDurationRef.current) {
        if (pendingCompletionRef.current) {
          pendingCompletionRef.current = false
          onEffectCompleteRef.current()
        }

        if (armedRef.current) {
          phaseRef.current = 'swing'
          smoothAnchorRef.current = { x: points[0].x, y: points[0].y }
          rafRef.current = requestAnimationFrame(tick)
          return
        }

        phaseRef.current = 'fade'
        phaseStartRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
      return
    }

    // disarm fade (hide/clear/retract path)
    const elapsed = now - phaseStartRef.current
    const alpha = Math.max(0, 1 - elapsed / fadeDurationRef.current)
    draw(points, alpha)
    if (elapsed >= fadeDurationRef.current) {
      phaseRef.current = 'idle'
      ropeRef.current = null
      rafRef.current = null
      clearCanvas()
      if (pendingCompletionRef.current) {
        pendingCompletionRef.current = false
        onEffectCompleteRef.current()
      }
      return
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [draw, clearCanvas, pointerRef, currentImpact])

  const ensureRope = useCallback(() => {
    if (!ropeRef.current) {
      const base = resolveInitialWhipAnchor(pointerRef.current, sizeRef.current)
      ropeRef.current = createWhipRope(resolveWhipHandleAnchor(base, sizeRef.current))
    }
    return ropeRef.current
  }, [pointerRef])

  const startSwing = useCallback(() => {
    ensureRope()
    // Seed the low-pass at the current target so the idle whip settles in place
    // rather than sliding in from a stale position after a hit.
    smoothAnchorRef.current = null
    phaseRef.current = 'swing'
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick)
  }, [ensureRope, tick])

  const startHit = useCallback((hit: WhipEffect) => {
    const points = ensureRope()
    const strike = { x: hit.x, y: hit.y }
    // The grip rests up-and-left of the click; the strike recoils then drives the
    // lash from there down THROUGH the clicked point.
    const baseHandle = resolveWhipHandleAnchor(strike, sizeRef.current)
    const tip = points[points.length - 1]

    strongRef.current = !!hit.strong
    strikeConfigRef.current = hit.strong ? STRONG_WHIP_STRIKE : MILD_WHIP_STRIKE
    strikeGeomRef.current = { restTip: { x: tip.x, y: tip.y }, baseHandle, strike }
    strikeDurationRef.current = hit.strong ? STRIKE_DURATION_MS.strong : STRIKE_DURATION_MS.mild
    followDurationRef.current = hit.strong ? FOLLOW_DURATION_MS.strong : FOLLOW_DURATION_MS.mild
    fadeDurationRef.current = hit.strong ? FADE_DURATION_MS.strong : FADE_DURATION_MS.mild
    prevTipRef.current = { x: tip.x, y: tip.y }
    impactRef.current = null
    impactFiredRef.current = false

    pendingCompletionRef.current = true
    phaseRef.current = 'strike'
    phaseStartRef.current = performance.now()
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick)
  }, [ensureRope, tick])

  const startDisarmFade = useCallback(() => {
    fadeDurationRef.current = DISARM_FADE_MS
    pendingCompletionRef.current = false
    phaseRef.current = 'fade'
    phaseStartRef.current = performance.now()
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // Local state machine driving the rope: a fresh hit always takes priority. While
  // armed, follow-through transitions back to swing on the same rope so the whip
  // can keep moving continuously for the next hit. An explicit disarm
  // (cancel button, processing end, session change) retracts it with a short fade.
  useEffect(() => {
    if (reducedMotion) return
    if (effect && effect.id !== lastEffectIdRef.current) {
      lastEffectIdRef.current = effect.id
      startHit(effect)
      return
    }
    if (armed) {
      startSwing()
      return
    }
    if (phaseRef.current === 'swing') {
      startDisarmFade()
    }
  }, [armed, effect, reducedMotion, startHit, startSwing, startDisarmFade])

  // Canvas backing-store sizing: track the wrapper's content box (not scrollHeight)
  // and cap the devicePixelRatio so large displays don't blow up the canvas memory.
  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return
    const ctx = canvas.getContext('2d')
    ctxRef.current = ctx

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const rect = entry.contentRect
      const dpr = window.devicePixelRatio || 1
      const size = computeWhipCanvasSize({ width: rect.width, height: rect.height }, dpr)
      sizeRef.current = { width: size.cssWidth, height: size.cssHeight }
      scaleRef.current = size.scale
      canvas.width = size.pixelWidth
      canvas.height = size.pixelHeight
      ctxRef.current?.setTransform(size.scale, 0, 0, size.scale, 0, 0)
    })
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [reducedMotion])

  // Unconditional cleanup: never leave a rAF loop running past unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  return (
    <div ref={wrapperRef} className="pointer-events-none absolute inset-0 z-20">
      {!reducedMotion && <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />}
      {/* Neutral cancel control: the whip stays armed after hits so the user can keep
          striking; this small × is the explicit off-switch. pointer-events-auto only
          on the button — the canvas and wrapper stay pointer-events-none. */}
      <AnimatePresence>
        {armed && (
          <motion.button
            key="whip-cancel"
            type="button"
            onClick={onCancel}
            aria-label={t('chat.whipCancelLabel')}
            title={t('chat.whipCancelLabel')}
            initial={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
            transition={{ duration: reducedMotion ? 0 : 0.15 }}
            className="pointer-events-auto absolute left-1/2 top-2 inline-flex select-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground/70 shadow-minimal backdrop-blur-sm -translate-x-1/2 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true" className="text-sm leading-none">✕</span>
            {t('chat.whipCancelLabel')}
          </motion.button>
        )}
      </AnimatePresence>
      {/* Reduced motion: skip the continuous rope physics loop entirely and fall back to a short, low-motion neutral crack mark (no orange emoji). */}
      {reducedMotion && (
        <AnimatePresence>
          {effect && (
            <motion.div
              key={effect.id}
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              onAnimationComplete={onEffectComplete}
              style={{ left: effect.x, top: effect.y }}
              className={cn(
                "pointer-events-none absolute select-none -translate-x-1/2 -translate-y-1/2 font-bold text-foreground/70",
                effect.strong ? "text-3xl" : "text-xl"
              )}
            >
              ✳
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

/** Traces the closed outline of a tapered ribbon: down the left edge, back up the right. */
function ribbonPath(ctx: CanvasRenderingContext2D, left: WhipVec[], right: WhipVec[]): void {
  ctx.beginPath()
  ctx.moveTo(left[0].x, left[0].y)
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y)
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y)
  ctx.closePath()
}

/**
 * Renders the whip as a layered leather lash: soft shadow, gradient body that
 * tapers from a fat grip to a thin cracker, a warm highlight along the upper
 * edge, a dark popper past the tip, and a banded grip at the anchor. Drawing
 * lives here (module scope) so the physics module stays DOM-free and testable.
 */
function drawLeatherWhip(ctx: CanvasRenderingContext2D, points: WhipPoint[], alpha: number): void {
  const spine = smoothWhipSpine(points, SPINE_SUBDIVISIONS)
  const n = spine.length
  if (n < 2) return
  const halfWidths = spine.map((_, i) => whipWidthAt(i / (n - 1), LASH_BASE_HALF_WIDTH, LASH_TIP_HALF_WIDTH))
  const { left, right } = offsetWhipEdges(spine, halfWidths)
  const head = spine[0]
  const tail = spine[n - 1]

  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // 1) Soft drop shadow, nudged down/right.
  ctx.save()
  ctx.translate(1.5, 2.5)
  ribbonPath(ctx, left, right)
  ctx.fillStyle = `rgba(${LEATHER.shadow}, ${0.22 * alpha})`
  ctx.fill()
  ctx.restore()

  // 2) Leather body: warm handle brown fading to a dark tip.
  const grad = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y)
  grad.addColorStop(0, LEATHER.bodyHandle)
  grad.addColorStop(0.55, LEATHER.bodyMid)
  grad.addColorStop(1, LEATHER.bodyTip)
  ribbonPath(ctx, left, right)
  ctx.globalAlpha = alpha
  ctx.fillStyle = grad
  ctx.fill()
  ctx.globalAlpha = 1

  // 3) Warm highlight along the upper (left) edge — thin, catches the light.
  ctx.beginPath()
  ctx.moveTo(left[0].x, left[0].y)
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y)
  ctx.lineWidth = 1
  ctx.strokeStyle = `rgba(${LEATHER.highlight}, ${0.45 * alpha})`
  ctx.stroke()

  // 4) Dark cracker/popper trailing past the tip along its tangent.
  const before = spine[n - 2]
  let tx = tail.x - before.x
  let ty = tail.y - before.y
  const tl = Math.hypot(tx, ty) || 1
  tx /= tl
  ty /= tl
  ctx.beginPath()
  ctx.moveTo(tail.x, tail.y)
  ctx.lineTo(tail.x + tx * 6, tail.y + ty * 6)
  ctx.lineWidth = 1.1
  ctx.strokeStyle = `rgba(${LEATHER.shadow}, ${0.85 * alpha})`
  ctx.stroke()

  drawWhipHandle(ctx, points, alpha)
}

/** Draws the banded leather grip extending back from the anchor, with a brass pommel and a collar where the lash exits. */
function drawWhipHandle(ctx: CanvasRenderingContext2D, points: WhipPoint[], alpha: number): void {
  const a = points[0]
  const b = points[1] ?? points[0]
  let dx = b.x - a.x
  let dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  dx /= len
  dy /= len // forward: direction the lash exits the grip
  const px = -dy
  const py = dx // perpendicular across the grip
  const gripLen = 22
  const gripHalf = 5
  const butt = { x: a.x - dx * gripLen, y: a.y - dy * gripLen }
  const front = { x: a.x + dx * 2, y: a.y + dy * 2 }

  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'

  // Grip body as a thick rounded stroke.
  ctx.beginPath()
  ctx.moveTo(butt.x, butt.y)
  ctx.lineTo(front.x, front.y)
  ctx.lineWidth = gripHalf * 2
  ctx.strokeStyle = LEATHER.grip
  ctx.stroke()

  // Darker grip bands.
  ctx.lineWidth = 1.4
  ctx.strokeStyle = LEATHER.gripBand
  for (let i = 1; i <= 3; i++) {
    const t = i / 4
    const cx = butt.x + (front.x - butt.x) * t
    const cy = butt.y + (front.y - butt.y) * t
    ctx.beginPath()
    ctx.moveTo(cx - px * gripHalf, cy - py * gripHalf)
    ctx.lineTo(cx + px * gripHalf, cy + py * gripHalf)
    ctx.stroke()
  }

  // Brass pommel at the butt.
  ctx.beginPath()
  ctx.arc(butt.x, butt.y, gripHalf * 0.7, 0, Math.PI * 2)
  ctx.fillStyle = LEATHER.brass
  ctx.fill()

  // Collar where the lash meets the grip.
  ctx.beginPath()
  ctx.arc(a.x, a.y, gripHalf * 0.55, 0, Math.PI * 2)
  ctx.fillStyle = LEATHER.collar
  ctx.fill()

  ctx.globalAlpha = 1
}

/**
 * A sharp, neutral crack flash at the strike point: a fast expanding ring plus a
 * few white radial spikes over a dark bruise dot. Deliberately white/dark (never
 * orange) and quick, so the click reads as an actual whip impact from frame one.
 */
function drawImpactSpark(ctx: CanvasRenderingContext2D, x: number, y: number, progress: number, strong: boolean): void {
  const fade = 1 - progress
  ctx.save()
  ctx.lineCap = 'round'

  // Bright hot core flash right at impact, fading fast.
  const coreFade = Math.max(0, 1 - progress * 1.8)
  if (coreFade > 0) {
    ctx.beginPath()
    ctx.arc(x, y, (strong ? 6 : 4) * (1 - progress * 0.4), 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 252, ${0.9 * coreFade})`
    ctx.fill()
  }

  // Dark bruise under the flash for contrast against light backgrounds.
  ctx.beginPath()
  ctx.arc(x, y, (strong ? 3.4 : 2.4) * (1 + progress), 0, Math.PI * 2)
  ctx.fillStyle = `rgba(22, 14, 8, ${0.5 * fade})`
  ctx.fill()

  // Fast expanding shock ring.
  const ringR = (strong ? 12 : 8) + (strong ? 46 : 30) * progress
  ctx.beginPath()
  ctx.arc(x, y, ringR, 0, Math.PI * 2)
  ctx.lineWidth = (strong ? 3 : 1.8) * fade
  ctx.strokeStyle = `rgba(248, 248, 244, ${0.5 * fade})`
  ctx.stroke()

  // White radial spikes — a star/crack burst; grows then fades.
  const spikes = strong ? 8 : 5
  const reach = (strong ? 22 : 14) * (0.5 + 1.1 * progress)
  const twist = strong ? 0.25 : 0
  for (let i = 0; i < spikes; i++) {
    const ang = (Math.PI / spikes) * i + twist
    const cx = Math.cos(ang) * reach
    const cy = Math.sin(ang) * reach
    ctx.beginPath()
    ctx.moveTo(x - cx, y - cy)
    ctx.lineTo(x + cx, y + cy)
    ctx.lineWidth = (strong ? 2.6 : 1.6) * fade
    ctx.strokeStyle = `rgba(255, 255, 250, ${0.9 * fade})`
    ctx.stroke()
  }

  ctx.restore()
}
