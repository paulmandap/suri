import { useEffect } from 'react'
import { soundFor } from '@shared/sounds'
import type { IslandSnapshot } from '@shared/types'
import { Island } from './island/Island'
import { playCue } from './lib/sound'
import { useIsland } from './store'

function App(): React.JSX.Element {
  const setSnapshot = useIsland((s) => s.setSnapshot)
  const setPinnedOpen = useIsland((s) => s.setPinnedOpen)
  const openAsk = useIsland((s) => s.openAsk)
  const applyAskEvent = useIsland((s) => s.applyAskEvent)

  useEffect(() => {
    let last: IslandSnapshot | null = null
    const offSnapshot = window.suri.onSnapshot((snapshot) => {
      const cue = soundFor(last, snapshot)
      last = snapshot
      setSnapshot(snapshot)
      if (cue) playCue(cue)
    })
    const offOpen = window.suri.onOpenIsland(() => setPinnedOpen(true))
    const offAsk = window.suri.onOpenAsk(openAsk)
    const offAnswer = window.suri.onAskEvent(applyAskEvent)
    // A file dropped anywhere but the drop zone must not open in the window.
    const noDrop = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', noDrop)
    window.addEventListener('drop', noDrop)
    window.suri.rendererReady()
    return () => {
      offSnapshot()
      offOpen()
      offAsk()
      offAnswer()
      window.removeEventListener('dragover', noDrop)
      window.removeEventListener('drop', noDrop)
    }
  }, [setSnapshot, setPinnedOpen, openAsk, applyAskEvent])

  return <Island />
}

export default App
