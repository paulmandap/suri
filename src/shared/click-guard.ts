// Approval clicks must be deliberate (CLAUDE.md: never approve without Paul's
// click; ADR-028). On 2026-10-07 a test card popped up at the top of the
// screen during a game of Dota 2, and a click meant for the game landed on
// Allow 1.8 s later. A card that appears under a busy cursor mustn't catch it.

/** How long a new card's buttons ignore clicks. A deliberate click takes longer. */
export const ARM_MS = 1000

/**
 * Whether a click on a card's button counts: the card has been up for ARM_MS,
 * and the pointer moved onto the buttons after that, so it was aimed at them.
 * A cursor that was already busy where the card appeared has to move first.
 */
export function clickCounts(shownAt: number, lastMoveAt: number | null, now: number): boolean {
  const armedAt = shownAt + ARM_MS
  return now >= armedAt && lastMoveAt !== null && lastMoveAt >= armedAt
}
