import { CircleAlert, Clock3, RefreshCw, Search, SendHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { ObservabilityDataSection, ObservabilityFields, ObservabilityStatusBadge, formatObservabilityTimestamp } from '@/features/observability/components/ObservabilityPresentation'
import { listConnectionWebhookDeliveries, type WebhookDelivery } from '../api/connectionOperationsApi'

function label(delivery: WebhookDelivery): string {
  if (delivery.isTest) return 'Prueba de webhook'
  return delivery.eventType || delivery.operation || 'Entrega de webhook'
}

function httpStatus(delivery: WebhookDelivery): string {
  return delivery.statusCode ? `HTTP ${delivery.statusCode}` : 'Sin respuesta HTTP'
}

function duration(value: number): string | null {
  return Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : null
}

function searchText(delivery: WebhookDelivery): string {
  return [label(delivery), delivery.id, delivery.webhookId, delivery.webhookName, delivery.eventId, delivery.requestId, delivery.correlationId, delivery.messageId, delivery.destinationUrl].filter(Boolean).join(' ').toLocaleLowerCase()
}

export function WebhookActivityTimeline({ connectionId, refreshToken = 0, selectedDeliveryId = null }: { connectionId: string; refreshToken?: number; selectedDeliveryId?: string | null }) {
  const [items, setItems] = useState<WebhookDelivery[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    setError(null)
    if (refresh) setIsRefreshing(true)
    else setIsLoading(true)
    try {
      const result = await listConnectionWebhookDeliveries(connectionId)
      setItems(result.items)
      setSelectedId((current) => current && result.items.some((item) => item.id === current) ? current : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar la actividad de webhooks.')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (refreshToken) void load(true) }, [load, refreshToken])
  useEffect(() => {
    if (selectedDeliveryId && items.some((item) => item.id === selectedDeliveryId)) setSelectedId(selectedDeliveryId)
  }, [items, selectedDeliveryId])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? items.filter((item) => searchText(item).includes(query)) : items
  }, [items, search])
  const selected = items.find((item) => item.id === selectedId) || null

  return <section className="connection-section webhook-activity">
    <div className="connection-section-heading">
      <div><h3>Actividad</h3><p>Últimas 100 entregas lógicas de esta conexión.</p></div>
      <button type="button" className="client-button-secondary" onClick={() => void load(true)} disabled={isLoading || isRefreshing}><RefreshCw size={15} className={isRefreshing ? 'is-spinning' : undefined} aria-hidden="true" /> Actualizar</button>
    </div>
    <div className="webhook-activity-toolbar">
      <label className="webhook-activity-search"><Search size={16} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar evento, delivery o ID" aria-label="Buscar actividad de webhooks" /></label>
    </div>
    {isLoading ? <LoadingState label="Cargando actividad de webhooks…" lines={3} /> : null}
    {!isLoading && error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>Reintentar</button></div> : null}
    {!isLoading && !error && items.length === 0 ? <EmptyState icon={SendHorizontal} title="Todavía no hay actividad." description="Las entregas y pruebas de esta conexión aparecerán aquí cuando se registren." /> : null}
    {!isLoading && !error && items.length > 0 ? <div className="webhook-activity-layout">
      <div className="webhook-activity-list" aria-label="Lista de actividad de webhooks">
        {filtered.length === 0 ? <EmptyState icon={Search} title="No hay coincidencias." description="Probá con otro evento o identificador." /> : <ol>{filtered.map((delivery) => <li key={delivery.id}><button type="button" className={`webhook-activity-row${delivery.id === selectedId ? ' is-selected' : ''}`} onClick={() => setSelectedId(delivery.id)} aria-pressed={delivery.id === selectedId}>
          <div className="webhook-activity-row-main"><strong>{label(delivery)}</strong><span>{delivery.webhookName || delivery.destinationUrl || 'Webhook'}</span></div>
          <time dateTime={new Date(delivery.timestamp).toISOString()}>{formatObservabilityTimestamp(delivery.timestamp)}</time>
          <div className="webhook-activity-row-meta"><span className={delivery.success ? 'is-success' : 'is-error'}>{httpStatus(delivery)}</span>{duration(delivery.durationMs) ? <span>{duration(delivery.durationMs)}</span> : null}</div>
        </button></li>)}</ol>}
      </div>
      <div className="webhook-activity-detail">
        {!selected ? <EmptyState icon={Clock3} title="Seleccioná una entrega." description="Elegí un evento de la lista para revisar su request, response e identificadores." /> : <WebhookActivityDetail delivery={selected} />}
      </div>
    </div> : null}
  </section>
}

function WebhookActivityDetail({ delivery }: { delivery: WebhookDelivery }) {
  const request = Object.fromEntries(Object.entries({ method: delivery.request.method, url: delivery.request.url, query: delivery.request.query, headers: delivery.request.headers, payloadSummary: delivery.request.payloadSummary, payload: delivery.request.payloadPreview, payloadTruncated: delivery.request.payloadTruncated }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  const response = Object.fromEntries(Object.entries({ status: delivery.response.status || delivery.statusCode || undefined, headers: delivery.response.headers, body: delivery.response.bodyPreview }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  const hasError = Boolean(delivery.error || delivery.errorDetail)

  return <>
    <div className="webhook-activity-detail-heading"><div><ObservabilityStatusBadge status={delivery.semanticStatus} /><h4>{label(delivery)}</h4><time dateTime={new Date(delivery.timestamp).toISOString()}>{formatObservabilityTimestamp(delivery.timestamp)}</time></div>{hasError ? <CircleAlert className="is-error" size={24} aria-label="Delivery fallido" /> : null}</div>
    <section className="webhook-activity-detail-section"><h4>Resumen</h4><dl className="webhook-summary-grid"><div><dt>Evento</dt><dd>{label(delivery)}</dd></div><div><dt>Estado</dt><dd><ObservabilityStatusBadge status={delivery.semanticStatus} /></dd></div><div><dt>HTTP</dt><dd>{httpStatus(delivery)}</dd></div>{duration(delivery.durationMs) ? <div><dt>Duración</dt><dd>{duration(delivery.durationMs)}</dd></div> : null}{delivery.attemptCount > 0 ? <div><dt>Intentos</dt><dd>{delivery.attemptCount}</dd></div> : null}{delivery.retryCount > 0 ? <div><dt>Reintentos</dt><dd>{delivery.retryCount}</dd></div> : null}</dl></section>
    <section className="webhook-activity-detail-section"><h4>Identificadores</h4><ObservabilityFields values={{ webhookId: delivery.webhookId, id: delivery.id, eventId: delivery.eventId, requestId: delivery.requestId, correlationId: delivery.correlationId, messageId: delivery.messageId, conversationId: delivery.conversationId }} emptyLabel="Sin identificadores adicionales." /></section>
    {Object.keys(request).length ? <ObservabilityDataSection title="Request" value={request} emptyLabel="No se guardaron datos del request." /> : null}
    {Object.keys(response).length ? <ObservabilityDataSection title="Response" value={response} emptyLabel="No se guardaron datos del response." /> : null}
    {hasError ? <ObservabilityDataSection title="Error" value={delivery.errorDetail || delivery.error} emptyLabel="No se registró un error." tone="error" /> : null}
    {delivery.attempts.length ? <ObservabilityDataSection title={`Intentos (${delivery.attempts.length})`} value={delivery.attempts} emptyLabel="No se guardaron intentos." /> : null}
  </>
}
