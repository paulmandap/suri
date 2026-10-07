import { QUNS, fillsMonitor, type ForegroundInfo, type Rect } from '@shared/quiet'

// Asks Windows about the window in front (ADR-029), through koffi: a
// prebuilt FFI library, so nothing is compiled for Electron or for the tests.
// Electron can't see other programs' windows, and the shell's own answer
// (SHQueryUserNotificationState) can't say which monitor or which program,
// so this reads the window's size, its monitor and its program as well.

export type ForegroundProbe = () => ForegroundInfo | null

const GWL_STYLE = -16
const WS_CAPTION = 0x00c00000
const WS_MAXIMIZE = 0x01000000
const MONITOR_DEFAULTTONEAREST = 2
const MONITORINFOF_PRIMARY = 1
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const CLASS_CHARS = 256
const PATH_CHARS = 1024

let loading: Promise<ForegroundProbe | null> | null = null

/**
 * Loads the Windows calls, once (koffi's type names are global). Null off
 * Windows, or when koffi can't load: Suri then shows itself as it always did.
 */
export function loadForegroundProbe(log?: (line: string) => void): Promise<ForegroundProbe | null> {
  loading ??= load(log)
  return loading
}

async function load(log?: (line: string) => void): Promise<ForegroundProbe | null> {
  if (process.platform !== 'win32') return null
  try {
    const koffi = (await import('koffi')).default
    const user32 = koffi.load('user32.dll')
    const shell32 = koffi.load('shell32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    const HANDLE = koffi.pointer('SURI_HANDLE', koffi.opaque())
    const RECT = koffi.struct('SURI_RECT', {
      left: 'int32_t',
      top: 'int32_t',
      right: 'int32_t',
      bottom: 'int32_t'
    })
    const MONITORINFO = koffi.struct('SURI_MONITORINFO', {
      cbSize: 'uint32_t',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32_t'
    })

    // BOOL is a 4-byte int in Win32, so it's int32_t here, not bool.
    const queryNotificationState = shell32.func(
      '__stdcall',
      'SHQueryUserNotificationState',
      'int32_t',
      [koffi.out(koffi.pointer('int32_t'))]
    )
    const foregroundWindow = user32.func('__stdcall', 'GetForegroundWindow', HANDLE, [])
    const windowRect = user32.func('__stdcall', 'GetWindowRect', 'int32_t', [
      HANDLE,
      koffi.out(koffi.pointer(RECT))
    ])
    const windowLong = user32.func('__stdcall', 'GetWindowLongW', 'int32_t', [HANDLE, 'int32_t'])
    const monitorFromWindow = user32.func('__stdcall', 'MonitorFromWindow', HANDLE, [
      HANDLE,
      'uint32_t'
    ])
    const monitorInfo = user32.func('__stdcall', 'GetMonitorInfoW', 'int32_t', [
      HANDLE,
      koffi.inout(koffi.pointer(MONITORINFO))
    ])
    const className = user32.func('__stdcall', 'GetClassNameW', 'int32_t', [
      HANDLE,
      koffi.out(koffi.pointer('uint8_t')),
      'int32_t'
    ])
    const windowProcess = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', [
      HANDLE,
      koffi.out(koffi.pointer('uint32_t'))
    ])
    const openProcess = kernel32.func('__stdcall', 'OpenProcess', HANDLE, [
      'uint32_t',
      'int32_t',
      'uint32_t'
    ])
    const processImageName = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'int32_t', [
      HANDLE,
      'uint32_t',
      koffi.out(koffi.pointer('uint8_t')),
      koffi.inout(koffi.pointer('uint32_t'))
    ])
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int32_t', [HANDLE])

    const emptyRect = (): Rect => ({ left: 0, top: 0, right: 0, bottom: 0 })

    // The program's file name, read once per process and only when it matters:
    // anti-cheat tools watch who opens a game's process, so Suri asks for the
    // least it can (its name, the access Task Manager uses) and asks once.
    let lastPid = 0
    let lastExe = ''
    const exeOf = (hwnd: unknown): string => {
      const pid = [0]
      windowProcess(hwnd, pid)
      const id = pid[0] ?? 0
      if (id === 0) return ''
      if (id === lastPid) return lastExe
      let exe = ''
      // Null for an elevated or protected process: Windows won't say, and that's fine.
      const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, id)
      if (handle) {
        try {
          const buf = Buffer.alloc(PATH_CHARS * 2)
          const size = [PATH_CHARS]
          if (processImageName(handle, 0, buf, size)) {
            // Only the file name is kept, never the path (it holds the user's name).
            const path = buf.toString('utf16le', 0, (size[0] ?? 0) * 2)
            exe = path.slice(path.lastIndexOf('\\') + 1).toLowerCase()
          }
        } finally {
          closeHandle(handle)
        }
      }
      lastPid = id
      lastExe = exe
      return exe
    }

    return () => {
      const state = [0]
      const notificationState = queryNotificationState(state) === 0 ? (state[0] ?? null) : null
      const hwnd = foregroundWindow()
      if (!hwnd) return { notificationState, window: null }

      const rect = emptyRect()
      if (!windowRect(hwnd, rect)) return { notificationState, window: null }
      const info = {
        cbSize: koffi.sizeof(MONITORINFO),
        rcMonitor: emptyRect(),
        rcWork: emptyRect(),
        dwFlags: 0
      }
      const monitor = monitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
      if (!monitor || !monitorInfo(monitor, info)) return { notificationState, window: null }

      const style = windowLong(hwnd, GWL_STYLE) >>> 0
      const name = Buffer.alloc(CLASS_CHARS * 2)
      const nameLength = className(hwnd, name, CLASS_CHARS)
      const exclusive =
        notificationState === QUNS.d3dFullScreen || notificationState === QUNS.presentationMode
      return {
        notificationState,
        window: {
          rect,
          monitor: info.rcMonitor,
          primary: (info.dwFlags & MONITORINFOF_PRIMARY) !== 0,
          maximizedWithTitleBar: (style & WS_MAXIMIZE) !== 0 && (style & WS_CAPTION) === WS_CAPTION,
          className: nameLength > 0 ? name.toString('utf16le', 0, nameLength * 2) : '',
          exe: exclusive || fillsMonitor(rect, info.rcMonitor) ? exeOf(hwnd) : ''
        }
      }
    }
  } catch (err) {
    log?.(`can't ask Windows about full-screen apps: ${err instanceof Error ? err.message : err}`)
    return null
  }
}
