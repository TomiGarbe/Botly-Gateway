import { FlaskConical, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getWebhookTestPayload, type WebhookRecord } from '@/features/webhooks/api/webhooksApi'

export function WebhookTestPanel({ webhooks, selected, isSubmitting, onSelect, onCancel, onSubmit }: {
  webhooks: WebhookRecord[]
  selected: WebhookRecord
  isSubmitting: boolean
  onSelect: (webhook: WebhookRecord) => void
  onCancel: () => void
  onSubmit: (webhook: WebhookRecord, payload: Record<string, unknown>) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setIsLoading(true); setError(null); setValue('')
    void getWebhookTestPayload(selected.id).then((result) => {
      if (active) setValue(JSON.stringify(result.payload, null, 2))
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : 'No se pudo preparar el payload de prueba.')
    }).finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [selected.id])

  async function submit() {
    try {
      const payload: unknown = JSON.parse(value)
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('El payload debe ser un objeto JSON.')
      setError(null)
      await onSubmit(selected, payload as Record<string, unknown>)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'El payload debe ser JSON válido.')
    }
  }

  return <section className="connection-webhook-test-panel" aria-label="Prueba de webhook">
    <div className="connection-webhook-test-panel-heading"><div><h4>Probar webhook</h4><p>El test usa el contrato real de entrega y genera un delivery en la actividad.</p></div><button type="button" className="client-button-ghost" onClick={onCancel} disabled={isSubmitting}><X size={16} /> Cerrar</button></div>
    {webhooks.length > 1 ? <label><span>Webhook a probar</span><select value={selected.id} onChange={(event) => { const next = webhooks.find((item) => item.id === event.target.value); if (next) onSelect(next) }}>{webhooks.map((webhook) => <option key={webhook.id} value={webhook.id} disabled={!webhook.enabled}>{webhook.name} · {webhook.enabled ? 'Activo' : 'Inactivo'}</option>)}</select></label> : <p className="connection-webhook-test-target">Webhook: <strong>{selected.name}</strong></p>}
    <label><span>Payload de prueba</span><textarea value={value} onChange={(event) => setValue(event.target.value)} disabled={isLoading || isSubmitting} spellCheck={false} aria-describedby="webhook-test-payload-help" /></label>
    <p id="webhook-test-payload-help" className="connection-webhook-test-help">Podés editar el JSON. El runtime y el origen de prueba se conservan para mantener la trazabilidad.</p>
    {error ? <p className="client-form-error" role="alert">{error}</p> : null}
    <div className="connection-webhook-card-actions"><button type="button" className="client-button-primary" onClick={() => void submit()} disabled={isLoading || isSubmitting}>{<FlaskConical size={15} />} {isSubmitting ? 'Enviando prueba…' : 'Enviar prueba'}</button></div>
  </section>
}
