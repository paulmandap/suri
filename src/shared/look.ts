// Where Suri's pupils go when it looks toward the pointer (ADR-019). Pure, so
// the tests cover it without a screen.

export interface Look {
  /** Toward the point, as a share of how far a pupil can travel: -1 to 1. */
  x: number
  y: number
}

export const LOOK_AHEAD: Look = { x: 0, y: 0 }

/**
 * A pupil offset toward a point `dx`, `dy` CSS pixels from the head's centre.
 * The glance grows with distance and is full at `reach`, so a pointer resting
 * on the island gets a small look and one across the window a clear one.
 */
export function lookToward(dx: number, dy: number, reach = 220): Look {
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return LOOK_AHEAD
  const strength = Math.min(1, distance / reach)
  return { x: (dx / distance) * strength, y: (dy / distance) * strength }
}
