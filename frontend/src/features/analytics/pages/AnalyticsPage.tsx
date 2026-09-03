import { Activity, AlertTriangle, CheckCircle2, Clock3, RefreshCw, Webhook } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
import { Input, Select } from '@/shared/components/FormControls'
import { getAnalytics, type AnalyticsGranularity, type AnalyticsPreset, type AnalyticsSnapshot } from '../api/analyticsApi'

function metric(value: number | null, suffix = ''): string { return value === null ? '—' : `${value}${suffix}` }
function percentage(value: number | null): string { return value === null ? '—' : `${Math.round(value * 100)}%` }
function local(value: string): string { return new Date(value).toLocaleString() }
function isoFromLocal(value: string): string | undefined { const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString() }

export function AnalyticsPage() {
  const [preset, setPreset] = useState<AnalyticsPreset>('24h')
  const [granularity, setGranularity] = useState<AnalyticsGranularity>('hour')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (preset === 'custom' && (!isoFromLocal(dateFrom) || !isoFromLocal(dateTo))) { setError('Elegí ambas fechas para el rango personalizado.'); return }
    setIsLoading(true); setError(null)
    try { setSnapshot(await getAnalytics({ preset, granularity, dateFrom: isoFromLocal(dateFrom), dateTo: isoFromLocal(dateTo) })) }
    catch { setError('No se pudieron cargar las métricas. Intentá actualizar nuevamente.') }
    finally { setIsLoading(false) }
  }, [preset, granularity, dateFrom, dateTo])

  useEffect(() => { void load() }, [load])
  const maximum = useMemo(() => Math.max(1, ...(snapshot?.timeseries.map((point) => Math.max(point.messages, point.providerFailures, point.providerUnknown, point.webhookFailures)) || [1])), [snapshot])
  if (isLoading && !snapshot) return <LoadingState label="Calculando métricas de observabilidad..." />
  const summary = snapshot?.summary
  const noData = Boolean(snapshot && summary && summary.providerDeliveries === 0 && summary.webhookDeliveries === 0)

  return <section className="analytics-page">
    <div className="webhooks-heading"><div><p>Observabilidad</p><h2>Analytics operativo</h2><span>{snapshot ? `${local(snapshot.range.fromUtc)} — ${local(snapshot.range.toUtc)} · UTC en backend` : 'Datos derivados de deliveries, attempts y acciones existentes.'}</span></div><button type="button" className="client-button-secondary" onClick={() => void load()} disabled={isLoading}><RefreshCw size={15} /> {isLoading ? 'Actualizando...' : 'Actualizar'}</button></div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <div className="analytics-filters"><label>Período<Select value={preset} onChange={(event) => setPreset(event.target.value as AnalyticsPreset)}><option value="today">Hoy</option><option value="24h">Últimas 24 horas</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option><option value="custom">Personalizado</option></Select></label>{preset === 'custom' ? <><label>Desde<Input type="datetime-local" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Hasta<Input type="datetime-local" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></> : null}<label>Serie<Select value={granularity} onChange={(event) => setGranularity(event.target.value as AnalyticsGranularity)}><option value="hour">Por hora</option><option value="day">Por día</option></Select></label></div>
    {noData ? <EmptyState icon={Activity} title="No hay datos para este período." description="Cuando existan deliveries o attempts en el rango elegido, aparecerán aquí." /> : null}
    {snapshot && !noData ? <>
      <div className="analytics-cards">
        <Metric label="Mensajes" value={summary!.totalMessages} detail={`${summary!.inboundMessages} inbound · ${summary!.outboundMessages} outbound`} icon={<Activity size={18} />} />
        <Metric label="Éxito técnico" value={summary!.providerTechnicalSuccess} detail="Provider deliveries" icon={<CheckCircle2 size={18} />} tone="success" />
        <Metric label="Fallos provider" value={summary!.providerFailures} detail="Technical failed" icon={<AlertTriangle size={18} />} tone="error" />
        <Metric label="Unknown" value={summary!.providerUnknown} detail="No se mezcla con fallos" icon={<Clock3 size={18} />} tone="warning" />
        <Metric label="Pendientes de reconciliación" value={summary!.pendingReconciliation} detail={`${snapshot.attempts.reconciled} reconciliados en el rango`} icon={<Clock3 size={18} />} tone={summary!.pendingReconciliation ? 'warning' : undefined} />
        <Metric label="Webhook deliveries" value={summary!.webhookDeliveries} detail={`${summary!.webhookFailures} con error`} icon={<Webhook size={18} />} tone={summary!.webhookFailures ? 'error' : undefined} />
      </div>
      <section className="analytics-section"><h3>Rendimiento por provider</h3><div className="analytics-table-wrap"><table><thead><tr><th>Provider</th><th>Mensajes</th><th>Éxito técnico</th><th>Fallos</th><th>Unknown</th><th>Latencia promedio</th><th>p95</th></tr></thead><tbody>{snapshot.providers.map((provider) => <tr key={provider.provider}><td>{provider.provider}</td><td>{provider.messages}<small>{provider.inbound} in · {provider.outbound} out · {provider.statusEvents} status</small></td><td>{percentage(provider.technicalSuccessRate)}</td><td>{provider.technical.failed}</td><td>{provider.technical.unknown}</td><td>{metric(provider.latency.averageMs, ' ms')}</td><td>{metric(provider.latency.p95Ms, ' ms')}</td></tr>)}</tbody></table></div></section>
      <div className="analytics-grid"><section className="analytics-section"><h3>Webhooks</h3><dl className="analytics-definition"><div><dt>Entregas</dt><dd>{snapshot.webhooks.totalDeliveries}</dd></div><div><dt>Éxito técnico</dt><dd>{percentage(snapshot.webhooks.technicalSuccessRate)}</dd></div><div><dt>Timeout</dt><dd>{snapshot.webhooks.technical.timeout}</dd></div><div><dt>Test / reales</dt><dd>{snapshot.webhooks.testDeliveries} / {snapshot.webhooks.realDeliveries}</dd></div><div><dt>Latencia / p95</dt><dd>{metric(snapshot.webhooks.latency.averageMs, ' ms')} / {metric(snapshot.webhooks.latency.p95Ms, ' ms')}</dd></div><div><dt>Retries</dt><dd>{snapshot.webhooks.retries}</dd></div></dl></section><section className="analytics-section"><h3>Resend manual</h3><dl className="analytics-definition"><div><dt>Acciones resend</dt><dd>{snapshot.manualActions.resendTotal}</dd></div><div><dt>Completados</dt><dd>{snapshot.manualActions.resendCompleted}</dd></div><div><dt>Fallidos</dt><dd>{snapshot.manualActions.resendFailed}</dd></div><div><dt>Bloqueados</dt><dd>{snapshot.manualActions.resendBlocked}</dd></div><div><dt>Attempts</dt><dd>{snapshot.attempts.totalAttempts}</dd></div><div><dt>Still unknown</dt><dd>{snapshot.attempts.stillUnknown}</dd></div></dl></section></div>
      <section className="analytics-section"><h3>Serie temporal</h3><p>Mensajes, fallos provider, unknown y fallos webhook. Agrupación UTC; las etiquetas se muestran en tu zona local.</p>{snapshot.timeseries.length ? <div className="analytics-series">{snapshot.timeseries.map((point) => <div key={point.bucketStartUtc} className="analytics-series-item" title={local(point.bucketStartUtc)}><div className="analytics-bars"><span className="is-messages" style={{ height: `${(point.messages / maximum) * 100}%` }} /><span className="is-failures" style={{ height: `${(point.providerFailures / maximum) * 100}%` }} /><span className="is-unknown" style={{ height: `${(point.providerUnknown / maximum) * 100}%` }} /><span className="is-webhooks" style={{ height: `${(point.webhookFailures / maximum) * 100}%` }} /></div><small>{new Date(point.bucketStartUtc).toLocaleDateString()}</small></div>)}</div> : <p>No hay datos para este período.</p>}</section>
      <section className="analytics-section"><h3>Problemas principales por conexión</h3><div className="analytics-table-wrap"><table><thead><tr><th>Conexión</th><th>Provider</th><th>Mensajes</th><th>Fallidos</th><th>Unknown</th><th>Pendientes</th><th>Fallos webhook</th></tr></thead><tbody>{snapshot.connections.map((connection) => <tr key={connection.connectionId}><td>{connection.connectionName}</td><td>{connection.provider || '—'}</td><td>{connection.messages}</td><td>{connection.failedDeliveries}</td><td>{connection.unknownDeliveries}</td><td>{connection.pendingReconciliation}</td><td>{connection.webhookFailures}</td></tr>)}</tbody></table></div></section>
    </> : null}
  </section>
}

function Metric({ label, value, detail, icon, tone }: { label: string; value: number; detail: string; icon: ReactNode; tone?: 'success' | 'error' | 'warning' }) { return <article className={`analytics-card${tone ? ` is-${tone}` : ''}`}><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>{icon}</article> }
