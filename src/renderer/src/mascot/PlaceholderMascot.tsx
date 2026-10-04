import { motion, useReducedMotion } from 'motion/react'
import type { Mood } from '../lib/format'

interface Props {
  mood?: Mood
  size?: number
}

// A stand-in meerkat face drawn in code. Phase 5 swaps in Paul's ChatGPT art;
// the moods stay the same.
export function PlaceholderMascot({ mood = 'idle', size = 28 }: Props): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const bobbing = mood === 'working' && !reduce
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ overflow: 'visible', flexShrink: 0 }}
      animate={bobbing ? { y: [0, -1.2, 0] } : { y: 0 }}
      transition={bobbing ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' } : undefined}
    >
      {/* ears */}
      <ellipse cx="7.5" cy="9.5" rx="3.2" ry="3.4" fill="#C9A27A" />
      <ellipse cx="24.5" cy="9.5" rx="3.2" ry="3.4" fill="#C9A27A" />
      <ellipse cx="7.5" cy="9.8" rx="1.5" ry="1.8" fill="#5B4636" />
      <ellipse cx="24.5" cy="9.8" rx="1.5" ry="1.8" fill="#5B4636" />
      {/* head and muzzle */}
      <ellipse cx="16" cy="17.5" rx="11.5" ry="11" fill="#E7C9A0" />
      <ellipse cx="16" cy="22.5" rx="6.2" ry="4.6" fill="#F4E4CB" />
      {/* the dark meerkat eye patches */}
      <ellipse
        cx="11.2"
        cy="15.8"
        rx="3.4"
        ry="4"
        fill="#4A3A2C"
        transform="rotate(-16 11.2 15.8)"
      />
      <ellipse
        cx="20.8"
        cy="15.8"
        rx="3.4"
        ry="4"
        fill="#4A3A2C"
        transform="rotate(16 20.8 15.8)"
      />
      <Eyes mood={mood} reduce={reduce} />
      <ellipse cx="16" cy="21" rx="1.6" ry="1.1" fill="#2E241C" />
      <Mouth mood={mood} />
    </motion.svg>
  )
}

function Eyes({ mood, reduce }: { mood: Mood; reduce: boolean }): React.JSX.Element {
  if (mood === 'happy') {
    return (
      <g stroke="#FFF7EA" strokeWidth="1.2" fill="none" strokeLinecap="round">
        <path d="M9.6 16.4 q1.6 -2 3.2 0" />
        <path d="M19.2 16.4 q1.6 -2 3.2 0" />
      </g>
    )
  }
  if (mood === 'sleepy') {
    return (
      <g stroke="#FFF7EA" strokeWidth="1.1" strokeLinecap="round">
        <path d="M9.8 16.2 h2.8" />
        <path d="M19.4 16.2 h2.8" />
      </g>
    )
  }
  const eye = mood === 'alert' ? 2.3 : 1.9
  const pupil = mood === 'alert' ? 1.25 : 1.05
  // Working: eyes glance down at the "keyboard".
  const look = mood === 'working' ? 0.5 : 0
  return (
    <motion.g
      style={{ transformOrigin: '16px 16px', transformBox: 'view-box' }}
      animate={reduce ? undefined : { scaleY: [1, 1, 0.12, 1] }}
      transition={{ duration: 4.2, times: [0, 0.9, 0.94, 1], repeat: Infinity, repeatDelay: 0.8 }}
    >
      <circle cx="11.2" cy="16" r={eye} fill="#FFF7EA" />
      <circle cx="20.8" cy="16" r={eye} fill="#FFF7EA" />
      <circle cx={11.2 + look} cy={16 + look} r={pupil} fill="#1E1712" />
      <circle cx={20.8 + look} cy={16 + look} r={pupil} fill="#1E1712" />
      {mood === 'worried' && (
        <g stroke="#2E241C" strokeWidth="0.9" strokeLinecap="round">
          <path d="M9.3 12.6 l3.2 -1" />
          <path d="M22.7 12.6 l-3.2 -1" />
        </g>
      )}
    </motion.g>
  )
}

function Mouth({ mood }: { mood: Mood }): React.JSX.Element {
  const line = {
    stroke: '#2E241C',
    strokeWidth: 0.9,
    fill: 'none',
    strokeLinecap: 'round' as const
  }
  if (mood === 'alert') return <ellipse cx="16" cy="24.3" rx="0.9" ry="1.1" fill="#2E241C" />
  if (mood === 'worried') return <path d="M14.4 24.8 q1.6 -1.2 3.2 0" {...line} />
  if (mood === 'happy') return <path d="M13.9 23.2 q2.1 2.2 4.2 0" {...line} />
  return <path d="M14.6 23.3 q1.4 1.1 2.8 0" {...line} />
}
