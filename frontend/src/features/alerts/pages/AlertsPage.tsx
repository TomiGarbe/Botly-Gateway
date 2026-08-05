import { AlertTriangle, CheckCircle2, CircleX, Info, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AlertSeverity, GatewayAlert } from '../api/alertsApi'
import { acknowledgeAlert, listAlerts, resolveAlert } from '../api/alertsApi'

function dateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Hace un momento' : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function severityIcon(severity: AlertSeverity) {
  if (severity === 'critical') return <CircleX aria-hidden="true" />
  if (severity === 'warning') return <AlertTriangle aria-hidden="true" />
  return <Info aria-hidden="true" />
}

function severityLabel(severity: AlertSeverity): string {
  return { critical: 'Crítica', warning: 'Advertencia', info: 'Información' }[severity]
}

function statusLabel(status: GatewayAlert['status']): string {
  return { new: 'Nueva', acknowledged: 'Reconocida', resolved: 'Resuelta' }[status]
}

export function AlertsPage() {
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState<GatewayAlert[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const loadAlerts = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      setAlerts(await listAlerts())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudieron cargar las alertas.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  async function updateAlert(alert: GatewayAlert, action: 'acknowledge' | 'resolve') {
    setUpdatingId(alert.id)
    setError(null)
    try {
      const updated = action === 'acknowledge' ? await acknowledgeAlert(alert.id) : await resolveAlert(alert.id)
      setAlerts((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la alerta.')
    } finally {
      setUpdatingId(null)
    }
  }

  if (isLoading) return <p className="clients-state">Cargando alertas…</p>
  if (error && alerts.length === 0) return <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadAlerts()}>Reintentar</button></div>

  return (
    <section className="alerts-page">
      <div className="alerts-heading">
        <div>
          <p>Alertas</p>
          <h2>Incidentes que requieren atención</h2>
        </div>
      </div>
      {error ? <p className="client-form-error" role="alert">{error}</p> : null}
      {alerts.length === 0 ? <div className="alerts-empty"><CheckCircle2 size={20} aria-hidden="true" /><div><strong>Todo funciona correctamente.</strong><span>No hay incidentes operativos pendientes.</span></div></div> : <div className="alerts-list">
        {alerts.map((alert) => <article key={alert.id} className={`alert-card is-${alert.severity}${alert.status === 'resolved' ? ' is-resolved' : ''}`}>
          <span className={`alert-card-icon is-${alert.severity}`}>{severityIcon(alert.severity)}</span>
          <div className="alert-card-content">
            <div className="alert-card-title"><h3>{alert.title}</h3><span className={`alert-severity is-${alert.severity}`}>{severityLabel(alert.severity)}</span></div>
            <p>{alert.description}</p>
            <div className="alert-card-meta"><span>{alert.client.name}</span><span>{alert.connection.name}</span><time dateTime={alert.createdAt}>{dateTime(alert.createdAt)}</time><span>{statusLabel(alert.status)}</span></div>
            <div className="alert-card-actions">
              {alert.status === 'new' ? <button type="button" className="client-button-secondary" disabled={updatingId === alert.id} onClick={() => void updateAlert(alert, 'acknowledge')}>{updatingId === alert.id ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : null} Reconocer</button> : null}
              {alert.status !== 'resolved' ? <button type="button" className="client-button-secondary" disabled={updatingId === alert.id} onClick={() => void updateAlert(alert, 'resolve')}>Resolver</button> : null}
              <button type="button" className="client-button-primary" onClick={() => navigate(alert.workspaceUrl)}>Abrir Workspace</button>
            </div>
          </div>
        </article>)}
      </div>}
    </section>
  )
}
