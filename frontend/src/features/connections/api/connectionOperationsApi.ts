import { gatewayRequest } from '@/shared/lib/gatewayClient'

export interface ConnectionWebhook {
  configured: boolean
  enabled: boolean
  url: string | null
  id: string | null
  lastDeliveryAt: string | null
  lastError: string | null
  successfulDeliveries: number
  failedDeliveries: number
}

export interface ConnectionApiKey {
  enabled: boolean
  hasApiKey: boolean
  maskedApiKey: string | null
  createdAt: string | null
  apiKey?: string
}

export interface ConnectionActivity {
  id: string
  occurredAt: number
  description: string
  status: string
  severity: string
  technical: Record<string, string>
}

export interface ConnectionStatusSummary {
  connected: boolean
  lastActivityAt: string | null
  lastHeartbeatAt: string | null
}

interface ApiConnectionApiKey {
  enabled: boolean
  has_api_key: boolean
  masked_api_key: string | null
  created_at: string | null
  api_key?: string
}

function toApiKey(payload: ApiConnectionApiKey): ConnectionApiKey {
  return {
    enabled: payload.enabled,
    hasApiKey: payload.has_api_key,
    maskedApiKey: payload.masked_api_key,
    createdAt: payload.created_at,
    apiKey: payload.api_key,
  }
}

export async function getConnectionWebhook(connectionId: string): Promise<ConnectionWebhook> {
  const payload = await gatewayRequest<{
    configured: boolean
    enabled: boolean
    url: string | null
    id: string | null
    last_delivery_at: string | null
    last_error: string | null
    successful_deliveries: number
    failed_deliveries: number
  }>(`/connections/${encodeURIComponent(connectionId)}/webhook`)
  return {
    configured: payload.configured,
    enabled: payload.enabled,
    url: payload.url,
    id: payload.id,
    lastDeliveryAt: payload.last_delivery_at,
    lastError: payload.last_error,
    successfulDeliveries: payload.successful_deliveries,
    failedDeliveries: payload.failed_deliveries,
  }
}

export async function updateConnectionWebhook(connectionId: string, url: string): Promise<ConnectionWebhook> {
  const payload = await gatewayRequest<{
    configured: boolean
    enabled: boolean
    url: string | null
    id: string | null
    last_delivery_at: string | null
    last_error: string | null
    successful_deliveries: number
    failed_deliveries: number
  }>(`/connections/${encodeURIComponent(connectionId)}/webhook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return {
    configured: payload.configured,
    enabled: payload.enabled,
    url: payload.url,
    id: payload.id,
    lastDeliveryAt: payload.last_delivery_at,
    lastError: payload.last_error,
    successfulDeliveries: payload.successful_deliveries,
    failedDeliveries: payload.failed_deliveries,
  }
}

export async function testConnectionWebhook(connectionId: string): Promise<{ ok: boolean; status: number; error: string | null }> {
  return gatewayRequest(`/connections/${encodeURIComponent(connectionId)}/webhook/test`, { method: 'POST' })
}

export async function getConnectionApiKey(connectionId: string): Promise<ConnectionApiKey> {
  return toApiKey(await gatewayRequest<ApiConnectionApiKey>(`/connections/${encodeURIComponent(connectionId)}/api-key`))
}

export async function regenerateConnectionApiKey(connectionId: string): Promise<ConnectionApiKey> {
  return toApiKey(await gatewayRequest<ApiConnectionApiKey>(`/connections/${encodeURIComponent(connectionId)}/api-key/regenerate`, { method: 'POST' }))
}

export async function reconnectConnection(connectionId: string): Promise<void> {
  await gatewayRequest(`/connections/${encodeURIComponent(connectionId)}/reconnect`, { method: 'POST' })
}

export async function listConnectionActivity(connectionId: string): Promise<ConnectionActivity[]> {
  const payload = await gatewayRequest<{ items: Array<{ id: string; occurred_at: number; description: string; status: string; severity: string; technical: Record<string, string> }> }>(`/connections/${encodeURIComponent(connectionId)}/activity`)
  return payload.items.map((item) => ({
    id: item.id,
    occurredAt: item.occurred_at,
    description: item.description,
    status: item.status,
    severity: item.severity,
    technical: item.technical,
  }))
}

export async function getConnectionStatusSummary(connectionId: string): Promise<ConnectionStatusSummary> {
  const payload = await gatewayRequest<{ connected: boolean; last_activity_at: string | null; last_heartbeat_at: string | null }>(`/connections/${encodeURIComponent(connectionId)}/status`)
  return {
    connected: payload.connected,
    lastActivityAt: payload.last_activity_at,
    lastHeartbeatAt: payload.last_heartbeat_at,
  }
}

export async function sendConnectionQuickMessage(connectionId: string, number: string, text: string): Promise<void> {
  await gatewayRequest(`/connections/${encodeURIComponent(connectionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, text }),
  })
}
