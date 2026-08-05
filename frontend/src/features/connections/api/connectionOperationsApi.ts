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

export interface ConnectionDiagnosticCheck {
  code: string
  label: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  lastVerifiedAt: string | null
  message: string
  action: string | null
}

export interface ConnectionDiagnostics {
  summary: {
    status: ConnectionDiagnosticCheck['status']
    lastVerifiedAt: string | null
    lastHeartbeatAt: string | null
    lastMessageSentAt: number | null
    lastMessageReceivedAt: number | null
    lastWebhookSuccessAt: string | null
    lastError: string | null
  }
  checks: ConnectionDiagnosticCheck[]
  technical: {
    phoneNumberId: string | null
    businessId: string | null
    wabaId: string | null
    provider: string | null
    channel: string | null
    apiVersion: string | null
    lastSynchronizedAt: string | null
  }
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

export async function getConnectionDiagnostics(connectionId: string): Promise<ConnectionDiagnostics> {
  const payload = await gatewayRequest<{
    summary: { status: ConnectionDiagnosticCheck['status']; last_verified_at: string | null; last_heartbeat_at: string | null; last_message_sent_at: number | null; last_message_received_at: number | null; last_webhook_success_at: string | null; last_error: string | null }
    checks: Array<{ code: string; label: string; status: ConnectionDiagnosticCheck['status']; last_verified_at: string | null; message: string; action: string | null }>
    technical: { phone_number_id: string | null; business_id: string | null; waba_id: string | null; provider: string | null; channel: string | null; api_version: string | null; last_synchronized_at: string | null }
  }>(`/connections/${encodeURIComponent(connectionId)}/diagnostics`)
  return {
    summary: { status: payload.summary.status, lastVerifiedAt: payload.summary.last_verified_at, lastHeartbeatAt: payload.summary.last_heartbeat_at, lastMessageSentAt: payload.summary.last_message_sent_at, lastMessageReceivedAt: payload.summary.last_message_received_at, lastWebhookSuccessAt: payload.summary.last_webhook_success_at, lastError: payload.summary.last_error },
    checks: payload.checks.map((item) => ({ code: item.code, label: item.label, status: item.status, lastVerifiedAt: item.last_verified_at, message: item.message, action: item.action })),
    technical: { phoneNumberId: payload.technical.phone_number_id, businessId: payload.technical.business_id, wabaId: payload.technical.waba_id, provider: payload.technical.provider, channel: payload.technical.channel, apiVersion: payload.technical.api_version, lastSynchronizedAt: payload.technical.last_synchronized_at },
  }
}

export async function enqueueConnectionOperation(runtimeName: string, type: 'synchronize' | 'health_refresh'): Promise<void> {
  await gatewayRequest('/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, targets: [runtimeName], scope: 'selected' }),
  })
}

export async function sendConnectionQuickMessage(connectionId: string, number: string, text: string): Promise<void> {
  await gatewayRequest(`/connections/${encodeURIComponent(connectionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, text }),
  })
}
