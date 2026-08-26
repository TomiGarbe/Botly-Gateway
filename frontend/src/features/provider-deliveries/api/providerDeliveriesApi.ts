import { gatewayRequest } from '@/shared/lib/gatewayClient'
import type { BaseObservabilityEvent } from '@/features/observability/types'

export type ProviderDeliveryStatus = 'success' | 'failed' | 'timeout' | 'network_error' | 'configuration_error' | 'unknown'
export type ProviderDeliveryDirection = 'inbound' | 'outbound' | 'status'
export type ProviderDeliveryOperation = 'provider.message.inbound' | 'provider.message.outbound' | 'provider.message.status'
export type ProviderDeliveryState = 'pending' | 'accepted' | 'unknown' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | null
export type ProviderReconciliationState = 'pending' | 'not_required' | null

export interface ProviderDeliveryListItem extends BaseObservabilityEvent {
  id: string | null
  timestamp: number | null
  direction: ProviderDeliveryDirection | null
  operation: ProviderDeliveryOperation | null
  provider: string | null
  semanticStatus: ProviderDeliveryStatus | null
  deliveryState: ProviderDeliveryState
  reconciliationState: ProviderReconciliationState
  messageId: string | null
  conversationId: string | null
  channelId: string | null
  connectionId: string | null
  providerMessageId: string | null
  durationMs: number | null
  attemptCount: number | null
  retryCount: number | null
  correlationId: string | null
  requestId?: string | null
  eventId?: string | null
  isTest: boolean
}

export interface ProviderDeliveryPage { items: ProviderDeliveryListItem[]; total: number; limit: number; offset: number }

export interface ProviderDeliveryDetail {
  summary: ProviderDeliveryListItem
  identity: Record<string, unknown>
  correlation: Record<string, unknown>
  request: Record<string, unknown>
  response: Record<string, unknown>
  error: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

export interface ProviderReconciliationResult {
  reconciliationId: string
  attemptId: string
  provider: string
  startedAt: number
  completedAt: number
  status: 'found' | 'not_found' | 'inconclusive' | 'unavailable'
  providerMessageId: string | null
  observedState: ProviderDeliveryState
  confidence: 'confirmed' | 'inconclusive'
  reason: string | null
  error: string | null
}

export interface ProviderResendResult {
  action: Record<string, unknown>
  actionId: string
  idempotent: boolean
  newAttemptId: string | null
  newDeliveryId: string | null
  provider: string | null
}

export interface ProviderDeliveryFilters {
  connectionId: string
  provider?: string
  direction?: ProviderDeliveryDirection
  status?: ProviderDeliveryStatus
  operation?: ProviderDeliveryOperation
  messageId?: string
  providerMessageId?: string
  conversationId?: string
  channelId?: string
  correlationId?: string
  requestId?: string
  eventId?: string
  deliveryId?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export async function listProviderDeliveries(filters: ProviderDeliveryFilters): Promise<ProviderDeliveryPage> {
  const params = new URLSearchParams({ connection_id: filters.connectionId, limit: String(filters.limit || 50), offset: String(filters.offset || 0) })
  const values: Record<string, string | undefined> = {
    provider: filters.provider, direction: filters.direction, status: filters.status, operation: filters.operation,
    delivery_id: filters.deliveryId, message_id: filters.messageId, provider_message_id: filters.providerMessageId,
    conversation_id: filters.conversationId, channel_id: filters.channelId, correlation_id: filters.correlationId,
    request_id: filters.requestId, event_id: filters.eventId, search: filters.search,
    date_from: filters.dateFrom, date_to: filters.dateTo,
  }
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value) })
  return gatewayRequest<ProviderDeliveryPage>(`/provider-deliveries?${params.toString()}`)
}

export function getProviderDelivery(deliveryId: string): Promise<ProviderDeliveryDetail> {
  return gatewayRequest<ProviderDeliveryDetail>(`/provider-deliveries/${encodeURIComponent(deliveryId)}`)
}

export function reconcileProviderDelivery(deliveryId: string): Promise<ProviderReconciliationResult> {
  return gatewayRequest<ProviderReconciliationResult>(`/provider-deliveries/${encodeURIComponent(deliveryId)}/reconcile`, { method: 'POST' })
}

export function resendProviderDelivery(deliveryId: string, idempotencyKey: string): Promise<ProviderResendResult> {
  return gatewayRequest<ProviderResendResult>(`/provider-deliveries/${encodeURIComponent(deliveryId)}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ confirmCurrentConfiguration: true }),
  })
}
