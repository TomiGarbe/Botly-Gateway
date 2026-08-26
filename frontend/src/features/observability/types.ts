export type ObservabilitySemanticStatus = 'success' | 'failed' | 'timeout' | 'network_error' | 'configuration_error' | string

export interface ObservabilityEndpoint {
  name?: string | null
  kind?: string | null
  service?: string | null
  type?: string | null
}

/** Shared read vocabulary; domain-specific delivery types extend this shape. */
export interface BaseObservabilityEvent {
  id: string | null
  timestamp: number | null
  operation: string | null
  semanticStatus: ObservabilitySemanticStatus | null
  source?: ObservabilityEndpoint | null
  destination?: ObservabilityEndpoint | null
  durationMs: number | null
  attemptCount: number | null
  correlationId: string | null
}
