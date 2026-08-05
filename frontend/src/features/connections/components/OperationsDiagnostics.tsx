import { Activity, CheckCircle2, CircleAlert, CloudCog, HeartPulse, KeyRound, LoaderCircle, RefreshCw, RotateCw, ShieldCheck, Unplug, Webhook } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ConnectionDiagnostics } from '../api/connectionOperationsApi'
import { enqueueConnectionOperation, getConnectionDiagnostics, getConnectionWebhook } from '../api/connectionOperationsApi'

function dateTime(value: string | number | null, fallback = 'Sin registro'): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function statusLabel(status: ConnectionDiagnostics['summary']['status']): string {
  return { healthy: 'Operativa', degraded: 'Requiere atención', unhealthy: 'Con error', unknown: 'Sin verificar' }[status]
}

function StatusIcon({ status }: { status: ConnectionDiagnostics['summary']['status'] }) {
  if (status === 'healthy') return <CheckCircle2 aria-hidden="true" />
  if (status === 'degraded') return <CircleAlert aria-hidden="true" />
  if (status === 'unhealthy') return <Unplug aria-hidden="true" />
  return <Activity aria-hidden="true" />
}

interface Props {
  connectionId: string
  runtimeName: string | null
  onReconnect: () => Promise<void>
  onTestWebhook: () => Promise<void>
  onRegenerateKey: () => Promise<void>
  onRefreshConnection: () => Promise<void>
}

export function OperationsDiagnostics({ connectionId, runtimeName, onReconnect, onTestWebhook, onRegenerateKey, onRefreshConnection }: Props) {
  const [data, setData] = useState<ConnectionDiagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getConnectionDiagnostics(connectionId))
    } catch {
      setError('No se pudo obtener el diagnóstico de la conexión.')
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => { void load() }, [load])

  async function run(name: string, operation: () => Promise<void>, success: string) {
    setRunning(name)
    setError(null)
    setNotice(null)
    try {
      await operation()
      setNotice(success)
      await Promise.all([load(), onRefreshConnection()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'La operación no pudo completarse.')
    } finally {
      setRunning(null)
    }
  }

  async function validateWebhook() {
    const webhook = await getConnectionWebhook(connectionId)
    if (!webhook.configured || !webhook.enabled) throw new Error('No hay un webhook activo para validar.')
  }

  const action = (name: string, label: string, Icon: typeof RefreshCw, operation: () => Promise<void>, success: string) => <button type="button" className="connection-operation" disabled={Boolean(running)} onClick={() => void run(name, operation, success)}><Icon size={16} aria-hidden="true" /> {running === name ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : null}<span>{label}</span></button>

  return <>
    <section className="connection-section diagnostics-summary">
      <div className="connection-section-heading"><div><h3>Salud de la conexión</h3><p>Estado operativo verificado desde el Gateway.</p></div><button type="button" className="client-button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></div>
      {loading ? <p className="connection-section-value">Actualizando diagnóstico…</p> : null}
      {error ? <p className="diagnostics-feedback diagnostics-feedback-error" role="alert">{error}</p> : null}
      {notice ? <p className="diagnostics-feedback diagnostics-feedback-success" role="status">{notice}</p> : null}
      {data ? <><div className={`diagnostics-overall diagnostics-overall-${data.summary.status}`}><StatusIcon status={data.summary.status} /><div><strong>{statusLabel(data.summary.status)}</strong><span>Última verificación: {dateTime(data.summary.lastVerifiedAt)}</span></div></div><dl className="diagnostics-summary-list"><div><dt>Último heartbeat</dt><dd>{dateTime(data.summary.lastHeartbeatAt)}</dd></div><div><dt>Último mensaje enviado</dt><dd>{dateTime(data.summary.lastMessageSentAt)}</dd></div><div><dt>Último mensaje recibido</dt><dd>{dateTime(data.summary.lastMessageReceivedAt)}</dd></div><div><dt>Último webhook exitoso</dt><dd>{dateTime(data.summary.lastWebhookSuccessAt)}</dd></div><div><dt>Último error</dt><dd>{data.summary.lastError || 'Sin errores registrados'}</dd></div></dl></> : null}
    </section>
    <section className="connection-section">
      <div className="connection-section-heading"><div><h3>Diagnóstico</h3><p>Controles de disponibilidad y configuración.</p></div></div>
      {data ? <ul className="diagnostics-checks">{data.checks.map((check) => <li key={check.code}><StatusIcon status={check.status} /><div><div><strong>{check.label}</strong><span className={`diagnostic-check-status diagnostic-check-status-${check.status}`}>{statusLabel(check.status)}</span></div><p>{check.message}</p><small>Verificado: {dateTime(check.lastVerifiedAt)}</small>{check.action ? <em>Acción sugerida: {check.action}</em> : null}</div></li>)}</ul> : null}
    </section>
    <section className="connection-section">
      <div className="connection-section-heading"><div><h3>Operaciones</h3><p>Acciones seguras sobre esta conexión.</p></div></div>
      <div className="connection-operations-grid">
        {action('reconnect', 'Reconectar', RotateCw, onReconnect, 'Reconexión solicitada.')}
        {runtimeName ? action('sync', 'Sincronizar Meta', CloudCog, () => enqueueConnectionOperation(runtimeName, 'synchronize'), 'Sincronización encolada.') : null}
        {runtimeName ? action('health', 'Actualizar estado', HeartPulse, () => enqueueConnectionOperation(runtimeName, 'health_refresh'), 'Actualización de estado encolada.') : null}
        {action('validate', 'Validar webhook', ShieldCheck, validateWebhook, 'Webhook activo y configurado.')}
        {action('test', 'Probar webhook', Webhook, onTestWebhook, 'Prueba de webhook completada.')}
        {action('refresh', 'Refrescar datos', RefreshCw, async () => undefined, 'Datos de conexión actualizados.')}
        {action('key', 'Regenerar API Key', KeyRound, onRegenerateKey, 'API Key regenerada. Copiala desde la sección correspondiente.')}
      </div>
    </section>
    <section className="connection-section">
      <div className="connection-section-heading"><div><h3>Información técnica</h3><p>Datos de referencia de solo lectura.</p></div></div>
      {data ? <dl className="diagnostics-technical-list"><div><dt>Phone Number ID</dt><dd>{data.technical.phoneNumberId || 'No disponible'}</dd></div><div><dt>Business ID</dt><dd>{data.technical.businessId || 'No disponible'}</dd></div><div><dt>WABA ID</dt><dd>{data.technical.wabaId || 'No disponible'}</dd></div><div><dt>Provider</dt><dd>{data.technical.provider || 'No disponible'}</dd></div><div><dt>Canal</dt><dd>{data.technical.channel || 'No disponible'}</dd></div><div><dt>Versión de API</dt><dd>{data.technical.apiVersion || 'No aplica'}</dd></div><div><dt>Última sincronización</dt><dd>{dateTime(data.technical.lastSynchronizedAt)}</dd></div></dl> : null}
    </section>
  </>
}
