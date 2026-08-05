import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Link2,
  MessageCircle,
  Radio,
  RotateCcw,
  Send,
  Users,
  Webhook,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DashboardActivity, DashboardOverallState, DashboardSnapshot } from '../api/dashboardApi'
import { getDashboard } from '../api/dashboardApi'

function eventTime(value: number): string {
  if (!value) return 'Hace un momento'
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function overallIcon(state: DashboardOverallState) {
  if (state === 'critical') return <CircleX aria-hidden="true" />
  if (state === 'attention') return <CircleAlert aria-hidden="true" />
  return <CheckCircle2 aria-hidden="true" />
}

function activityIcon(activity: DashboardActivity) {
  if (activity.kind === 'client_created') return <Users aria-hidden="true" />
  if (activity.kind === 'connection_created') return <Link2 aria-hidden="true" />
  if (activity.kind === 'message_sent') return <Send aria-hidden="true" />
  if (activity.kind === 'message_received') return <MessageCircle aria-hidden="true" />
  if (activity.kind === 'webhook') return <Webhook aria-hidden="true" />
  if (activity.kind === 'reconnect') return <RotateCcw aria-hidden="true" />
  if (activity.kind === 'error') return <AlertTriangle aria-hidden="true" />
  return <Radio aria-hidden="true" />
}

const metricDefinitions = [
  { key: 'clients', label: 'Clientes', icon: Users },
  { key: 'connections', label: 'Conexiones', icon: Link2 },
  { key: 'connected', label: 'Conectadas', icon: Activity },
  { key: 'activeAlerts', label: 'Alertas activas', icon: AlertTriangle },
] as const

export function DashboardPage() {
  const navigate = useNavigate()
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDashboard = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      setDashboard(await getDashboard())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el estado del Gateway.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadDashboard() }, [loadDashboard])

  if (isLoading) return <p className="clients-state">Cargando estado del Gateway…</p>
  if (error || !dashboard) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'No se pudo cargar el estado del Gateway.'}</p><button type="button" onClick={() => void loadDashboard()}>Reintentar</button></div>

  return (
    <section className="dashboard-page">
      <div className="dashboard-heading">
        <div>
          <p>Gateway</p>
          <h2>Estado operativo</h2>
        </div>
        <div className={`dashboard-overall dashboard-overall-${dashboard.overall.state}`} role="status">
          {overallIcon(dashboard.overall.state)}
          <span>{dashboard.overall.label}</span>
        </div>
      </div>

      <div className="dashboard-metrics" aria-label="Resumen del Gateway">
        {metricDefinitions.map(({ key, label, icon: Icon }) => (
          <article key={key} className="dashboard-metric">
            <Icon size={17} aria-hidden="true" />
            <span>{label}</span>
            <strong>{dashboard.metrics[key]}</strong>
          </article>
        ))}
      </div>

      <section className="dashboard-section" aria-labelledby="recent-activity-title">
        <div className="dashboard-section-heading">
          <div>
            <h3 id="recent-activity-title">Actividad reciente</h3>
            <p>Los últimos eventos importantes del Gateway.</p>
          </div>
        </div>
        {dashboard.recentActivity.length === 0 ? <p className="dashboard-empty">Todavía no hay actividad registrada.</p> : <ul className="dashboard-activity-list">
          {dashboard.recentActivity.map((activity) => <li key={activity.id}>
            <span className={`dashboard-activity-icon is-${activity.severity}`}>{activityIcon(activity)}</span>
            <div>
              <strong>{activity.description}</strong>
              <span>{activity.client?.name || 'Gateway'}{activity.connection ? ` · ${activity.connection.name}` : ''}</span>
            </div>
            <time dateTime={activity.occurredAt ? new Date(activity.occurredAt).toISOString() : undefined}>{eventTime(activity.occurredAt)}</time>
            {activity.connection ? <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${activity.connection?.id}`)}>Ver conexión</button> : null}
          </li>)}
        </ul>}
      </section>

      <section className="dashboard-section" aria-labelledby="attention-title">
        <div className="dashboard-section-heading">
          <div>
            <h3 id="attention-title">Conexiones que requieren atención</h3>
            <p>Solo se muestran conexiones con un problema real.</p>
          </div>
        </div>
        {dashboard.attention.length === 0 ? <p className="dashboard-all-clear"><CheckCircle2 size={17} aria-hidden="true" /> Todas las conexiones funcionan correctamente.</p> : <ul className="dashboard-attention-list">
          {dashboard.attention.map((item) => <li key={item.connection.id}>
            <span className={`dashboard-attention-status is-${item.severity}`}>{item.status}</span>
            <div>
              <strong>{item.connection.name}</strong>
              <span>{item.client.name}</span>
            </div>
            <button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${item.connection.id}`)}>Abrir Workspace</button>
          </li>)}
        </ul>}
      </section>
    </section>
  )
}
