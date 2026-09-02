import { gatewayRequest } from '@/shared/lib/gatewayClient'
import type { BaseObservabilityEvent, ObservabilityEndpoint } from '@/features/observability/types'

export type WebhookAuthType = 'NONE' | 'BEARER' | 'API_KEY' | 'BASIC' | 'CUSTOM_HEADERS' | 'QUERY_PARAM'

export interface WebhookRecord {
  id: string
  connectionId: string
  name: string
  url: string
  enabled: boolean
  authType: WebhookAuthType
  authConfig: Record<string, string | boolean>
  customHeaders: Record<string, string>
  hasCustomHeaders?: boolean
  eventFilters: Record<string, boolean>
  createdAt: string | null
  updatedAt: string | null
  lastUsedAt: string | null
  lastStatus: string | null
  lastStatusCode: number | null
  lastLatencyMs: number | null
  lastError: string | null
  healthStatus: 'healthy' | 'degraded' | 'unhealthy' | string
  successCount: number
  failureCount: number
  retryCount: number
}

export interface WebhookInput {
  connectionId: string
  name: string
  url: string
  enabled: boolean
  authType: WebhookAuthType
  authConfig?: Record<string, string>
  customHeaders?: Record<string, string>
  eventFilters: Record<string, boolean>
}

export interface WebhookDelivery extends BaseObservabilityEvent {
  id: string
  webhookId: string
  timestamp: number
  eventType: string | null
  eventId?: string | null
  requestId?: string | null
  operation: string
  semanticStatus: 'success' | 'failed' | 'timeout' | 'network_error' | 'configuration_error' | string
  status: string
  success: boolean
  statusCode: number
  durationMs: number
  attemptCount: number
  retryCount: number
  correlationId: string | null
  messageId: string | null
  conversationId: string | null
  isTest: boolean
  error: string | null
  errorType: string | null
  source?: ObservabilityEndpoint | null
  destination?: ObservabilityEndpoint | null
  request: Record<string, unknown>
  response: Record<string, unknown>
  attempts: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  summary?: Record<string, unknown>
  errorDetail?: { code: string; category: string; message: string | null; retryable: boolean | null } | null
}

export interface WebhookTestResult {
  ok: boolean
  status: number
  error: string | null
  retriesUsed: number
  latencyMs: number | null
  deliveryType: 'test'
  deliveryId: string | null
  requestId: string
  webhookId: string
}

export interface RepeatWebhookTestResult {
  actionId: string
  action: 'repeat_test'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  risk: 'safe' | 'warning' | 'ambiguous' | 'blocked'
  sourceDeliveryId: string
  newDeliveryId: string | null
  configurationSource: 'current'
  result: { ok?: boolean; statusCode?: number; latencyMs?: number | null; retriesUsed?: number; error?: string | null } | null
}

export interface RedeliverWebhookResult {
  actionId: string
  action: 'redeliver_current_target'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  risk: 'warning'
  sourceDeliveryId: string
  newDeliveryId: string | null
  configurationSource: 'current'
  observableDestinationDrift: boolean
  result: { ok?: boolean; statusCode?: number; latencyMs?: number | null; retriesUsed?: number; error?: string | null } | null
}

export interface WebhookDiagnosis {
  target: { host: string; port: number; url: string }
  dns: { resolved: boolean; addresses: string[] }
  tcp: { ok: boolean; error: string | null }
  http: { ok: boolean; statusCode?: number; error?: string; bodyPreview?: string }
  timestamp: number
}

export async function listWebhooks(connectionId?: string): Promise<WebhookRecord[]> {
  const query = connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ''
  return (await gatewayRequest<{ items: WebhookRecord[] }>(`/webhooks${query}`)).items
}

export function getWebhook(webhookId: string): Promise<WebhookRecord> {
  return gatewayRequest<WebhookRecord>(`/webhooks/${encodeURIComponent(webhookId)}`)
}

export function createWebhook(input: WebhookInput): Promise<WebhookRecord> {
  const { connectionId, ...body } = input
  return gatewayRequest<WebhookRecord>('/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connection_id: connectionId, ...body }) })
}

export function updateWebhook(webhookId: string, input: Partial<Omit<WebhookInput, 'connectionId'>>): Promise<WebhookRecord> {
  return gatewayRequest<WebhookRecord>(`/webhooks/${encodeURIComponent(webhookId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
}

export function setWebhookEnabled(webhookId: string, enabled: boolean): Promise<WebhookRecord> {
  return gatewayRequest<WebhookRecord>(`/webhooks/${encodeURIComponent(webhookId)}/enabled`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
}

export function deleteWebhook(webhookId: string): Promise<void> {
  return gatewayRequest<void>(`/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' })
}

export function getWebhookTestPayload(webhookId: string): Promise<{ payload: Record<string, unknown> }> {
  return gatewayRequest<{ payload: Record<string, unknown> }>(`/webhooks/${encodeURIComponent(webhookId)}/test-payload`)
}

export function testWebhook(webhookId: string, payload?: Record<string, unknown>): Promise<WebhookTestResult> {
  return gatewayRequest<WebhookTestResult>(`/webhooks/${encodeURIComponent(webhookId)}/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ? { payload } : {}),
  })
}

export function diagnoseWebhook(webhookId: string): Promise<WebhookDiagnosis> {
  return gatewayRequest<WebhookDiagnosis>(`/webhooks/${encodeURIComponent(webhookId)}/diagnose`, { method: 'POST' })
}

export interface WebhookDeliveryPage { items: WebhookDelivery[]; total: number; limit: number; offset: number }

export async function listWebhookDeliveries(webhookId: string, options: { limit?: number; offset?: number; status?: string; operation?: string; eventType?: string; isTest?: boolean; deliveryId?: string; eventId?: string; requestId?: string; correlationId?: string; search?: string; dateFrom?: number; dateTo?: number } = {}): Promise<WebhookDeliveryPage> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit || 50)); params.set('offset', String(options.offset || 0))
  if (options.status) params.set('status', options.status)
  if (options.operation) params.set('operation', options.operation)
  if (options.eventType) params.set('event_type', options.eventType)
  if (options.isTest !== undefined) params.set('is_test', String(options.isTest))
  if (options.deliveryId) params.set('delivery_id', options.deliveryId)
  if (options.eventId) params.set('event_id', options.eventId)
  if (options.requestId) params.set('request_id', options.requestId)
  if (options.correlationId) params.set('correlation_id', options.correlationId)
  if (options.search) params.set('search', options.search)
  if (options.dateFrom !== undefined) params.set('date_from', String(options.dateFrom))
  if (options.dateTo !== undefined) params.set('date_to', String(options.dateTo))
  return gatewayRequest<WebhookDeliveryPage>(`/webhooks/${encodeURIComponent(webhookId)}/deliveries?${params.toString()}`)
}

export function getWebhookDelivery(webhookId: string, deliveryId: string): Promise<WebhookDelivery> {
  return gatewayRequest<WebhookDelivery>(`/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}`)
}

export function repeatWebhookTest(webhookId: string, deliveryId: string, idempotencyKey: string): Promise<RepeatWebhookTestResult> {
  return gatewayRequest<RepeatWebhookTestResult>(`/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/repeat-test`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({}),
  })
}

export function redeliverWebhookCurrentTarget(webhookId: string, deliveryId: string, idempotencyKey: string): Promise<RedeliverWebhookResult> {
  return gatewayRequest<RedeliverWebhookResult>(`/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver-current-target`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ confirmCurrentTarget: true }),
  })
}
