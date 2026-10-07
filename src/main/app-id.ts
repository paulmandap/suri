// Windows knows Suri by this id: the taskbar, notifications, and the name of
// the "Start with Windows" entry (Electron names it after this id). The
// uninstall run must use it too, or it removes an entry that isn't there.
// electron-builder.yml's appId is the same.
export const APP_ID = 'io.github.paulmandap.suri'
