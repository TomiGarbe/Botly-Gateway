import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from '../layout/AppShell'
import { AlertsPage } from '../../features/alerts/pages/AlertsPage'
import { ClientDetailPage } from '../../features/clients/pages/ClientDetailPage'
import { ClientsPage } from '../../features/clients/pages/ClientsPage'
import { ConnectionDetailPage } from '../../features/connections/pages/ConnectionDetailPage'
import { NewConnectionPage } from '../../features/connections/pages/NewConnectionPage'
import { DashboardPage } from '../../features/dashboard/pages/DashboardPage'
import { SettingsPage } from '../../features/settings/pages/SettingsPage'
import { AccessDeniedPage } from '../../features/auth/pages/AccessDeniedPage'
import { LoginPage } from '../../features/auth/pages/LoginPage'
import { useAuth } from '../providers/AuthProvider'

function RequireAuth() {
  const { user, isLoading, accessDenied } = useAuth()
  if (isLoading) return <main className="auth-page"><span className="auth-router-loading">Cargando…</span></main>
  if (accessDenied) return <Navigate to="/access-denied" replace />
  return user ? <Outlet /> : <Navigate to="/login" replace />
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="access-denied" element={<AccessDeniedPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:clientId" element={<ClientDetailPage />} />
          <Route path="clients/:clientId/connections/new" element={<NewConnectionPage />} />
          <Route path="connections/:connectionId" element={<ConnectionDetailPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
