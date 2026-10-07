import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { suriModelsIn, DEFAULT_AI } from '@shared/ai-config'
import { QUNS, fillsMonitor, quietLabel, quietReason, type ForegroundInfo } from '@shared/quiet'
import { createQuietWatch, whileLoud, type QuietWatch } from '../src/main/quiet-watch'

// Staying out of full-screen games (ADR-029). The window shapes are the ones
// the probe reported on Paul's 1920 × 1080 screen (taskbar 40 px at the bottom).

const MONITOR = { left: 0, top: 0, right: 1920, bottom: 1080 }

function front(
  window: Partial<NonNullable<ForegroundInfo['window']>> = {},
  notificationState: number | null = QUNS.acceptsNotifications
): ForegroundInfo {
  return {
    notificationState,
    window: {
      rect: MONITOR,
      monitor: MONITOR,
      primary: true,
      maximizedWithTitleBar: false,
      className: 'SDL_app',
      exe: 'dota2.exe',
      ...window
    }
  }
}

describe('quietReason', () => {
  it('stays quiet for a borderless game that fills the island’s monitor', () => {
    expect(quietReason(front())).toBe('full-screen')
    // Games often overhang the monitor by a pixel or two.
    expect(quietReason(front({ rect: { left: -1, top: -1, right: 1921, bottom: 1081 } }))).toBe(
      'full-screen'
    )
  })

  it('stays quiet when a Direct3D game owns the screen, or in presentation mode', () => {
    expect(quietReason(front({ rect: { left: 0, top: 0, right: 10, bottom: 10 } }, 3))).toBe(
      'exclusive'
    )
    expect(quietReason({ notificationState: QUNS.presentationMode, window: null })).toBe(
      'presentation'
    )
  })

  it('shows itself over an ordinary maximized window', () => {
    // VS Code, maximized, as the probe saw it: overhangs left, right and top by 8 px,
    // and stops at the taskbar.
    const vscode = {
      rect: { left: -8, top: -8, right: 1928, bottom: 1048 },
      maximizedWithTitleBar: true,
      className: 'Chrome_WidgetWin_1',
      exe: ''
    }
    expect(quietReason(front(vscode))).toBeNull()
    // With the taskbar set to hide, a maximized window reaches the bottom too.
    expect(
      quietReason(front({ ...vscode, rect: { left: -8, top: -8, right: 1928, bottom: 1088 } }))
    ).toBeNull()
  })

  it('shows itself when Claude Code’s own window is the full-screen one', () => {
    for (const exe of ['code.exe', 'windowsterminal.exe', 'pwsh.exe', 'cursor.exe']) {
      expect(quietReason(front({ exe }))).toBeNull()
    }
  })

  it('ignores the desktop and the taskbar, which fill the monitor too', () => {
    expect(quietReason(front({ className: 'Progman', exe: 'explorer.exe' }))).toBeNull()
    expect(quietReason(front({ className: 'WorkerW', exe: 'explorer.exe' }))).toBeNull()
  })

  it('ignores a full-screen app on another monitor: the island is on the primary one', () => {
    expect(quietReason(front({ primary: false }))).toBeNull()
  })

  it('shows itself for a window smaller than the screen, or when Windows says nothing', () => {
    expect(quietReason(front({ rect: { left: 0, top: 0, right: 1920, bottom: 1040 } }))).toBeNull()
    expect(quietReason({ notificationState: null, window: null })).toBeNull()
    expect(quietReason(null)).toBeNull()
    // The shell's "busy" alone can't say which monitor or which app: the window decides.
    expect(
      quietReason(front({ rect: { left: 0, top: 0, right: 800, bottom: 600 } }, QUNS.busy))
    ).toBeNull()
  })

  it('needs a real monitor to fill', () => {
    expect(fillsMonitor(MONITOR, { left: 0, top: 0, right: 0, bottom: 0 })).toBe(false)
  })

  it('names what is in front for the tray', () => {
    expect(quietLabel('full-screen', 'dota2.exe')).toBe('dota2.exe is full screen')
    expect(quietLabel('exclusive', '')).toBe('an app is a full-screen game')
    expect(quietLabel('presentation', 'x.exe')).toBe('Windows is in presentation mode')
  })
})

describe('suriModelsIn', () => {
  it('picks only the loaded models Suri uses, with or without a tag', () => {
    const ai = {
      ...DEFAULT_AI,
      fallbackModel: 'llama3',
      routes: { ...DEFAULT_AI.routes, risk: { provider: 'ollama' as const, model: 'qwen3.5:9b' } }
    }
    expect(suriModelsIn(ai, ['qwen3.5:9b', 'llama3:latest', 'gemma4:12b'])).toEqual([
      'qwen3.5:9b',
      'llama3:latest'
    ])
    expect(suriModelsIn(ai, [])).toEqual([])
  })
})

describe('createQuietWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(start: ForegroundInfo | null = null): {
    watch: QuietWatch
    probes: () => number
    show: (info: ForegroundInfo | null) => void
    state: { enabled: boolean; active: boolean }
    heard: boolean[]
    logs: string[]
  } {
    let info = start
    let probes = 0
    const state = { enabled: true, active: true }
    const heard: boolean[] = []
    const logs: string[] = []
    const watch = createQuietWatch({
      probe: () => {
        probes++
        return info
      },
      enabled: () => state.enabled,
      active: () => state.active,
      clock: () => Date.now(),
      log: (line) => logs.push(line)
    })
    watch.onChange((quiet) => heard.push(quiet))
    return {
      watch,
      probes: () => probes,
      show: (next) => (info = next),
      state,
      heard,
      logs
    }
  }

  it('goes quiet at once, and comes back only after the game has been gone a second', () => {
    const { watch, show, heard, logs } = setup()
    watch.refresh()
    expect(watch.quiet()).toBe(false)
    show(front())
    vi.advanceTimersByTime(1000)
    expect(watch.quiet()).toBe(true)
    expect(watch.label()).toBe('dota2.exe is full screen')
    // A quick Alt+Tab out and back doesn't bring the island up.
    show(null)
    vi.advanceTimersByTime(1000)
    expect(watch.quiet()).toBe(true)
    show(front())
    vi.advanceTimersByTime(1000)
    show(null)
    vi.advanceTimersByTime(1000)
    expect(watch.quiet()).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(watch.quiet()).toBe(false)
    expect(watch.label()).toBeNull()
    expect(heard).toEqual([true, false])
    expect(logs).toEqual([
      'staying quiet: dota2.exe is full screen',
      'back: nothing full screen in front'
    ])
  })

  it('only looks every second while something could show, or while quiet', () => {
    const { watch, probes, state, show } = setup()
    state.active = false
    watch.refresh()
    vi.advanceTimersByTime(10_000)
    expect(probes()).toBe(1)
    // A hook event comes in: look, and keep looking while it matters.
    state.active = true
    watch.refresh()
    vi.advanceTimersByTime(3000)
    expect(probes()).toBe(5)
    show(front())
    vi.advanceTimersByTime(1000)
    state.active = false
    vi.advanceTimersByTime(3000)
    // Quiet with nothing on the island: still looking, to notice the game ending.
    expect(probes()).toBe(9)
    show(null)
    vi.advanceTimersByTime(2000)
    expect(watch.quiet()).toBe(false)
    const after = probes()
    vi.advanceTimersByTime(10_000)
    expect(probes()).toBe(after)
  })

  it('comes back at once when the setting is switched off, and never looks while off', () => {
    const { watch, probes, state } = setup(front())
    watch.refresh()
    expect(watch.quiet()).toBe(true)
    state.enabled = false
    watch.refresh()
    expect(watch.quiet()).toBe(false)
    const before = probes()
    vi.advanceTimersByTime(5000)
    watch.refresh()
    expect(probes()).toBe(before)
  })

  it('shows itself as before when Windows can’t be asked', () => {
    const logs: string[] = []
    const broken = createQuietWatch({
      probe: () => {
        throw new Error('koffi went away')
      },
      enabled: () => true,
      active: () => true,
      log: (line) => logs.push(line)
    })
    broken.refresh()
    vi.advanceTimersByTime(3000)
    expect(broken.quiet()).toBe(false)
    expect(logs).toEqual(['full-screen check failed: koffi went away'])
    const none = createQuietWatch({ probe: null, enabled: () => true, active: () => true })
    none.refresh()
    expect(none.quiet()).toBe(false)
    broken.stop()
  })

  it('lets work wait until the game is gone, or until it is called off', async () => {
    const { watch, show } = setup(front())
    watch.refresh()
    let done = false
    void watch.whenLoud().then(() => (done = true))
    const cancel = new AbortController()
    let cancelled = false
    void watch.whenLoud(cancel.signal).then(() => (cancelled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect([done, cancelled]).toEqual([false, false])
    cancel.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect([done, cancelled]).toEqual([false, true])
    show(null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(true)
    // Nothing in front: no wait at all.
    await expect(watch.whenLoud()).resolves.toBeUndefined()
  })

  it('stops looking on quit and lets everything waiting go', async () => {
    const { watch, probes } = setup(front())
    watch.refresh()
    let done = false
    void watch.whenLoud().then(() => (done = true))
    watch.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(done).toBe(true)
    expect(probes()).toBe(1)
  })
})

describe('whileLoud', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the task after the game, and again if a game interrupts it', async () => {
    let info: ForegroundInfo | null = front()
    const watch = createQuietWatch({ probe: () => info, enabled: () => true, active: () => true })
    watch.refresh()
    const runs: AbortSignal[] = []
    const finish: ((value: string) => void)[] = []
    const result = whileLoud(watch, new AbortController().signal, (signal) => {
      runs.push(signal)
      return new Promise<string>((resolve) => finish.push(resolve))
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(runs).toHaveLength(0)
    info = null
    await vi.advanceTimersByTimeAsync(2000)
    expect(runs).toHaveLength(1)
    // A game comes to the front mid-task: it stops, and runs again after.
    info = front()
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs[0]?.aborted).toBe(true)
    finish[0]?.('cancelled')
    info = null
    await vi.advanceTimersByTimeAsync(2000)
    expect(runs).toHaveLength(2)
    finish[1]?.('answer')
    expect(await result).toBe('answer')
    watch.stop()
  })

  it('gives up when the request is answered first', async () => {
    const watch = createQuietWatch({
      probe: () => front(),
      enabled: () => true,
      active: () => true
    })
    watch.refresh()
    const answered = new AbortController()
    let ran = false
    const result = whileLoud(watch, answered.signal, async () => {
      ran = true
      return 'x'
    })
    answered.abort()
    expect(await result).toBeNull()
    expect(ran).toBe(false)
    watch.stop()
  })
})
