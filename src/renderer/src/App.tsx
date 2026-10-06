import { useEffect } from 'react'
import { soundFor } from '@shared/sounds'
import type { IslandSnapshot } from '@shared/types'
import { Island } from './island/Island'
import { playCue } from './lib/sound'
import { useIsland } from './store'

function App(): React.JSX.Element {
  const setSnapshot = useIsland((s) => s.setSnapshot)
  const setPinnedOpen = useIsland((s) => s.setPinnedOpen)

  useEffect(() => {
    let last: IslandSnapshot | null = null
    const offSnapshot = window.suri.onSnapshot((snapshot) => {
      const cue = soundFor(last, snapshot)
      last = snapshot
      setSnapshot(snapshot)
      if (cue) playCue(cue)
    })
    const offOpen = window.suri.onOpenIsland(() => setPinnedOpen(true))
    window.suri.rendererReady()
    return () => {
      offSnapshot()
      offOpen()
    }
  }, [setSnapshot, setPinnedOpen])

  return <Island />
}

export default App
