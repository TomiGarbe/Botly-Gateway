import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Filter, Info, Link2, Search, ShieldAlert, TimerReset } from 'lucide-react'
import type { PipelineEvent } from '../types'
import { eventDescription, eventTitle, formatActivity, sanitizeUserText } from '../lib/connectionUx'

type Severity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL'
type DateFilter = 'all' | '24h' | '7d' | '30d'

const severityStyle: Record<Severity, string> = {
  INFO: 'border-blue-900/70 bg-blue-950/25 text-blue-300',
  SUCCESS: 'border-emerald-900/70 bg-emerald-950/25 text-emerald-300',
  WARNING: 'border-amber-900/70 bg-amber-950/25 text-amber-300',
  ERROR: 'border-red-900/70 bg-red-950/25 text-red-300',
  CRITICAL: 'border-red-700 bg-red-950/60 text-red-200',
}

function severityOf(event: PipelineEvent): Severity {
  if (event.severity) return event.severity
  const text = `${event.pipeline?.status || ''} ${event.event || ''} ${event.error?.message || ''}`.toLowerCase()
  if (text.includes('critical')) return 'CRITICAL'
  if (text.includes('error') || text.includes('failed') || text.includes('fail')) return 'ERROR'
  if (text.includes('warning') || text.includes('retry') || text.includes('ignored')) return 'WARNING'
  if (text.includes('ok') || text.includes('sent') || text.includes('completed') || text.includes('accepted')) return 'SUCCESS'
  return 'INFO'
}

function componentOf(event: PipelineEvent): string {
  if (event.component) return event.component
  const value = `${event.pipeline?.stage || ''} ${event.event || ''}`.toLowerCase()
  if (value.includes('meta') || value.includes('oauth') || value.includes('phone')) return 'Meta'
  if (value.includes('webhook') || value.includes('dispatch')) return 'Webhook'
  if (value.includes('send') || value.includes('message')) return 'Mensajería'
  return 'Gateway'
}

function correlationOf(event: PipelineEvent): string | undefined {
  return event.correlationId || event.pipeline?.requestId || event.meta?.requestId || event.pipeline?.conversationId || event.meta?.conversationId || event.pipeline?.messageId || event.message?.id || event.id
}

function duration(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const ms = Number(value)
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function EventRow({ event }: { event: PipelineEvent }) {
  const [open, setOpen] = useState(false)
  const [technical, setTechnical] = useState(false)
  const severity = severityOf(event)
  const correlation = correlationOf(event)
  const details = event.details || {}
  const error = event.error?.message || (typeof details.error === 'string' ? details.error : '')
  const payload = event.text || event.message?.text || event.content || details.payloadSummary
  const Icon = severity === 'SUCCESS' ? CheckCircle2 : severity === 'WARNING' ? AlertTriangle : severity === 'ERROR' || severity === 'CRITICAL' ? ShieldAlert : Info

  return <article className="border-b border-zinc-800 last:border-b-0">
    <button onClick={() => setOpen(value => !value)} className="flex w-full gap-3 px-3 py-3 text-left hover:bg-zinc-800/35 sm:px-4">
      <div className={`mt-0.5 rounded-md border p-1.5 ${severityStyle[severity]}`}><Icon size={14} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><p className="text-sm font-medium text-zinc-100">{eventTitle(event)}</p><span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${severityStyle[severity]}`}>{severity}</span></div>
        <p className="mt-1 text-xs text-zinc-400">{event.description || eventDescription(event)}</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500"><span>{formatActivity(event.timestamp)}</span><span>{componentOf(event)}</span>{event.durationMs !== undefined && event.durationMs !== null ? <span>{duration(event.durationMs)}</span> : null}{event.result || event.status || event.pipeline?.status ? <span>Resultado: {event.result || event.status || event.pipeline?.status}</span> : null}</div>
      </div>
      <ChevronDown size={16} className={`mt-1 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open ? <div className="mx-3 mb-3 ml-12 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs sm:ml-14 sm:mr-4">
      <div className="grid grid-cols-1 gap-2 text-zinc-400 sm:grid-cols-2">
        <p><span className="text-zinc-600">Timestamp:</span> {formatActivity(event.timestamp)}</p><p><span className="text-zinc-600">Componente:</span> {componentOf(event)}</p>
        <p><span className="text-zinc-600">Resultado:</span> {event.result || event.status || event.pipeline?.status || 'No disponible'}</p><p><span className="text-zinc-600">Duración:</span> {duration(event.durationMs)}</p>
        {correlation ? <p className="break-all sm:col-span-2"><span className="text-zinc-600">Correlation ID:</span> <span className="font-mono text-zinc-300">{correlation}</span></p> : null}
        {event.operator ? <p><span className="text-zinc-600">Operador:</span> {event.operator}</p> : null}
      </div>
      {payload ? <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/70 p-2.5"><p className="text-[10px] uppercase tracking-wide text-zinc-600">Payload resumido</p><p className="mt-1 break-words text-zinc-300">{sanitizeUserText(asText(payload)).slice(0, 600)}</p></div> : null}
      {error ? <div className="mt-3 rounded border border-red-900/70 bg-red-950/20 p-2.5 text-red-200"><p className="font-medium">Error</p><p className="mt-1 break-words">{sanitizeUserText(error)}</p></div> : null}
      {event.action ? <div className="mt-3 rounded border border-blue-900/70 bg-blue-950/20 p-2.5 text-blue-200"><p className="font-medium">Acción sugerida</p><p className="mt-1">{event.action}</p></div> : null}
      {Object.keys(details).length ? <button onClick={() => setTechnical(value => !value)} className="mt-3 text-blue-300 hover:text-blue-200">{technical ? 'Ocultar información técnica' : 'Ver información técnica'}</button> : null}
      {technical ? <pre className="mt-2 max-h-64 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-400">{JSON.stringify({ ids: event.pipeline, details }, null, 2)}</pre> : null}
    </div> : null}
  </article>
}

export default function ActivityCenter({ events, compact = false }: { events: PipelineEvent[]; compact?: boolean }) {
  const [date, setDate] = useState<DateFilter>('all')
  const [severity, setSeverity] = useState('all')
  const [component, setComponent] = useState('all')
  const [kind, setKind] = useState('all')
  const [result, setResult] = useState('all')
  const [operator, setOperator] = useState('all')
  const [onlyTests, setOnlyTests] = useState(false)
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [query, setQuery] = useState('')
  const [correlation, setCorrelation] = useState('')
  const ordered = useMemo(() => [...events].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)), [events])
  const components = useMemo(() => [...new Set(ordered.map(componentOf))], [ordered])
  const kinds = useMemo(() => [...new Set(ordered.map(event => event.event || event.pipeline?.stage).filter(Boolean) as string[])], [ordered])
  const operators = useMemo(() => [...new Set(ordered.map(event => event.operator).filter(Boolean) as string[])], [ordered])
  const correlations = useMemo(() => {
    const values = new Map<string, number>()
    ordered.forEach(event => { const value = correlationOf(event); if (value) values.set(value, (values.get(value) || 0) + 1) })
    return [...values.entries()].filter(([, count]) => count > 1).map(([id]) => id).slice(0, 100)
  }, [ordered])
  const filtered = useMemo(() => {
    const now = Date.now(); const minimum = date === '24h' ? now - 86400000 : date === '7d' ? now - 7 * 86400000 : date === '30d' ? now - 30 * 86400000 : 0
    const normalizedQuery = query.trim().toLowerCase()
    return ordered.filter(event => {
      const eventSeverity = severityOf(event); const eventComponent = componentOf(event); const eventKind = event.event || event.pipeline?.stage || ''
      const eventResult = String(event.result || event.status || event.pipeline?.status || '')
      const test = /test|smoke|round_trip|multimedia/i.test(`${eventKind} ${event.pipeline?.stage || ''}`)
      const searchable = `${eventTitle(event)} ${eventDescription(event)} ${eventComponent} ${eventKind} ${eventResult} ${event.operator || ''}`.toLowerCase()
      return (!minimum || Number(event.timestamp) >= minimum) && (severity === 'all' || eventSeverity === severity) && (component === 'all' || eventComponent === component) && (kind === 'all' || eventKind === kind) && (result === 'all' || eventResult === result) && (operator === 'all' || event.operator === operator) && (!onlyTests || test) && (!onlyErrors || eventSeverity === 'ERROR' || eventSeverity === 'CRITICAL') && (!correlation || correlationOf(event) === correlation) && (!normalizedQuery || searchable.includes(normalizedQuery))
    })
  }, [ordered, date, severity, component, kind, result, operator, onlyTests, onlyErrors, correlation, query])
  if (compact) return <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">{ordered.slice(0, 6).map(event => <EventRow key={`${event.id || event.timestamp}-${event.event}`} event={event} />)}{ordered.length === 0 ? <p className="p-4 text-sm text-zinc-500">No se registraron eventos para esta conexión.</p> : null}</div>
  return <section className="rounded-xl border border-zinc-800 bg-zinc-900">
    <div className="border-b border-zinc-800 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Clock3 size={17} className="text-blue-400" /><h3 className="font-semibold text-zinc-100">Centro de Actividad</h3></div><p className="mt-1 text-xs text-zinc-500">Timeline estructurada, correlación y detalle técnico por conexión.</p></div><span className="text-xs text-zinc-500">{filtered.length} de {ordered.length} eventos</span></div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"><label className="relative"><Search size={14} className="absolute left-2.5 top-2.5 text-zinc-600" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar actividad" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pl-8 pr-3 text-xs text-zinc-200" /></label><select value={date} onChange={event => setDate(event.target.value as DateFilter)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"><option value="all">Todas las fechas</option><option value="24h">Últimas 24 horas</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option></select><select value={severity} onChange={event => setSeverity(event.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"><option value="all">Toda severidad</option>{Object.keys(severityStyle).map(value => <option key={value}>{value}</option>)}</select><select value={component} onChange={event => setComponent(event.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"><option value="all">Todos los componentes</option>{components.map(value => <option key={value}>{value}</option>)}</select></div>
      <div className="mt-2 flex flex-wrap items-center gap-2"><Filter size={13} className="text-zinc-600" /><select value={kind} onChange={event => setKind(event.target.value)} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-400"><option value="all">Todos los tipos</option>{kinds.map(value => <option key={value}>{value}</option>)}</select><select value={result} onChange={event => setResult(event.target.value)} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-400"><option value="all">Todos los resultados</option>{[...new Set(ordered.map(event => String(event.result || event.status || event.pipeline?.status || '')).filter(Boolean))].map(value => <option key={value}>{value}</option>)}</select>{operators.length ? <select value={operator} onChange={event => setOperator(event.target.value)} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-400"><option value="all">Todos los operadores</option>{operators.map(value => <option key={value}>{value}</option>)}</select> : null}<button onClick={() => setOnlyTests(value => !value)} className={`rounded-md border px-2 py-1.5 text-xs ${onlyTests ? 'border-blue-700 bg-blue-950/30 text-blue-200' : 'border-zinc-800 text-zinc-400'}`}>Pruebas</button><button onClick={() => setOnlyErrors(value => !value)} className={`rounded-md border px-2 py-1.5 text-xs ${onlyErrors ? 'border-red-800 bg-red-950/30 text-red-200' : 'border-zinc-800 text-zinc-400'}`}>Errores</button>{correlations.length ? <span className="inline-flex items-center gap-1"><Link2 size={13} className="text-zinc-600" /><select value={correlation} onChange={event => setCorrelation(event.target.value)} className="max-w-48 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-400"><option value="">Todos los flujos</option>{correlations.map(value => <option key={value} value={value}>{value}</option>)}</select></span> : null}</div>
    </div>
    <div>{filtered.map(event => <EventRow key={`${event.id || event.timestamp}-${event.event}-${event.pipeline?.stage || ''}`} event={event} />)}{filtered.length === 0 ? <div className="p-8 text-center text-sm text-zinc-500"><TimerReset className="mx-auto mb-2 text-zinc-700" size={20} />No hay actividad con estos filtros.</div> : null}</div>
  </section>
}
