import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every `intervalMs` while `active`. When the
 * island is hidden there is no timer at all, so an idle Suri costs nothing.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = (): void => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, intervalMs)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [active, intervalMs])
  return now
}
