import { gatewayRequest } from '@/shared/lib/gatewayClient'

export type AnalyticsPreset = 'today' | '24h' | '7d' | '30d' | 'custom'
export type AnalyticsGranularity = 'hour' | 'day'

export interface StatusCounts { success: number; failed: number; timeout: number; network_error: number; configuration_error: number; unknown: number }
export interface LatencyMetrics { sampleCount: number; averageMs: number | null; p95Ms: number | null }
export interface AnalyticsProvider { provider: string; totalDeliveries: number; messages: number; inbound: number; outbound: number; statusEvents: number; technical: StatusCounts; deliveryStates: Record<string, number>; reconciliationStates: Record<string, number>; technicalSuccessRate: number | null; technicalFailureRate: number | null; technicalUnknownRate: number | null; latency: LatencyMetrics }
export interface AnalyticsConnection { connectionId: string; connectionName: string; provider: string; totalProviderDeliveries: number; messages: number; failedDeliveries: number; unknownDeliveries: number; timeoutDeliveries: number; pendingReconciliation: number; webhookFailures: number }
export interface AnalyticsSnapshot {
  range: { fromUtc: string; toUtc: string; inclusiveStart: boolean; exclusiveEnd: boolean; granularity: AnalyticsGranularity }
  summary: { totalMessages: number; inboundMessages: number; outboundMessages: number; providerDeliveries: number; providerTechnicalSuccess: number; providerFailures: number; providerUnknown: number; pendingReconciliation: number; webhookDeliveries: number; webhookFailures: number }
  providers: AnalyticsProvider[]
  attempts: { totalAttempts: number; technical: StatusCounts; deliveryStates: Record<string, number>; accepted: number; pendingReconciliation: number; reconciled: number; stillUnknown: number }
  manualActions: { totalActions: number; resendTotal: number; resendCompleted: number; resendFailed: number; resendBlocked: number }
  webhooks: { totalDeliveries: number; technical: StatusCounts; testDeliveries: number; realDeliveries: number; totalAttempts: number; retries: number; technicalSuccessRate: number | null; technicalFailureRate: number | null; latency: LatencyMetrics }
  connections: AnalyticsConnection[]
  timeseries: Array<{ bucketStartUtc: string; messages: number; providerFailures: number; providerUnknown: number; webhookFailures: number }>
}

export async function getAnalytics(input: { preset: AnalyticsPreset; granularity: AnalyticsGranularity; dateFrom?: string; dateTo?: string }): Promise<AnalyticsSnapshot> {
  const params = new URLSearchParams({ preset: input.preset, granularity: input.granularity })
  if (input.preset === 'custom' && input.dateFrom && input.dateTo) { params.set('date_from', input.dateFrom); params.set('date_to', input.dateTo) }
  return gatewayRequest<AnalyticsSnapshot>(`/analytics?${params.toString()}`)
}
