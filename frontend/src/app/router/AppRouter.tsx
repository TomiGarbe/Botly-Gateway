import { type ReactElement } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from '../layout/AppShell'
import { AlertsPage } from '../../features/alerts/pages/AlertsPage'
import { ClientDetailPage } from '../../features/clients/pages/ClientDetailPage'
import { ClientsPage } from '../../features/clients/pages/ClientsPage'
import { ConnectionDetailPage } from '../../features/connections/pages/ConnectionDetailPage'
import { ConnectionsPage } from '../../features/connections/pages/ConnectionsPage'
import { NewConnectionPage } from '../../features/connections/pages/NewConnectionPage'
import { ConnectionChoicePage } from '../../features/connections/pages/ConnectionChoicePage'
import { InstagramConnectionPage } from '../../features/connections/pages/InstagramConnectionPage'
import { InstagramCallbackPage } from '../../features/connections/pages/InstagramCallbackPage'
import { DashboardPage } from '../../features/dashboard/pages/DashboardPage'
import { AnalyticsPage } from '../../features/analytics/pages/AnalyticsPage'
import { SettingsPage } from '../../features/settings/pages/SettingsPage'
import { WebhooksPage } from '../../features/webhooks/pages/WebhooksPage'
import { WebhookDetailPage } from '../../features/webhooks/pages/WebhookDetailPage'
import { WebhookDeliveriesPage } from '../../features/webhooks/pages/WebhookDeliveriesPage'
import { WebhookDeliveryDetailPage } from '../../features/webhooks/pages/WebhookDeliveryDetailPage'
import { ProviderDeliveriesPage } from '../../features/provider-deliveries/pages/ProviderDeliveriesPage'
import { ProviderDeliveryDetailPage } from '../../features/provider-deliveries/pages/ProviderDeliveryDetailPage'
import { AccessDeniedPage } from '../../features/auth/pages/AccessDeniedPage'
import { LoginPage } from '../../features/auth/pages/LoginPage'
import { useAuth } from '../providers/AuthProvider'

function RequireAuth() {
  const { user, isLoading, accessDenied } = useAuth()
  if (isLoading) return <main className="auth-page"><span className="auth-router-loading">Cargando…</span></main>
  if (accessDenied) return <Navigate to="/access-denied" replace />
  return user ? <Outlet /> : <Navigate to="/login" replace />
}

function ReviewerRoute({ children }: { children: ReactElement }) {
  const { user } = useAuth()
  return user?.role === 'meta_reviewer' ? <Navigate to="/clients" replace /> : children
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="access-denied" element={<AccessDeniedPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<ReviewerRoute><DashboardPage /></ReviewerRoute>} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:clientId" element={<ClientDetailPage />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="connections/new" element={<ConnectionChoicePage />} />
          <Route path="clients/:clientId/connections/new" element={<ConnectionChoicePage />} />
          <Route path="clients/:clientId/connections/whatsapp/new" element={<NewConnectionPage />} />
          <Route path="clients/:clientId/connections/instagram/new" element={<InstagramConnectionPage />} />
          <Route path="connections/:connectionId/instagram/complete" element={<InstagramCallbackPage />} />
          <Route path="connections/:connectionId" element={<ConnectionDetailPage />} />
          <Route path="connections/:connectionId/webhooks" element={<ConnectionDetailPage />} />
          <Route path="connections/:connectionId/message-logs" element={<ProviderDeliveriesPage />} />
          <Route path="connections/:connectionId/message-logs/:deliveryId" element={<ProviderDeliveryDetailPage />} />
          <Route path="webhooks" element={<WebhooksPage />} />
          <Route path="webhooks/:webhookId" element={<WebhookDetailPage />} />
          <Route path="webhooks/:webhookId/deliveries" element={<WebhookDeliveriesPage />} />
          <Route path="webhooks/:webhookId/deliveries/:deliveryId" element={<WebhookDeliveryDetailPage />} />
          <Route path="alerts" element={<ReviewerRoute><AlertsPage /></ReviewerRoute>} />
          <Route path="settings" element={<ReviewerRoute><SettingsPage /></ReviewerRoute>} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
