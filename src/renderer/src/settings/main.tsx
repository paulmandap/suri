import './settings.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './SettingsApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
)
