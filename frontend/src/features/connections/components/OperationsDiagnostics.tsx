import { Activity, CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, RotateCw, Unplug, Webhook, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Toast } from '@/shared/components/Toast'
import type { ConnectionAvailability, ConnectionDiagnosticCheck, ConnectionDiagnostics } from '../api/connectionOperationsApi'
import { getConnectionAvailability, getConnectionDiagnostics, verifyConnectionWebhookConfiguration } from '../api/connectionOperationsApi'

type DiagnosticStatus = ConnectionDiagnosticCheck['status']

function dateTime(value: string | number | null, fallback = 'Sin registro'): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function healthLabel(status: DiagnosticStatus): string {
  return { healthy: 'Saludable', degraded: 'Atención requerida', unhealthy: 'No disponible', unknown: 'Sin verificar' }[status]
}

function runtimeLabel(status: DiagnosticStatus | undefined): string {
  if (status === 'healthy') return 'Conectado'
  if (status === 'degraded') return 'Conectando o con atención requerida'
  if (status === 'unhealthy') return 'Desconectado'
  return 'Sin verificar'
}

function availabilityLabel(status: DiagnosticStatus | undefined): string {
  if (status === 'healthy' || status === 'degraded') return 'Disponible'
  if (status === 'unhealthy') return 'No disponible'
  return 'Sin verificar'
}

function StatusIcon({ status }: { status: DiagnosticStatus }) {
  if (status === 'healthy') return <CheckCircle2 aria-hidden="true" />
  if (status === 'degraded') return <CircleAlert aria-hidden="true" />
  if (status === 'unhealthy') return <Unplug aria-hidden="true" />
  return <Activity aria-hidden="true" />
}

interface Props {
  connectionId: string
  providerId: string
  onReconnect: () => Promise<void>
  onRefreshConnection: () => Promise<void>
  onManageWebhooks: () => void
}

export function OperationsDiagnostics({ connectionId, providerId, onReconnect, onRefreshConnection, onManageWebhooks }: Props) {
  const [data, setData] = useState<ConnectionDiagnostics | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false)
  const isMeta = providerId.toLowerCase() === 'meta'

  const refreshDiagnostics = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      setData(await getConnectionDiagnostics(connectionId))
    } catch {
      setError('No se pudo actualizar el diagnóstico de la conexión. Intentá nuevamente.')
    } finally {
      setRefreshing(false)
    }
  }, [connectionId])

  useEffect(() => { void refreshDiagnostics() }, [refreshDiagnostics])

  async function verifyAvailability() {
    setRunning('availability')
    setError(null)
    try {
      const result: ConnectionAvailability = await getConnectionAvailability(connectionId)
      setData(result.diagnostics)
      setNotice(result.available ? 'Disponibilidad verificada.' : 'La conexión no está disponible. Revisá el diagnóstico.')
    } catch {
      setError('No se pudo verificar la disponibilidad de la conexión.')
    } finally {
      setRunning(null)
    }
  }

  async function verifyWebhookConfiguration() {
    setRunning('webhook-configuration')
    setError(null)
    try {
      const result = await verifyConnectionWebhookConfiguration(connectionId)
      setNotice(result.configuration_valid ? 'Configuración de webhook verificada.' : 'La configuración del webhook requiere revisión.')
    } catch {
      setError('No se pudo verificar la configuración del webhook.')
    } finally {
      setRunning(null)
    }
  }

  async function reconnect() {
    setRunning('reconnect')
    setError(null)
    try {
      await onReconnect()
      setNotice('Reconexión solicitada. El runtime confirmará el nuevo estado en el próximo diagnóstico.')
      await Promise.all([refreshDiagnostics(), onRefreshConnection()])
    } catch {
      setError('No se pudo solicitar la reconexión. Verificá el estado del runtime.')
    } finally {
      setRunning(null)
    }
  }

  const runtimeCheck = data?.checks.find((check) => check.code === 'gateway')
  const overallStatus = data?.summary.status || 'unknown'
  const currentAvailability = availabilityLabel(runtimeCheck?.status)
  const canReconnect = !isMeta && runtimeCheck?.status === 'degraded'
  const hasHistoricalError = overallStatus === 'healthy'

  const operationButton = (name: 'availability' | 'reconnect' | 'webhook-configuration' | 'refresh', label: string, Icon: typeof RefreshCw, onClick: () => void, kind: 'action' | 'diagnostic', disabled = false) => (
    <button type="button" className={`operation-button operation-button-${kind}`} disabled={disabled || running === name} onClick={onClick}>
      {running === name ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
      <span>{running === name ? ({ availability: 'Verificando disponibilidad…', reconnect: 'Reconectando…', 'webhook-configuration': 'Verificando configuración…', refresh: 'Actualizando…' } as Record<string, string>)[name] : label}</span>
    </button>
  )

  return <section className="operations-console" aria-label="Operaciones de conexión">
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />

    <section className="operation-section operation-status-card" aria-labelledby="connection-status-heading">
      <div className="operation-section-heading">
        <div>
          <p>Estado de la conexión</p>
          <div className={`operation-status-summary operation-status-summary-${overallStatus}`}>
            <StatusIcon status={overallStatus} />
            <div><h3 id="connection-status-heading">{refreshing ? 'Actualizando diagnóstico…' : healthLabel(overallStatus)}</h3><span>{runtimeLabel(runtimeCheck?.status)} · {currentAvailability}</span></div>
          </div>
          <small>Última verificación: {dateTime(data?.summary.lastVerifiedAt || null)}</small>
        </div>
        {operationButton('refresh', 'Actualizar diagnóstico', RefreshCw, () => void refreshDiagnostics(), 'diagnostic', refreshing)}
      </div>
      <dl className="operation-status-grid">
        <div><dt>Runtime</dt><dd>{runtimeLabel(runtimeCheck?.status)}</dd></div>
        <div><dt>Salud</dt><dd>{healthLabel(overallStatus)}</dd></div>
        <div><dt>Disponibilidad</dt><dd>{currentAvailability}</dd></div>
      </dl>
    </section>

    <section className="operation-section" aria-labelledby="actions-heading">
      <div className="operation-section-heading"><div><p>Acciones</p><h3 id="actions-heading">Acciones disponibles</h3><span>Solo se muestran operaciones que pueden ejecutarse ahora.</span></div></div>
      <div className="operation-actions-row">
        {canReconnect ? operationButton('reconnect', 'Reconectar', RotateCw, () => void reconnect(), 'action') : null}
      </div>
      <button type="button" className="connection-text-action" onClick={onManageWebhooks}>Administrar webhooks</button>
    </section>

    <section className="operation-section operation-diagnostics-summary" aria-labelledby="diagnostics-heading">
      <div className="operation-section-heading"><div><p>Diagnóstico</p><h3 id="diagnostics-heading">Estado actual: {healthLabel(overallStatus)}</h3><span>Los detalles técnicos siguen disponibles sin competir con el estado actual.</span></div><button type="button" className="connection-text-action" onClick={() => setIsDiagnosticsOpen(true)} disabled={!data}>Ver diagnóstico</button></div>
      {data?.summary.lastError ? <p className={`operation-last-error${hasHistoricalError ? ' is-historical' : ''}`}><CircleAlert size={16} aria-hidden="true" /><span><strong>{hasHistoricalError ? 'Último incidente' : 'Último error'}</strong>{data.summary.lastError}</span></p> : null}
    </section>

    {isDiagnosticsOpen ? <div className="activity-panel-backdrop" role="presentation" onMouseDown={() => setIsDiagnosticsOpen(false)}>
      <aside className="activity-panel diagnostics-panel" role="dialog" aria-modal="true" aria-label="Diagnóstico de conexión" onMouseDown={(event) => event.stopPropagation()}>
        <div className="activity-panel-heading"><div><h3>Detalle del diagnóstico</h3><p>Controles de disponibilidad y configuración.</p></div><button type="button" onClick={() => setIsDiagnosticsOpen(false)} aria-label="Cerrar diagnóstico"><X size={18} /></button></div>
        {data ? <ul className="diagnostics-checks">{data.checks.map((check) => <li key={check.code}><StatusIcon status={check.status} /><div><div><strong>{check.label}</strong><span className={`diagnostic-check-status diagnostic-check-status-${check.status}`}>{healthLabel(check.status)}</span></div><p>{check.message}</p><small>Verificado: {dateTime(check.lastVerifiedAt)}</small>{check.action ? <em>Acción sugerida: {check.action}</em> : null}</div></li>)}</ul> : null}
        <div className="diagnostic-panel-actions">
          {operationButton('availability', 'Verificar disponibilidad', Activity, () => void verifyAvailability(), 'diagnostic')}
          {operationButton('webhook-configuration', 'Verificar configuración', Webhook, () => void verifyWebhookConfiguration(), 'diagnostic')}
        </div>
      </aside>
    </div> : null}
  </section>
}
