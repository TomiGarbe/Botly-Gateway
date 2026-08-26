import { ArrowLeft, CheckCircle2, CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/shared/components/EmptyState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
import { getConnection } from '@/features/connections/api/connectionsApi'
import { ObservabilityDataSection, ObservabilityFields, ObservabilityFlow, ObservabilityStatusBadge, formatObservabilityTimestamp } from '@/features/observability/components/ObservabilityPresentation'
import type { Connection } from '@/domain/connection'
import { getProviderDelivery, reconcileProviderDelivery, resendProviderDelivery, type ProviderDeliveryDetail, type ProviderReconciliationResult, type ProviderResendResult } from '../api/providerDeliveriesApi'
import { deliveryStateLabel, formatProvider, reconciliationStateLabel } from '../components/ProviderDeliveryPresentation'

export function ProviderDeliveryDetailPage() {
  const { connectionId, deliveryId } = useParams()
  const navigate = useNavigate()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [delivery, setDelivery] = useState<ProviderDeliveryDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isReconciling, setIsReconciling] = useState(false)
  const [reconciliationResult, setReconciliationResult] = useState<ProviderReconciliationResult | null>(null)
  const [isResendConfirmOpen, setIsResendConfirmOpen] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [resendResult, setResendResult] = useState<ProviderResendResult | null>(null)

  const load = useCallback(async () => {
    if (!connectionId || !deliveryId) return
    setError(null)
    setIsLoading(true)
    try {
      const [nextConnection, nextDelivery] = await Promise.all([getConnection(connectionId), getProviderDelivery(deliveryId)])
      if (nextDelivery.summary.connectionId !== connectionId) throw new Error('delivery_connection_mismatch')
      setConnection(nextConnection)
      setDelivery(nextDelivery)
    } catch {
      setError('No se pudo cargar el detalle del log. Verifica la conexion o intenta nuevamente.')
    } finally {
      setIsLoading(false)
    }
  }, [connectionId, deliveryId])

  useEffect(() => { void load() }, [load])
  if (isLoading) return <LoadingState label="Cargando log del proveedor..." />
  if (!delivery) return <section className="provider-deliveries-page"><button type="button" className="client-back-link" onClick={() => navigate(connectionId ? `/connections/${connectionId}/message-logs` : '/connections')}><ArrowLeft size={16} /> Logs de Messages</button><EmptyState icon={CircleAlert} title="Log no disponible." description={error || 'No se encontro esta interaccion.'} /></section>

  const summary = delivery.summary
  const provider = formatProvider(summary.provider, connection?.provider)
  const outbound = summary.direction === 'outbound'
  const responseStatus = delivery.response.status
  const correlationId = typeof delivery.correlation.correlationId === 'string' ? delivery.correlation.correlationId : null
  const requestId = typeof delivery.correlation.requestId === 'string' ? delivery.correlation.requestId : null
  const canReconcile = summary.direction === 'outbound' && summary.deliveryState === 'unknown' && summary.reconciliationState === 'pending'
  const requestBody = typeof delivery.request.body === 'object' && delivery.request.body !== null ? delivery.request.body as Record<string, unknown> : {}
  const lastReconciliation = typeof delivery.metadata.lastReconciliation === 'object' && delivery.metadata.lastReconciliation !== null ? delivery.metadata.lastReconciliation as Record<string, unknown> : {}
  const isFullyReconstructableText = requestBody.messageType === 'text'
    && typeof requestBody.text === 'string' && requestBody.text.length > 0
    && typeof requestBody.recipient === 'string' && requestBody.recipient.length > 0
    && requestBody.providerOperation === 'messages.sendText'
    && requestBody.media === null && !JSON.stringify(requestBody).includes('[REDACTED]')
  const canResend = outbound && summary.provider === 'evolution' && summary.deliveryState === 'failed'
    && summary.reconciliationState === 'not_required' && isFullyReconstructableText
    && lastReconciliation.status === 'found' && lastReconciliation.confidence === 'confirmed'
    && lastReconciliation.observedState === 'failed'
  const reconcile = async () => {
    if (!deliveryId || !canReconcile) return
    setError(null)
    setIsReconciling(true)
    try {
      const result = await reconcileProviderDelivery(deliveryId)
      setReconciliationResult(result)
      await load()
    } catch {
      setError('No se pudo determinar el estado todavia. Intenta mas tarde.')
    } finally {
      setIsReconciling(false)
    }
  }
  const resend = async () => {
    if (!deliveryId || !canResend) return
    setError(null)
    setIsResending(true)
    try {
      const result = await resendProviderDelivery(deliveryId, crypto.randomUUID())
      setResendResult(result)
      setIsResendConfirmOpen(false)
      await load()
    } catch {
      setError('No fue seguro reenviar este mensaje. Reconciliá el estado y verificá la conexión actual.')
    } finally {
      setIsResending(false)
    }
  }

  return <section className="provider-delivery-detail">
    <button type="button" className="client-back-link" onClick={() => navigate(`/connections/${connectionId}/message-logs`)}><ArrowLeft size={16} /> Logs de Messages</button>
    <div className="webhook-detail-heading"><div><ObservabilityStatusBadge status={summary.semanticStatus} /><h2>{summary.operation || 'Provider delivery'}</h2><p>{formatObservabilityTimestamp(summary.timestamp)} · {provider}</p></div>{summary.semanticStatus === 'success' ? <CheckCircle2 className="delivery-heading-icon is-success" size={28} /> : <CircleAlert className="delivery-heading-icon is-error" size={28} />}</div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    {canReconcile ? <section className="webhook-detail-section"><h3>Reconciliacion</h3><p>{isReconciling ? 'Reconciliando...' : 'Consulta segura del estado original; no envia otro mensaje.'}</p><button type="button" className="client-button-secondary" disabled={isReconciling} onClick={() => void reconcile()}>{isReconciling ? 'Reconciliando...' : 'Reconciliar estado'}</button>{reconciliationResult ? <p>{reconciliationResult.status === 'found' ? 'Estado resuelto.' : 'No se pudo determinar todavia.'}</p> : null}</section> : null}
    {canResend ? <section className="webhook-detail-section"><h3>Reenvío seguro</h3><p>Evolution confirmó que el envío original falló y no fue aceptado. El reenvío usa la configuración actual y crea una nueva operación.</p><button type="button" className="client-button-danger" disabled={isResending} onClick={() => setIsResendConfirmOpen(true)}>Reenviar mensaje</button>{resendResult?.newDeliveryId ? <p><button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${connectionId}/message-logs/${resendResult.newDeliveryId}`)}>Ver nuevo ProviderDelivery</button></p> : null}</section> : null}
    <section className="webhook-detail-section provider-delivery-flow"><h3>Flujo</h3><ObservabilityFlow source={outbound ? 'Gateway' : provider} destination={outbound ? provider : 'Gateway'} durationMs={summary.durationMs} responseStatus={responseStatus} /></section>
    <section className="webhook-detail-section"><h3>Resumen</h3><dl className="webhook-summary-grid">
      <div><dt>Operacion</dt><dd><code>{summary.operation || 'No disponible'}</code></dd></div>
      <div><dt>Estado tecnico</dt><dd><ObservabilityStatusBadge status={summary.semanticStatus} /></dd></div>
      <div><dt>Estado del mensaje</dt><dd>{deliveryStateLabel(summary.deliveryState)}</dd></div>
      <div><dt>Estado de reconciliacion</dt><dd>{reconciliationStateLabel(summary.reconciliationState)}</dd></div>
      <div><dt>HTTP</dt><dd>{responseStatus === null || responseStatus === undefined ? 'Sin respuesta HTTP' : String(responseStatus)}</dd></div>
      <div><dt>Duracion</dt><dd>{summary.durationMs === null ? 'No disponible' : `${Math.round(summary.durationMs)} ms`}</dd></div>
      <div><dt>Intentos</dt><dd>{summary.attemptCount ?? 'No disponible'}</dd></div>
      <div><dt>Retries</dt><dd>{summary.retryCount ?? 'No disponible'}</dd></div>
    </dl></section>
    <section className="webhook-detail-section"><h3>Provider</h3><ObservabilityFields values={{ provider, direction: summary.direction, messageId: summary.messageId, conversationId: summary.conversationId, channelId: summary.channelId, providerMessageId: summary.providerMessageId }} emptyLabel="Sin informacion especifica del provider." /></section>
    <section className="webhook-detail-section"><h3>Identidad y correlacion</h3><ObservabilityFields values={{ ...delivery.identity, ...delivery.correlation }} emptyLabel="Sin identificadores adicionales." /></section>
    {summary.messageId || summary.conversationId || correlationId || requestId ? <section className="provider-delivery-navigation"><div><h3>Eventos relacionados</h3><p>Reutiliza los filtros seguros de esta conexion.</p></div><div className="observability-related-links">{summary.messageId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${connectionId}/message-logs?message_id=${encodeURIComponent(summary.messageId || '')}`)}>Mismo mensaje</button> : null}{summary.conversationId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${connectionId}/message-logs?conversation_id=${encodeURIComponent(summary.conversationId || '')}`)}>Misma conversacion</button> : null}{correlationId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${connectionId}/message-logs?correlation_id=${encodeURIComponent(correlationId)}`)}>Misma correlacion</button> : null}{requestId ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${connectionId}/message-logs?request_id=${encodeURIComponent(requestId)}`)}>Mismo request</button> : null}</div></section> : null}
    <ObservabilityDataSection title="Request" value={delivery.request} emptyLabel="No se guardaron datos de request." />
    <ObservabilityDataSection title="Response" value={delivery.response} emptyLabel="Sin respuesta HTTP." />
    <ObservabilityDataSection title="Error" value={delivery.error || {}} emptyLabel="No se registro un error." tone="error" />
    <ObservabilityDataSection title="Metadata" value={delivery.metadata} emptyLabel="No hay metadata adicional." />
    <ConfirmDialog isOpen={isResendConfirmOpen} title="¿Reenviar este mensaje?" description="Se enviará nuevamente el mensaje. Evolution confirmó que el original no fue aceptado. Se usará la configuración actual y se creará una nueva operación; podría haber un duplicado si el estado histórico del provider fuera incorrecto." confirmLabel="Reenviar mensaje" submittingLabel="Reenviando…" isSubmitting={isResending} onCancel={() => { if (!isResending) setIsResendConfirmOpen(false) }} onConfirm={() => void resend()} />
  </section>
}
