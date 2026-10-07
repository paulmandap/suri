import { describe, expect, it } from 'vitest'
import { loadForegroundProbe } from '../src/main/foreground'

// The real Windows calls through koffi (ADR-029). What's in front depends on
// the desktop the tests run on (CI has none), so this checks the shape and
// that every call goes through, not the answer.

describe.runIf(process.platform === 'win32')('loadForegroundProbe on Windows', () => {
  it('loads once and answers in a known shape', async () => {
    const probe = await loadForegroundProbe()
    expect(probe).not.toBeNull()
    expect(await loadForegroundProbe()).toBe(probe)
    const info = probe?.()
    expect(info).not.toBeNull()
    if (info?.notificationState !== null) {
      expect(info?.notificationState).toBeGreaterThanOrEqual(1)
      expect(info?.notificationState).toBeLessThanOrEqual(7)
    }
    const win = info?.window
    if (win) {
      expect(win.monitor.right).toBeGreaterThan(win.monitor.left)
      expect(win.monitor.bottom).toBeGreaterThan(win.monitor.top)
      expect(typeof win.className).toBe('string')
      // Only ever a file name, never the folder it's in.
      expect(win.exe).not.toMatch(/[\\/]/)
    }
  })
})

describe.runIf(process.platform !== 'win32')('loadForegroundProbe elsewhere', () => {
  it('has nothing to ask', async () => {
    expect(await loadForegroundProbe()).toBeNull()
  })
})
