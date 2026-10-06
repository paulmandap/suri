import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { LOOK_AHEAD, lookToward, type Look } from '@shared/look'
import type { Mood } from '../lib/format'
import { HEAD, POSES, type Ellipse, type Pose } from './sprites'

// Suri drawn from Paul's art (ADR-019): a full-body pose on the cards, and the
// blank head with eyes drawn in code in the small spots, so it can blink and
// glance at the pointer.

/** The art's near-black brown, for eyes, brows and mouth. */
const INK = '#1C130E'
const SHINE = '#FFF8EE'

/** A full-body pose. It breathes, and a new pose pops in. */
export function MascotBody({ pose, size }: { pose: Pose; size: number }): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const sleepy = pose === 'sleepy'
  const breath = sleepy ? 4.8 : 3.4
  return (
    <motion.img
      // A new key per pose, so a change (alert to shield) pops in.
      key={pose}
      src={POSES[pose]}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="block shrink-0 select-none"
      style={{ height: size, width: 'auto', transformOrigin: '50% 100%' }}
      initial={reduce ? false : { opacity: 0, scale: 0.85 }}
      animate={
        reduce
          ? { opacity: 1, scale: 1 }
          : {
              opacity: 1,
              scale: 1,
              scaleY: [1, sleepy ? 1.04 : 1.025, 1],
              scaleX: [1, sleepy ? 0.98 : 0.99, 1]
            }
      }
      transition={{
        opacity: { duration: 0.2 },
        scale: { type: 'spring', stiffness: 500, damping: 20 },
        scaleX: { duration: breath, repeat: Infinity, ease: 'easeInOut' },
        scaleY: { duration: breath, repeat: Infinity, ease: 'easeInOut' }
      }}
    />
  )
}

/**
 * The head for small spots. With `pop`, it springs up from below its box when
 * it first appears, like a meerkat out of its burrow.
 */
export function MascotHead({
  mood,
  size,
  pop = false
}: {
  mood: Mood
  size: number
  pop?: boolean
}): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const ref = useRef<HTMLDivElement>(null)
  const eyesOpen = mood !== 'happy' && mood !== 'sleepy'
  const look = useLook(ref, eyesOpen && !reduce)
  const width = Math.round((size * HEAD.width) / HEAD.height)
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="relative shrink-0"
      // Clipped below only: the head rises out of its box, and a bounce above isn't cut.
      style={{ width, height: size, clipPath: 'inset(-50% -50% 0 -50%)' }}
    >
      <motion.div
        className="absolute inset-0"
        initial={pop && !reduce ? { y: '85%' } : false}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 17, delay: 0.15 }}
      >
        <img src={HEAD.src} alt="" draggable={false} className="block h-full w-full select-none" />
        <Face mood={mood} look={look} reduce={reduce} />
      </motion.div>
    </div>
  )
}

/** Eye patches and nose in the head sprite's own pixels. */
function inPixels(e: Ellipse): Ellipse {
  return {
    cx: e.cx * HEAD.width,
    cy: e.cy * HEAD.height,
    rx: e.rx * HEAD.width,
    ry: e.ry * HEAD.height
  }
}

function Face({
  mood,
  look,
  reduce
}: {
  mood: Mood
  look: Look
  reduce: boolean
}): React.JSX.Element {
  const eyes = HEAD.eyes.map(inPixels)
  const nose = inPixels(HEAD.nose)
  return (
    <svg
      className="absolute inset-0 h-full w-full overflow-visible"
      viewBox={`0 0 ${HEAD.width} ${HEAD.height}`}
    >
      {mood === 'happy' ? (
        <Arcs eyes={eyes} up />
      ) : mood === 'sleepy' ? (
        <Arcs eyes={eyes} />
      ) : (
        <OpenEyes eyes={eyes} mood={mood} look={look} reduce={reduce} />
      )}
      {mood === 'worried' && <Brows eyes={eyes} />}
      <Mouth mood={mood} x={nose.cx} y={nose.cy + nose.ry * 2} />
    </svg>
  )
}

// Thick enough to read at 18-30 px: the sprite is drawn about five times smaller.
const STROKE = 5

function OpenEyes({
  eyes,
  mood,
  look,
  reduce
}: {
  eyes: Ellipse[]
  mood: Mood
  look: Look
  reduce: boolean
}): React.JSX.Element {
  const share = mood === 'alert' ? 0.66 : 0.58
  // At rest a working meerkat looks down at its laptop, and a worried one up.
  const rest =
    mood === 'working' ? { x: 0.15, y: 0.6 } : mood === 'worried' ? { x: 0, y: -0.4 } : LOOK_AHEAD
  const aim = look === LOOK_AHEAD ? rest : look
  const glide = { type: 'spring', stiffness: 260, damping: 24 } as const
  return (
    <motion.g
      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
      animate={reduce ? undefined : { scaleY: [1, 1, 0.08, 1] }}
      transition={{ duration: 4.4, times: [0, 0.93, 0.965, 1], repeat: Infinity, repeatDelay: 1.3 }}
    >
      {eyes.map((e, i) => {
        const r = Math.min(e.rx, e.ry) * share
        const cx = e.cx + aim.x * (e.rx - r) * 0.8
        const cy = e.cy + aim.y * (e.ry - r) * 0.8
        return (
          <g key={i}>
            <motion.circle
              initial={false}
              animate={{ cx, cy }}
              transition={glide}
              r={r}
              fill={INK}
            />
            <motion.circle
              initial={false}
              animate={{ cx: cx - r * 0.34, cy: cy - r * 0.38 }}
              transition={glide}
              r={r * 0.3}
              fill={SHINE}
            />
            <motion.circle
              initial={false}
              animate={{ cx: cx + r * 0.32, cy: cy + r * 0.34 }}
              transition={glide}
              r={r * 0.13}
              fill={SHINE}
              opacity={0.7}
            />
          </g>
        )
      })}
    </motion.g>
  )
}

/** Closed eyes: happy arcs up, or sleepy curves down. */
function Arcs({ eyes, up = false }: { eyes: Ellipse[]; up?: boolean }): React.JSX.Element {
  return (
    <g fill="none" stroke={INK} strokeWidth={STROKE} strokeLinecap="round">
      {eyes.map((e, i) => {
        const r = Math.min(e.rx, e.ry) * 0.55
        const d = up
          ? `M ${e.cx - r} ${e.cy + r * 0.3} Q ${e.cx} ${e.cy - r * 1.1} ${e.cx + r} ${e.cy + r * 0.3}`
          : `M ${e.cx - r} ${e.cy} Q ${e.cx} ${e.cy + r * 0.8} ${e.cx + r} ${e.cy}`
        return <path key={i} d={d} />
      })}
    </g>
  )
}

/** Worried: brows above the patches, their inner ends raised. */
function Brows({ eyes }: { eyes: Ellipse[] }): React.JSX.Element {
  return (
    <g stroke={INK} strokeWidth={STROKE * 0.8} strokeLinecap="round">
      {eyes.map((e, i) => {
        // The inner end is the one nearer the nose: right for the left eye.
        const inward = i === 0 ? 1 : -1
        return (
          <path
            key={i}
            d={`M ${e.cx - inward * e.rx * 0.6} ${e.cy - e.ry * 1.08} L ${e.cx + inward * e.rx * 0.45} ${e.cy - e.ry * 1.4}`}
          />
        )
      })}
    </g>
  )
}

function Mouth({ mood, x, y }: { mood: Mood; x: number; y: number }): React.JSX.Element {
  const line = {
    fill: 'none',
    stroke: INK,
    strokeWidth: STROKE * 0.8,
    strokeLinecap: 'round' as const
  }
  if (mood === 'alert') return <ellipse cx={x} cy={y + 2} rx={4} ry={5} fill={INK} />
  if (mood === 'happy')
    return <path d={`M ${x - 11} ${y - 1} Q ${x} ${y + 15} ${x + 11} ${y - 1} Z`} fill={INK} />
  if (mood === 'worried')
    return <path d={`M ${x - 8} ${y + 6} Q ${x} ${y - 1} ${x + 8} ${y + 6}`} {...line} />
  if (mood === 'sleepy')
    return <path d={`M ${x - 6} ${y + 1} Q ${x} ${y + 4} ${x + 6} ${y + 1}`} {...line} />
  return <path d={`M ${x - 10} ${y} Q ${x} ${y + 8} ${x + 10} ${y}`} {...line} />
}

/**
 * Where the pointer is, as a glance. Main forwards mouse moves only while the
 * pointer is over the overlay window, so Suri looks up as it comes near the
 * island, and looks ahead again once it rests or leaves. Costs nothing at idle.
 */
function useLook(ref: RefObject<HTMLElement | null>, enabled: boolean): Look {
  const [look, setLook] = useState<Look>(LOOK_AHEAD)
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    let rest: number | undefined
    const onMove = (event: MouseEvent): void => {
      const { clientX, clientY } = event
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = ref.current?.getBoundingClientRect()
        if (!box) return
        setLook(
          lookToward(clientX - (box.left + box.width / 2), clientY - (box.top + box.height / 2))
        )
      })
      window.clearTimeout(rest)
      rest = window.setTimeout(() => setLook(LOOK_AHEAD), 2500)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(frame)
      window.clearTimeout(rest)
    }
  }, [ref, enabled])
  return enabled ? look : LOOK_AHEAD
}
