import { ArrowRight, CheckCircle2, CircleAlert, Clock3, Network, Settings2 } from 'lucide-react'
import { SafeJsonViewer } from './SafeJsonViewer'
import type { ObservabilitySemanticStatus } from '../types'

export function formatObservabilityTimestamp(value: number | null): string {
  if (!value) return 'Fecha no disponible'
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

export function observabilityStatusLabel(status: ObservabilitySemanticStatus | null): string {
  return ({ success: 'Éxito', failed: 'Error', timeout: 'Timeout', network_error: 'Error de red', configuration_error: 'Configuración', unknown: 'Desconocido' } as Record<string, string>)[status || ''] || 'Sin estado'
}

export function ObservabilityStatusBadge({ status }: { status: ObservabilitySemanticStatus | null }) {
  const Icon = status === 'success' ? CheckCircle2 : status === 'timeout' ? Clock3 : status === 'network_error' ? Network : status === 'configuration_error' ? Settings2 : CircleAlert
  return <span className={`observability-status is-${status || 'unknown'}`}><Icon size={16} aria-hidden="true" /> {observabilityStatusLabel(status)}</span>
}

export function ObservabilityFlow({ source, destination, durationMs, responseStatus }: { source: string; destination: string; durationMs?: number | null; responseStatus?: unknown }) {
  const response = responseStatus === null || responseStatus === undefined || responseStatus === '' ? 'Sin respuesta HTTP' : `Respuesta ${String(responseStatus)}`
  return <div className="observability-flow"><strong>{source}</strong><ArrowRight size={18} aria-hidden="true" /><strong>{destination}</strong><span>{response}</span>{durationMs === null || durationMs === undefined ? null : <small>{Math.round(durationMs)} ms</small>}</div>
}

const labels: Record<string, string> = {
  id: 'ID', webhookId: 'Webhook ID', eventId: 'Event ID', requestId: 'Request ID', correlationId: 'Correlation ID',
  messageId: 'Message ID', conversationId: 'Conversation ID', providerMessageId: 'Provider Message ID',
  connectionId: 'Connection ID', channelId: 'Channel ID',
}

export function ObservabilityFields({ values, emptyLabel }: { values: Record<string, unknown>; emptyLabel: string }) {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '')
  if (!entries.length) return <p className="webhook-json-empty">{emptyLabel}</p>
  return <dl className="webhook-summary-grid">{entries.map(([key, value]) => <div key={key}><dt>{labels[key] || key}</dt><dd><code>{String(value)}</code></dd></div>)}</dl>
}

export function ObservabilityDataSection({ title, value, emptyLabel, tone = 'default' }: { title: string; value: unknown; emptyLabel: string; tone?: 'default' | 'error' }) {
  return <section className={`webhook-delivery-data${tone === 'error' ? ' provider-delivery-error' : ''}`}><h3>{title}</h3><SafeJsonViewer value={value} emptyLabel={emptyLabel} /></section>
}

export function ObservabilityPagination({ total, limit, offset, loading, onPrevious, onNext }: { total: number; limit: number; offset: number; loading: boolean; onPrevious: () => void; onNext: () => void }) {
  if (!total) return null
  const start = offset + 1
  const end = Math.min(offset + limit, total)
  return <div className="webhook-pagination"><span>Mostrando {start}–{end} de {total}</span><button type="button" className="client-button-secondary" disabled={loading || offset === 0} onClick={onPrevious}>Anterior</button><button type="button" className="client-button-secondary" disabled={loading || offset + limit >= total} onClick={onNext}>Siguiente</button></div>
}
