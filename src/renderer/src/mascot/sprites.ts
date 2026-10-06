// Suri's art, cut from Paul's sheets by scripts/mascot/build_mascot.py (ADR-019).
// Only the sprites the island shows are imported, so only they are bundled.
import alert from '../../../../assets/mascot/sprites/alert.webp'
import happy from '../../../../assets/mascot/sprites/happy.webp'
import head from '../../../../assets/mascot/sprites/head.webp'
import face from '../../../../assets/mascot/sprites/head.json'
import idle from '../../../../assets/mascot/sprites/idle.webp'
import shield from '../../../../assets/mascot/sprites/shield.webp'
import sleepy from '../../../../assets/mascot/sprites/sleepy.webp'
import thumbsUp from '../../../../assets/mascot/sprites/thumbs-up.webp'
import working from '../../../../assets/mascot/sprites/working.webp'
import worried from '../../../../assets/mascot/sprites/worried.webp'
import type { Mood } from '../lib/format'

/** A full-body pose: one per mood, plus two for moments on the cards. */
export type Pose = Mood | 'shield' | 'thumbs-up'

export const POSES: Record<Pose, string> = {
  idle,
  working,
  alert,
  happy,
  sleepy,
  worried,
  shield,
  'thumbs-up': thumbsUp
}

export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** The blank head, and where its eye patches and nose sit (fractions of its size). */
export const HEAD: {
  src: string
  width: number
  height: number
  eyes: [Ellipse, Ellipse]
  nose: Ellipse
} = {
  src: head,
  width: face.width,
  height: face.height,
  eyes: [face.eyes[0] as Ellipse, face.eyes[1] as Ellipse],
  nose: face.nose
}
