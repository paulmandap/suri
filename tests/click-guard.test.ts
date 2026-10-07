import { describe, expect, it } from 'vitest'
import { ARM_MS, clickCounts } from '@shared/click-guard'

describe('clickCounts (ADR-028)', () => {
  const shown = 10_000

  it('ignores any click in the first moment after the card appears', () => {
    expect(clickCounts(shown, shown + 10, shown + 50)).toBe(false)
    expect(clickCounts(shown, shown + ARM_MS - 1, shown + ARM_MS - 1)).toBe(false)
  })

  it('needs the pointer to move onto the buttons after that, so a busy cursor can’t click', () => {
    // A cursor resting where the card popped up, clicking 1.8 s later (the Dota 2 case).
    expect(clickCounts(shown, shown + 200, shown + 1800)).toBe(false)
    expect(clickCounts(shown, null, shown + 5000)).toBe(false)
  })

  it('lets a deliberate click through', () => {
    expect(clickCounts(shown, shown + ARM_MS, shown + ARM_MS + 100)).toBe(true)
    expect(clickCounts(shown, shown + 2500, shown + 2600)).toBe(true)
  })
})
