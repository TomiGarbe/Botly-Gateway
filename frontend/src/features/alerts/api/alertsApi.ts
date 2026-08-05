import { gatewayRequest } from '@/shared/lib/gatewayClient'

export type AlertSeverity = 'critical' | 'warning' | 'info'
export type AlertStatus = 'new' | 'acknowledged' | 'resolved'

export interface GatewayAlert {
  id: string
  severity: AlertSeverity
  status: AlertStatus
  title: string
  description: string
  client: { id: string; name: string }
  connection: { id: string; name: string }
  createdAt: string
  resolvedAt: string | null
  workspaceUrl: string
}

interface ApiAlert {
  id: string
  severity: AlertSeverity
  status: AlertStatus
  title: string
  description: string
  client: { id: string; name: string }
  connection: { id: string; name: string }
  created_at: string
  resolved_at: string | null
  workspace_url: string
}

function toAlert(payload: ApiAlert): GatewayAlert {
  return {
    id: payload.id,
    severity: payload.severity,
    status: payload.status,
    title: payload.title,
    description: payload.description,
    client: payload.client,
    connection: payload.connection,
    createdAt: payload.created_at,
    resolvedAt: payload.resolved_at,
    workspaceUrl: payload.workspace_url,
  }
}

export async function listAlerts(): Promise<GatewayAlert[]> {
  const payload = await gatewayRequest<{ items: ApiAlert[] }>('/alerts')
  return payload.items.map(toAlert)
}

export async function acknowledgeAlert(alertId: string): Promise<GatewayAlert> {
  return toAlert(await gatewayRequest<ApiAlert>(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: 'POST' }))
}

export async function resolveAlert(alertId: string): Promise<GatewayAlert> {
  return toAlert(await gatewayRequest<ApiAlert>(`/alerts/${encodeURIComponent(alertId)}/resolve`, { method: 'POST' }))
}

export async function deleteAlert(alertId: string): Promise<void> {
  await gatewayRequest<void>(`/alerts/${encodeURIComponent(alertId)}`, { method: 'DELETE' })
}

export async function deleteResolvedAlerts(): Promise<number> {
  const payload = await gatewayRequest<{ deleted: number }>('/alerts/resolved', { method: 'DELETE' })
  return payload.deleted
}
