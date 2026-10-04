import { useEffect, useRef } from 'react'

/**
 * The overlay ignores the mouse, so clicks fall through to the apps below,
 * except while the pointer is over the island. Main keeps forwarding mouse
 * moves even while ignoring, so we watch the pointer here and switch
 * interactivity on the way in and out.
 */
export function usePointerZone(
  getZone: () => DOMRect | null,
  onChange: (inside: boolean) => void
): void {
  const inside = useRef(false)

  useEffect(() => {
    const update = (next: boolean): void => {
      if (next === inside.current) return
      inside.current = next
      window.suri.setInteractive(next)
      onChange(next)
    }
    const onMove = (event: MouseEvent): void => {
      const zone = getZone()
      update(
        zone !== null &&
          event.clientX >= zone.left &&
          event.clientX <= zone.right &&
          event.clientY >= zone.top &&
          event.clientY <= zone.bottom
      )
    }
    const onLeave = (): void => update(false)

    window.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [getZone, onChange])
}
