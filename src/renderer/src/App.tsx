import { useEffect } from 'react'
import { Island } from './island/Island'
import { useIsland } from './store'

function App(): React.JSX.Element {
  const setSnapshot = useIsland((s) => s.setSnapshot)
  const setPinnedOpen = useIsland((s) => s.setPinnedOpen)

  useEffect(() => {
    const offSnapshot = window.suri.onSnapshot(setSnapshot)
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
