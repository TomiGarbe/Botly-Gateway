import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, FlaskConical, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ObservabilityDataSection, ObservabilityFields, ObservabilityFlow, ObservabilityStatusBadge, formatObservabilityTimestamp } from '@/features/observability/components/ObservabilityPresentation'
import { getWebhookDelivery, redeliverWebhookCurrentTarget, repeatWebhookTest, type RedeliverWebhookResult, type RepeatWebhookTestResult, type WebhookDelivery } from '../api/webhooksApi'

export function WebhookDeliveryDetailPage() {
  const navigate = useNavigate()
  const { webhookId, deliveryId } = useParams()
  const [delivery, setDelivery] = useState<WebhookDelivery | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isRepeatConfirmOpen, setIsRepeatConfirmOpen] = useState(false)
  const [isRepeating, setIsRepeating] = useState(false)
  const [repeatIdempotencyKey, setRepeatIdempotencyKey] = useState<string | null>(null)
  const [repeatResult, setRepeatResult] = useState<RepeatWebhookTestResult | null>(null)
  const [isRedeliveryConfirmOpen, setIsRedeliveryConfirmOpen] = useState(false)
  const [isRedelivering, setIsRedelivering] = useState(false)
  const [redeliveryIdempotencyKey, setRedeliveryIdempotencyKey] = useState<string | null>(null)
  const [redeliveryResult, setRedeliveryResult] = useState<RedeliverWebhookResult | null>(null)

  const load = useCallback(async () => {
    if (!webhookId || !deliveryId) return
    setError(null)
    setIsLoading(true)
    try {
      setDelivery(await getWebhookDelivery(webhookId, deliveryId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el detalle de la entrega.')
    } finally {
      setIsLoading(false)
    }
  }, [webhookId, deliveryId])

  useEffect(() => { void load() }, [load])

  async function repeatTest() {
    if (!webhookId || !deliveryId) return
    setIsRepeating(true)
    setError(null)
    try {
      const idempotencyKey = repeatIdempotencyKey || crypto.randomUUID()
      if (!repeatIdempotencyKey) setRepeatIdempotencyKey(idempotencyKey)
      const result = await repeatWebhookTest(webhookId, deliveryId, idempotencyKey)
      setRepeatResult(result)
      setRepeatIdempotencyKey(null)
      if (result.status === 'completed') setNotice('Prueba enviada correctamente.')
      else setError(result.result?.error || 'La prueba falló.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo repetir la prueba.')
    } finally {
      setIsRepeating(false)
      setIsRepeatConfirmOpen(false)
    }
  }

  async function redeliverCurrentTarget() {
    if (!webhookId || !deliveryId) return
    setIsRedelivering(true)
    setError(null)
    try {
      const idempotencyKey = redeliveryIdempotencyKey || crypto.randomUUID()
      if (!redeliveryIdempotencyKey) setRedeliveryIdempotencyKey(idempotencyKey)
      const result = await redeliverWebhookCurrentTarget(webhookId, deliveryId, idempotencyKey)
      setRedeliveryResult(result)
      setRedeliveryIdempotencyKey(null)
      if (result.status === 'completed') setNotice('Entrega reenviada correctamente.')
      else setError(result.result?.error || 'La entrega no pudo reenviarse.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo reenviar la entrega.')
    } finally {
      setIsRedelivering(false)
      setIsRedeliveryConfirmOpen(false)
    }
  }

  if (isLoading) return <LoadingState label="Cargando entrega…" />
  if (!delivery) return <section className="webhooks-page"><button type="button" className="client-back-link" onClick={() => navigate(webhookId ? `/webhooks/${webhookId}/deliveries` : '/webhooks')}><ArrowLeft size={16} /> Entregas</button><EmptyState icon={Clock3} title="Entrega no disponible." description={error || 'No se encontró esta entrega.'} /></section>

  const source = delivery.source?.name || 'Gateway'
  const destination = delivery.destination?.name || 'Bot'
  const repeatedSucceeded = repeatResult?.status === 'completed'
  const redeliverySucceeded = redeliveryResult?.status === 'completed'

  return <section className="webhook-delivery-detail">
    <button type="button" className="client-back-link" onClick={() => navigate(`/webhooks/${webhookId}/deliveries`)}><ArrowLeft size={16} /> Entregas</button>
    <div className="webhook-detail-heading"><div><ObservabilityStatusBadge status={delivery.semanticStatus} /><h2>{delivery.isTest ? 'Prueba de webhook' : delivery.eventType || 'Entrega'}</h2><p>{formatObservabilityTimestamp(delivery.timestamp)}</p></div>{delivery.success ? <CheckCircle2 className="delivery-heading-icon is-success" size={28} /> : <CircleAlert className="delivery-heading-icon is-error" size={28} />}</div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <Toast message={notice} onDismiss={() => setNotice(null)} />

    {delivery.isTest ? <section className="webhook-detail-section"><h3>Acción manual</h3><p>La prueba nueva usará la configuración actual del webhook. No modifica ni reemplaza esta entrega original.</p><button type="button" className="client-button-primary" disabled={isRepeating} onClick={() => { setRepeatIdempotencyKey((current) => current || crypto.randomUUID()); setIsRepeatConfirmOpen(true) }}><FlaskConical size={15} /> {isRepeating ? 'Enviando prueba…' : 'Repetir prueba'}</button>{repeatResult ? <div className={`webhook-operation-result ${repeatedSucceeded ? 'is-success' : 'is-error'}`}><div><strong>{repeatedSucceeded ? 'Prueba enviada correctamente' : 'La prueba falló'}</strong><span>{repeatResult.result?.statusCode ? `HTTP ${repeatResult.result.statusCode}` : 'Sin respuesta HTTP'}{repeatResult.result?.latencyMs !== null && repeatResult.result?.latencyMs !== undefined ? ` · ${Math.round(repeatResult.result.latencyMs)} ms` : ''}</span></div>{repeatResult.newDeliveryId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhookId}/deliveries/${repeatResult.newDeliveryId}`)}>Ver nueva entrega</button> : null}</div> : null}</section> : null}

    {!delivery.isTest ? <section className="webhook-detail-section"><h3>Reentrega manual</h3><p>Se enviará nuevamente el payload original disponible al destino y configuración actuales. El destino puede haber cambiado y el receptor podría procesar una entrega duplicada.</p><button type="button" className="client-button-danger" disabled={isRedelivering} onClick={() => { setRedeliveryIdempotencyKey((current) => current || crypto.randomUUID()); setIsRedeliveryConfirmOpen(true) }}><Send size={15} /> {isRedelivering ? 'Reenviando…' : 'Reenviar al destino actual'}</button>{redeliveryResult ? <div className={`webhook-operation-result ${redeliverySucceeded ? 'is-success' : 'is-error'}`}><div><strong>{redeliverySucceeded ? 'Entrega reenviada correctamente' : 'La entrega no pudo reenviarse'}</strong><span>{redeliveryResult.observableDestinationDrift ? 'El destino actual difiere del registrado. ' : ''}{redeliveryResult.result?.statusCode ? `HTTP ${redeliveryResult.result.statusCode}` : 'Sin respuesta HTTP'}{redeliveryResult.result?.latencyMs !== null && redeliveryResult.result?.latencyMs !== undefined ? ` · ${Math.round(redeliveryResult.result.latencyMs)} ms` : ''}</span></div>{redeliveryResult.newDeliveryId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhookId}/deliveries/${redeliveryResult.newDeliveryId}`)}>Ver nueva entrega</button> : null}</div> : null}</section> : null}
    <section className="webhook-detail-section provider-delivery-flow"><h3>Flujo</h3><ObservabilityFlow source={source} destination={destination} durationMs={delivery.durationMs} responseStatus={delivery.statusCode || null} /></section>
    <section className="webhook-detail-section"><h3>Resumen</h3><dl className="webhook-summary-grid"><div><dt>Operación</dt><dd><code>{delivery.operation}</code></dd></div><div><dt>Estado semántico</dt><dd><ObservabilityStatusBadge status={delivery.semanticStatus} /></dd></div><div><dt>HTTP</dt><dd>{delivery.statusCode || 'Sin respuesta'}</dd></div><div><dt>Duración</dt><dd>{Math.round(delivery.durationMs)} ms</dd></div><div><dt>Intentos</dt><dd>{delivery.attemptCount}</dd></div></dl></section>
    <section className="webhook-detail-section"><h3>Webhook</h3><ObservabilityFields values={{ webhookId: delivery.webhookId, eventType: delivery.eventType, isTest: delivery.isTest ? 'Sí' : 'No' }} emptyLabel="Sin información específica del webhook." /></section>
    <section className="webhook-detail-section"><h3>Identidad y correlación</h3><ObservabilityFields values={{ id: delivery.id, correlationId: delivery.correlationId, eventId: delivery.eventId, requestId: delivery.requestId, messageId: delivery.messageId, conversationId: delivery.conversationId }} emptyLabel="Sin identificadores adicionales." /></section>
    {delivery.eventId || delivery.requestId || delivery.correlationId ? <section className="provider-delivery-navigation"><div><h3>Deliveries relacionados</h3><p>Los enlaces aplican filtros server-side sobre este webhook.</p></div><div className="observability-related-links">{delivery.eventId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhookId}/deliveries?event_id=${encodeURIComponent(delivery.eventId || '')}`)}>Mismo evento</button> : null}{delivery.requestId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhookId}/deliveries?request_id=${encodeURIComponent(delivery.requestId || '')}`)}>Mismo request</button> : null}{delivery.correlationId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhookId}/deliveries?correlation_id=${encodeURIComponent(delivery.correlationId || '')}`)}>Misma correlación</button> : null}</div></section> : null}
    <ObservabilityDataSection title="Request" value={delivery.request} emptyLabel="No se guardaron datos de request." />
    <ObservabilityDataSection title="Response" value={delivery.response} emptyLabel="No se guardaron datos de response." />
    <ObservabilityDataSection title="Error" value={delivery.errorDetail || delivery.error || {}} emptyLabel="No se registró un error." tone="error" />
    <ObservabilityDataSection title="Metadata" value={delivery.metadata} emptyLabel="No hay metadata adicional." />
    <ConfirmDialog isOpen={isRepeatConfirmOpen} title="Repetir prueba de webhook" description="Se ejecutará una nueva prueba usando la configuración actual de este webhook. Esto no modifica ni reemplaza la entrega original." confirmLabel="Repetir prueba" submittingLabel="Enviando prueba…" tone="default" isSubmitting={isRepeating} onCancel={() => setIsRepeatConfirmOpen(false)} onConfirm={() => void repeatTest()} />
    <ConfirmDialog isOpen={isRedeliveryConfirmOpen} title="Reenviar esta entrega" description="Se enviará el payload original disponible al destino y configuración actuales. Esto no modifica la entrega original y puede generar un procesamiento duplicado en el receptor." confirmLabel="Reenviar entrega" submittingLabel="Reenviando…" tone="danger" isSubmitting={isRedelivering} onCancel={() => setIsRedeliveryConfirmOpen(false)} onConfirm={() => void redeliverCurrentTarget()} />
  </section>
}
