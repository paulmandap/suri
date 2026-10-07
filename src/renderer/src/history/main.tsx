// The same dark window styles as Settings.
import '../settings/settings.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryApp } from './HistoryApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HistoryApp />
  </StrictMode>
)
