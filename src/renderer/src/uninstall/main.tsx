import '../settings/settings.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { UninstallApp } from './UninstallApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UninstallApp />
  </StrictMode>
)
