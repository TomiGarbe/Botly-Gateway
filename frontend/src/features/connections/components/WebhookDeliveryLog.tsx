import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, RefreshCw, SendHorizontal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { listConnectionWebhookDeliveries, type WebhookDelivery, type WebhookDeliveryMetrics } from '../api/connectionOperationsApi'

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function resultLabel(item: WebhookDelivery): string {
  if (item.success) return 'Entregado a Botly'
  if (item.statusCode) return `Error HTTP ${item.statusCode}`
  return item.errorType === 'timeout' ? 'Tiempo de espera agotado' : 'Entrega fallida'
}

function metricValue(value: number, suffix = ''): string { return `${value}${suffix}` }

function messagePreview(item: WebhookDelivery): string | null {
  const summary = item.request.payloadSummary
  const text = summary?.textPreview?.trim() || summary?.mediaCaption?.trim()
  if (text) return text
  const kind = summary?.mediaKind || summary?.messageType
  return kind ? `[Mensaje ${kind}]` : null
}

function messageMetadata(item: WebhookDelivery): string | null {
  const summary = item.request.payloadSummary
  const parts = [summary?.direction === 'outbound' ? 'Saliente' : summary?.direction === 'inbound' ? 'Entrante' : null, summary?.recipient ? `Para ${summary.recipient}` : null]
  return parts.filter(Boolean).join(' · ') || null
}

export function WebhookDeliveryLog({ connectionId }: { connectionId: string }) {
  const [items, setItems] = useState<WebhookDelivery[]>([])
  const [metrics, setMetrics] = useState<WebhookDeliveryMetrics | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true)
    try {
      const result = await listConnectionWebhookDeliveries(connectionId)
      setItems(result.items)
      setMetrics(result.metrics)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el registro de webhooks.')
    } finally {
      if (!quiet) setIsLoading(false)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const interval = window.setInterval(() => { void load(true) }, 5000)
    return () => window.clearInterval(interval)
  }, [load])

  return <section className="connection-section webhook-delivery-log">
    <div className="connection-section-heading">
      <div><h3>Registro de webhooks a Botly</h3><p>Solicitudes que el Gateway envió a Botly, con su resultado real.</p></div>
      <button type="button" className="client-button-secondary" onClick={() => void load()} disabled={isLoading}><RefreshCw size={15} /> Actualizar</button>
    </div>
    {metrics ? <div className="webhook-log-metrics">
      <span className="is-success"><CheckCircle2 size={15} /> {metricValue(metrics.successfulDeliveries)} correctas</span>
      <span className={metrics.failedDeliveries ? 'is-error' : ''}><AlertTriangle size={15} /> {metricValue(metrics.failedDeliveries)} con error</span>
      <span><Clock3 size={15} /> {metricValue(Math.round(metrics.averageResponseTimeMs), ' ms')} promedio</span>
      <span><RefreshCw size={15} /> {metricValue(metrics.retries)} reintentos</span>
    </div> : null}
    {error ? <p className="webhook-log-error">{error}</p> : null}
    {isLoading ? <LoadingState label="Cargando entregas…" lines={2} /> : null}
    {!isLoading && items.length === 0 ? <EmptyState icon={SendHorizontal} title="Todavía no se enviaron webhooks." description="Cuando llegue un mensaje al Gateway o se ejecute una prueba, aparecerá el resultado aquí." /> : null}
    {!isLoading && items.length > 0 ? <ol className="webhook-delivery-list">
      {items.map((item, index) => <li key={`${item.timestamp}-${item.messageId || index}`} className={item.success ? 'is-success' : 'is-error'}>
        <div className="webhook-delivery-result">{item.success ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}</div>
        <div className="webhook-delivery-main"><strong>{resultLabel(item)}</strong><span>{formatTime(item.timestamp)} · {item.eventType || 'Evento'}{item.messageId ? ` · Mensaje ${item.messageId}` : ''}</span>{messagePreview(item) ? <p className="webhook-delivery-message">{messagePreview(item)}</p> : null}{messageMetadata(item) ? <small>{messageMetadata(item)}</small> : null}{item.error ? <p>{item.error}</p> : null}</div>
        <div className="webhook-delivery-meta"><span>{item.statusCode ? `HTTP ${item.statusCode}` : 'Sin respuesta'}</span><span>{Math.round(item.durationMs)} ms</span>{item.retryCount ? <span>{item.retryCount} reintento{item.retryCount === 1 ? '' : 's'}</span> : null}</div>
        <details><summary>Ver detalle <ChevronDown size={14} /></summary><dl><div><dt>Destino</dt><dd>{item.destinationUrl || 'No disponible'}</dd></div><div><dt>Contenido enviado</dt><dd><code>{item.request.payloadPreview || JSON.stringify(item.request.payloadSummary || {})}</code></dd></div>{item.response.bodyPreview ? <div><dt>Respuesta</dt><dd><code>{item.response.bodyPreview}</code></dd></div> : null}</dl></details>
      </li>)}
    </ol> : null}
  </section>
}
