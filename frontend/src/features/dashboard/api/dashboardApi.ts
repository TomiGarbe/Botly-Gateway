import { gatewayRequest } from '@/shared/lib/gatewayClient'

export type DashboardOverallState = 'healthy' | 'attention' | 'critical'

export interface DashboardReference {
  id: string
  name: string
}

export interface DashboardActivity {
  id: string
  kind: string
  description: string
  occurredAt: number
  severity: 'normal' | 'warning' | 'critical'
  client: DashboardReference | null
  connection: DashboardReference | null
}

export interface DashboardAttention {
  severity: 'warning' | 'critical'
  status: string
  client: DashboardReference
  connection: DashboardReference
}

export interface DashboardSnapshot {
  overall: { state: DashboardOverallState; label: string }
  metrics: { clients: number; connections: number; connected: number; activeAlerts: number }
  recentActivity: DashboardActivity[]
  attention: DashboardAttention[]
}

interface ApiDashboardSnapshot {
  overall: DashboardSnapshot['overall']
  metrics: { clients: number; connections: number; connected: number; active_alerts: number }
  recent_activity: Array<{
    id: string
    kind: string
    description: string
    occurred_at: number
    severity: DashboardActivity['severity']
    client: DashboardReference | null
    connection: DashboardReference | null
  }>
  attention: Array<{
    severity: DashboardAttention['severity']
    status: string
    client: DashboardReference
    connection: DashboardReference
  }>
}

export async function getDashboard(): Promise<DashboardSnapshot> {
  const payload = await gatewayRequest<ApiDashboardSnapshot>('/dashboard')
  return {
    overall: payload.overall,
    metrics: {
      clients: payload.metrics.clients,
      connections: payload.metrics.connections,
      connected: payload.metrics.connected,
      activeAlerts: payload.metrics.active_alerts,
    },
    recentActivity: payload.recent_activity.map((item) => ({
      id: item.id,
      kind: item.kind,
      description: item.description,
      occurredAt: item.occurred_at,
      severity: item.severity,
      client: item.client,
      connection: item.connection,
    })),
    attention: payload.attention,
  }
}
