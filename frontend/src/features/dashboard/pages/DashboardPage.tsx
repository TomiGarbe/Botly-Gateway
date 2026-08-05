import { Activity, AlertTriangle, CheckCircle2, CircleAlert, CircleX, Link2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'
import type { DashboardOverallState, DashboardSnapshot } from '../api/dashboardApi'
import { getDashboard } from '../api/dashboardApi'

function overallIcon(state: DashboardOverallState) {
  if (state === 'critical') return <CircleX aria-hidden="true" />
  if (state === 'attention') return <CircleAlert aria-hidden="true" />
  return <CheckCircle2 aria-hidden="true" />
}

function overallLabel(state: DashboardOverallState): string { return { healthy: 'Operativa', attention: 'Atención requerida', critical: 'Problema crítico' }[state] }
function overallTone(state: DashboardOverallState): StatusTone { return ({ healthy: 'healthy', attention: 'attention', critical: 'critical' } as const)[state] }
function attentionLabel(severity: 'warning' | 'critical'): string { return severity === 'critical' ? 'Problema crítico' : 'Atención requerida' }
function attentionTone(severity: 'warning' | 'critical'): StatusTone { return severity === 'critical' ? 'critical' : 'attention' }

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
    setError(null); setIsLoading(true)
    try { setDashboard(await getDashboard()) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo cargar el estado del Gateway.') } finally { setIsLoading(false) }
  }, [])

  useEffect(() => { void loadDashboard() }, [loadDashboard])

  if (isLoading) return <LoadingState label="Cargando estado del Gateway…" />
  if (error || !dashboard) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'No se pudo cargar el estado del Gateway.'}</p><button type="button" onClick={() => void loadDashboard()}>Reintentar</button></div>

  return <section className="dashboard-page">
    <div className="dashboard-heading"><div><p>Resumen</p><h2>Estado del Gateway</h2></div><div className="dashboard-overall" role="status">{overallIcon(dashboard.overall.state)}<StatusBadge tone={overallTone(dashboard.overall.state)}>{overallLabel(dashboard.overall.state)}</StatusBadge></div></div>
    <div className="dashboard-metrics" aria-label="Resumen del Gateway">{metricDefinitions.map(({ key, label, icon: Icon }) => <article key={key} className="dashboard-metric"><Icon size={17} aria-hidden="true" /><span>{label}</span><strong>{dashboard.metrics[key]}</strong></article>)}</div>
    <section className="dashboard-section" aria-labelledby="attention-title">
      <div className="dashboard-section-heading"><div><h3 id="attention-title">Conexiones que requieren atención</h3><p>Solo se muestran conexiones con un problema real.</p></div></div>
      {dashboard.attention.length === 0 ? <EmptyState icon={CheckCircle2} tone="success" title="Todas las conexiones funcionan correctamente." description="No hay conexiones que requieran atención en este momento." /> : <ul className="dashboard-attention-list">{dashboard.attention.map((item) => <li key={item.connection.id}><StatusBadge tone={attentionTone(item.severity)}>{attentionLabel(item.severity)}</StatusBadge><div className="dashboard-attention-copy"><span>Cliente</span><strong>{item.client.name}</strong><span>Conexión</span><b>{item.connection.name}</b><p>{item.status}</p></div><button type="button" className="client-button-secondary" onClick={() => navigate(`/connections/${item.connection.id}`)}>Abrir Workspace</button></li>)}</ul>}
    </section>
  </section>
}
