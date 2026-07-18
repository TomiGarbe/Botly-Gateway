import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { DataDeletionPage, PrivacyPage, TermsPage } from './pages/Legal'
import './index.css'

registerSW({ immediate: true })

// Rutas publicas requeridas por Meta. Se resuelven por path para no sumar un
// router al panel: el resto de la app sigue siendo una SPA de una sola vista.
const PUBLIC_ROUTES: Record<string, () => JSX.Element> = {
  '/privacy': PrivacyPage,
  '/terms': TermsPage,
  '/data-deletion': DataDeletionPage,
}

function resolveRoute() {
  const path = window.location.pathname.replace(/\/+$/, '').toLowerCase() || '/'
  return PUBLIC_ROUTES[path] ?? App
}

const Route = resolveRoute()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Route />
  </React.StrictMode>
)
