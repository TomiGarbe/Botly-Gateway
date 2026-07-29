import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  Activity, AlertTriangle, ArrowLeft, BadgeCheck, Check, CheckCircle2, Clipboard,
  Cloud, Copy, ExternalLink, Eye, EyeOff, HeartPulse, KeyRound, ListChecks,
  Loader2, Radio, RefreshCcw, Send, Settings2, ShieldCheck,
  Smartphone, TerminalSquare, Unplug,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import ActivityCenter from './ActivityCenter'
import type { GatewayConfig } from '../lib/config'
import type { ConnectionDiagnostic, HealthCheck, Instance, MetaOnboardingStatus, OperationJob, OperationalAlert, OperationalAutomation, PipelineEvent, Toast } from '../types'
import { connectionIconTone, connectionTypeLabel, diagnosticText, healthLabel, isOfficialConnection, statusLabel, statusTone } from '../lib/connectionUx'

type WorkspaceTab = 'summary' | 'activity' | 'tests' | 'webhooks' | 'diagnostics' | 'settings'
type ComponentState = 'healthy' | 'attention' | 'pending'

interface Props {
  config: GatewayConfig
  instance: Instance
  onBack: () => void
  onToast: (message: string, type?: Toast['type']) => void
  onRefresh: () => void
  onQR: (name: string) => void
  onReconnect: (name: string) => void
  onApiKey: (name: string) => void
  onDelete: (name: string) => void
  onOpenMessages: () => void
  onOpenTests: () => void
  onOpenWebhooks: () => void
  alerts?: OperationalAlert[]
  onOpenAlerts?: () => void
  automations?: OperationalAutomation[]
  onOpenAutomations?: () => void
  onExecuteAutomation?: (automationId: string) => void
  operations?: OperationJob[]
  onOpenOperations?: () => void
  qrEnabled: boolean
  initialTab?: WorkspaceTab
}

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'summary', label: 'Resumen' },
  { id: 'activity', label: 'Actividad' },
  { id: 'tests', label: 'Pruebas' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'diagnostics', label: 'Diagnóstico' },
  { id: 'settings', label: 'Configuración' },
]

const PROVISIONING_STEPS: Array<{ key: string; label: string; backendKey?: keyof NonNullable<MetaOnboardingStatus['steps']> }> = [
  { key: 'oauth', label: 'OAuth', backendKey: 'oauth' },
  { key: 'token', label: 'Token', backendKey: 'token' },
  { key: 'discovery', label: 'Discovery', backendKey: 'discovery' },
  { key: 'subscription', label: 'Subscription', backendKey: 'subscription' },
  { key: 'phone_registration', label: 'Phone Registration', backendKey: 'phone' },
  { key: 'phone_verification', label: 'Phone Verification', backendKey: 'phone' },
  { key: 'webhook', label: 'Webhook', backendKey: 'webhook' },
  { key: 'evolution', label: 'Evolution', backendKey: 'evolution' },
  { key: 'credentials', label: 'Credentials', backendKey: 'credentials' },
  { key: 'ready', label: 'Ready' },
]

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function relativeTime(value?: string | number | null): string {
  if (!value) return 'Sin registro'
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'Sin registro'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'hace menos de un minuto'
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`
  return `hace ${Math.floor(seconds / 86400)} d`
}

function componentTone(state: ComponentState): string {
  if (state === 'healthy') return 'border-emerald-900/70 bg-emerald-950/20 text-emerald-300'
  if (state === 'attention') return 'border-amber-900/70 bg-amber-950/20 text-amber-300'
  return 'border-zinc-700 bg-zinc-950/50 text-zinc-400'
}

function componentLabel(state: ComponentState): string {
  return state === 'healthy' ? 'Operativo' : state === 'attention' ? 'Revisar' : 'Sin confirmar'
}

function Section({ title, description, icon: Icon, children, action }: { title: string; description?: string; icon: typeof Activity; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-zinc-400"><Icon size={16} /></div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
            {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function HealthItem({ label, state, lastChange, detail }: { label: string; state: ComponentState; lastChange?: string | number | null; detail: string }) {
  return (
    <div className={`rounded-lg border p-3 ${componentTone(state)}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-100">{label}</p>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium"><span className="h-1.5 w-1.5 rounded-full bg-current" />{componentLabel(state)}</span>
      </div>
      <p className="mt-2 text-xs text-zinc-400">{detail}</p>
      <p className="mt-2 text-[11px] text-zinc-500">Último cambio: {relativeTime(lastChange)}</p>
    </div>
  )
}

function ProblemRow({ item }: { item: ConnectionDiagnostic }) {
  const text = diagnosticText(item)
  return (
    <div className={`rounded-lg border px-3 py-3 text-sm ${text.tone}`}>
      <p className="font-medium">{text.title}</p>
      <p className="mt-1 text-xs text-zinc-300">{text.action}</p>
    </div>
  )
}

function StepState({ state }: { state: 'complete' | 'current' | 'pending' | 'error' }) {
  if (state === 'complete') return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-zinc-950" aria-label="Completada"><Check size={13} strokeWidth={3} /></span>
  if (state === 'error') return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white" aria-label="Error"><AlertTriangle size={12} /></span>
  if (state === 'current') return <span className="h-5 w-5 animate-pulse rounded-full border-2 border-blue-400" aria-label="En curso" />
  return <span className="h-5 w-5 rounded-full border border-zinc-600" aria-label="Pendiente" />
}

export default function ConnectionDetails({ config, instance, onBack, onToast, onRefresh, onQR, onReconnect, onApiKey, onDelete, onOpenMessages, onOpenTests, onOpenWebhooks, alerts = [], onOpenAlerts, automations = [], onOpenAutomations, onExecuteAutomation, operations = [], onOpenOperations, qrEnabled, initialTab = 'summary' }: Props) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('summary')
  const activeAlerts = useMemo(() => alerts.filter(alert => alert.connection === instance.name && ['new', 'acknowledged', 'in_progress'].includes(alert.status)), [alerts, instance.name])
  const connectionAutomations = useMemo(() => automations.filter(automation => automation.connection === instance.name), [automations, instance.name])
  const connectionOperations = useMemo(() => operations.filter(operation => operation.targets.includes(instance.name)), [operations, instance.name])
  const [adminMode, setAdminMode] = useState(false)
  const [copyKey, setCopyKey] = useState('')
  const official = isOfficialConnection(instance)
  const tone = statusTone(instance)
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl || config.url)
  const callbackUrl = `${publicBaseUrl}/webhooks/${official ? 'meta' : 'evolution'}`
  const sendUrl = `${publicBaseUrl}/messages/${instance.name}`

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab, instance.name])

  const { data: diagnosticsData, isLoading: diagnosticsLoading } = useSWR(
    config.apiKey ? ['connection-diagnostics', config.url, instance.name] : null,
    () => api.instances.diagnostics(config, instance.name),
    { refreshInterval: 20000, revalidateOnFocus: true }
  )
  const { data: activityData } = useSWR(
    config.apiKey ? ['connection-activity', config.url, instance.name] : null,
    () => api.webhooks.events<PipelineEvent>(config, instance.name, 500),
    { refreshInterval: 20000, revalidateOnFocus: true }
  )
  const { data: deliveryData } = useSWR(
    config.apiKey ? ['connection-deliveries', config.url, instance.name] : null,
    () => api.webhooks.deliveries(config, instance.name, 50),
    { refreshInterval: 30000, revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const { data: apiKeyInfo } = useSWR(
    config.apiKey ? ['connection-key', config.url, instance.name] : null,
    () => api.instances.getApiKey(config, instance.name),
    { refreshInterval: 30000, revalidateOnFocus: false }
  )
  const { data: onboarding, error: onboardingError, isLoading: onboardingLoading } = useSWR(
    official && config.apiKey ? ['connection-onboarding', config.url, instance.name] : null,
    () => api.metaSignup.status(config, instance.name),
    { refreshInterval: 20000, revalidateOnFocus: true, shouldRetryOnError: false }
  )

  const activity = useMemo(() => {
    const items = Array.isArray(activityData?.items) ? activityData.items : []
    return [...items].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
  }, [activityData])
  const supportDiagnostics = diagnosticsData?.supportDiagnostics || []
  const visibleDiagnostics = [...(diagnosticsData?.diagnostics || instance.diagnostics || []), ...supportDiagnostics].filter(item => item.severity !== 'info')
  const healthChecks = diagnosticsData?.healthChecks || instance.healthChecks || []
  const hasInbound = activity.some(item => item.direction === 'inbound')
  const hasOutbound = activity.some(item => item.direction === 'outbound' || item.fromMe)
  const latestEvent = activity[0]
  const latestInbound = activity.find(item => item.direction === 'inbound')
  const latestOutbound = activity.find(item => item.direction === 'outbound' || item.fromMe)
  const latestWebhook = activity.find(item => /webhook|dispatch|ingest/i.test(`${item.event} ${item.pipeline?.stage || ''}`))
  const latestError = activity.find(item => item.severity === 'ERROR' || item.severity === 'CRITICAL' || /failed|error|fail/i.test(`${item.event} ${item.pipeline?.status || ''}`))
  const latestTest = activity.find(item => /smoke|test/i.test(`${item.event} ${item.pipeline?.stage || ''}`))
  const webhookCheck = healthChecks.find(item => item.code.includes('webhook'))
  const credentialsCheck = healthChecks.find(item => item.code.includes('token') || item.code.includes('credential'))
  const hasErrors = visibleDiagnostics.some(item => item.severity === 'error')
  const environment = /localhost|127\.0\.0\.1/i.test(publicBaseUrl) ? 'Desarrollo' : 'Producción'

  const copyText = async (value: string, key: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyKey(key)
      onToast(label, 'success')
      window.setTimeout(() => setCopyKey(current => current === key ? '' : current), 1400)
    } catch {
      onToast('No se pudo copiar', 'error')
    }
  }

  const runReconnect = () => {
    try {
      onReconnect(instance.name)
      onRefresh()
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : 'No se pudo reconectar', 'error')
    }
  }

  const healthItems = [
    { label: 'Meta', state: official ? (onboarding?.status === 'READY' ? 'healthy' : onboardingError ? 'attention' : 'pending') : 'pending', lastChange: onboarding?.updatedAt, detail: official ? (onboarding?.status === 'READY' ? 'Onboarding oficial confirmado.' : onboarding?.blockingStage ? `Bloqueado en ${onboarding.blockingStage}.` : 'Esperando confirmación del onboarding.') : 'No aplica a esta conexión.' },
    { label: 'Gateway', state: instance.status === 'open' ? 'healthy' : 'attention', lastChange: latestEvent?.timestamp || instance.lastSeen, detail: instance.status === 'open' ? 'La conexión está disponible en Gateway.' : 'Gateway informa que la conexión no está abierta.' },
    { label: 'Evolution', state: instance.status === 'open' ? 'healthy' : 'pending', lastChange: latestEvent?.timestamp, detail: official ? 'Instancia Cloud aprovisionada por Evolution.' : 'Transporte Evolution para WhatsApp Web.' },
    { label: 'Webhook', state: onboarding?.steps?.webhook ? 'healthy' : webhookCheck?.status === 'failed' ? 'attention' : 'pending', lastChange: onboarding?.updatedAt || latestInbound?.timestamp, detail: onboarding?.steps?.webhook ? 'Callback confirmado para esta WABA.' : webhookCheck?.details || 'Sin confirmación reciente de recepción.' },
    { label: 'Credenciales', state: onboarding?.steps?.credentials || credentialsCheck?.status === 'passed' ? 'healthy' : credentialsCheck?.status === 'failed' ? 'attention' : 'pending', lastChange: onboarding?.updatedAt || apiKeyInfo?.createdAt, detail: onboarding?.steps?.credentials ? 'Credenciales oficiales persistidas.' : credentialsCheck?.details || 'Sin confirmación de credenciales.' },
    { label: 'Recepción', state: hasInbound ? 'healthy' : instance.status === 'open' ? 'pending' : 'attention', lastChange: latestInbound?.timestamp, detail: hasInbound ? 'Hay mensajes entrantes procesados.' : 'No hay eventos entrantes registrados.' },
    { label: 'Envío', state: hasOutbound ? 'healthy' : instance.status === 'open' ? 'pending' : 'attention', lastChange: latestOutbound?.timestamp, detail: hasOutbound ? 'Hay mensajes salientes registrados.' : 'Todavía no se registró un envío.' },
    { label: 'Sincronización', state: latestEvent ? (hasErrors ? 'attention' : 'healthy') : 'pending', lastChange: latestEvent?.timestamp, detail: latestEvent ? 'Actividad reciente disponible en la línea de tiempo.' : 'No hay actividad para sincronizar.' },
  ] as Array<{ label: string; state: ComponentState; lastChange?: string | number | null; detail: string }>

  const insights = useMemo(() => {
    const entries: Array<{ title: string; detail: string; tone: ComponentState }> = []
    const latest = Number(latestEvent?.timestamp || 0)
    if (!latest || Date.now() - latest > 7 * 86400000) entries.push({ title: 'Sin actividad reciente', detail: 'No hay eventos en los últimos siete días.', tone: 'attention' })
    if (!activity.some(event => Boolean(event.media))) entries.push({ title: 'Sin multimedia', detail: 'Todavía no se registraron mensajes con archivos o imágenes.', tone: 'pending' })
    if (!hasInbound) entries.push({ title: 'Recepción sin eventos', detail: 'Conviene confirmar el callback con un mensaje entrante.', tone: 'pending' })
    const retries = activity.filter(event => Number(event.details?.retriesUsed || event.details?.retryCount || 0) > 0).length
    if (retries > 0) entries.push({ title: 'Reintentos detectados', detail: `${retries} eventos recientes registran reintentos de entrega.`, tone: 'attention' })
    if (hasErrors) entries.push({ title: 'Diagnóstico pendiente', detail: 'Hay advertencias o errores que requieren revisión.', tone: 'attention' })
    if (entries.length === 0) entries.push({ title: 'Operación estable', detail: 'No se detectaron recomendaciones automáticas con la actividad disponible.', tone: 'healthy' })
    return entries.slice(0, 4)
  }, [activity, hasErrors, hasInbound, latestEvent])

  const provisioningState = (step: typeof PROVISIONING_STEPS[number], index: number): 'complete' | 'current' | 'pending' | 'error' => {
    const hasError = Boolean(onboarding?.errors?.length)
    const complete = step.key === 'ready' ? onboarding?.status === 'READY' : Boolean(step.backendKey && onboarding?.steps?.[step.backendKey])
    if (complete) return 'complete'
    const completedCount = PROVISIONING_STEPS.filter(candidate => candidate.key === 'ready' ? onboarding?.status === 'READY' : Boolean(candidate.backendKey && onboarding?.steps?.[candidate.backendKey])).length
    if (hasError && index === completedCount) return 'error'
    if (!hasError && onboarding && index === completedCount) return 'current'
    return 'pending'
  }

  const renderHealth = () => (
    <Section title="Health" description="Estado operativo por componente; cada indicador incluye su última señal." icon={HeartPulse}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {healthItems.map(item => <HealthItem key={item.label} {...item} />)}
      </div>
    </Section>
  )

  const renderProvisioning = () => (
    <Section title="Provisioning" description={official ? 'Estado real informado por el Meta Onboarding Engine.' : 'La conexión Web no utiliza el onboarding oficial de Meta.'} icon={ListChecks} action={onboardingLoading ? <Loader2 size={15} className="animate-spin text-zinc-500" /> : null}>
      {!official ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-500">Esta conexión se aprovisiona mediante QR/Evolution. No tiene etapas de Embedded Signup.</p>
      ) : onboardingError ? (
        <div className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-3 text-sm text-amber-300">No hay estado de onboarding disponible todavía. Completa Embedded Signup o vuelve a actualizar la conexión.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {PROVISIONING_STEPS.map((step, index) => {
              const state = provisioningState(step, index)
              return <div key={step.key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5"><StepState state={state} /><span className="text-sm text-zinc-200">{step.label}</span></div>
            })}
          </div>
          {onboarding?.errors?.length ? <div className="mt-3 rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-3 text-sm text-red-200"><p className="font-medium">{onboarding.errors[onboarding.errors.length - 1].message}</p><p className="mt-1 text-xs text-zinc-300">{onboarding.errors[onboarding.errors.length - 1].action || 'Revisa la etapa indicada y vuelve a intentar.'}</p></div> : null}
        </>
      )}
    </Section>
  )

  const renderTimeline = (limit = 6) => (
    <Section title="Timeline" description="Eventos importantes ordenados del más reciente al más antiguo." icon={Activity} action={<button onClick={() => setActiveTab('activity')} className="text-xs text-blue-300 hover:text-blue-200">Ver todos</button>}>
      <ActivityCenter events={activity.slice(0, limit)} compact />
    </Section>
  )

  const renderOperationalState = () => {
    const retries = Number(deliveryData?.metrics?.retries || 0) + activity.reduce((total, event) => total + Number(event.details?.retriesUsed || event.details?.retryCount || 0), 0)
    const values = [
      ['Último mensaje enviado', relativeTime(latestOutbound?.timestamp)], ['Último mensaje recibido', relativeTime(latestInbound?.timestamp)],
      ['Último webhook', relativeTime(latestWebhook?.timestamp)], ['Última sincronización', 'No disponible'],
      ['Último error', relativeTime(latestError?.timestamp)], ['Última prueba', relativeTime(latestTest?.timestamp)],
      ['Latencia promedio', deliveryData?.metrics ? `${Math.round(deliveryData.metrics.averageResponseTimeMs)} ms` : 'No disponible'], ['Reintentos', deliveryData?.metrics || retries > 0 ? String(retries) : 'No disponible'],
      ['Provisioning', official ? (onboarding?.status || 'No disponible') : 'No aplica'], ['Webhook', onboarding?.steps?.webhook ? 'Verificado' : webhookCheck?.status === 'passed' ? 'Operativo' : webhookCheck?.status === 'failed' ? 'Con error' : 'No disponible'],
    ]
    return <Section title="Estado operativo" description="Señales disponibles del backend; sin inferir métricas ausentes." icon={HeartPulse}><div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">{values.map(([label, value]) => <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><p className="text-[11px] text-zinc-500">{label}</p><p className="mt-1 text-sm font-medium text-zinc-200">{value}</p></div>)}</div></Section>
  }

  const renderAlerts = () => (
    <Section title="Alertas activas" description="Incidentes persistentes asociados a esta conexión." icon={AlertTriangle} action={onOpenAlerts ? <button onClick={onOpenAlerts} className="text-xs text-blue-300 hover:text-blue-200">Abrir Centro de Alertas</button> : null}>
      {activeAlerts.length === 0 ? <p className="rounded-lg border border-emerald-900/70 bg-emerald-950/20 px-3 py-3 text-sm text-emerald-300">No hay alertas activas para esta conexión.</p> : <div className="space-y-2">{activeAlerts.slice(0, 3).map(alert => <div key={alert.id} className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm font-medium text-zinc-100">{alert.message}</p><span className="rounded-full border border-amber-800 px-2 py-0.5 text-[11px] font-medium text-amber-200">{alert.severity}</span></div><p className="mt-1 text-xs text-zinc-400">{alert.component} · {alert.action}</p></div>)}</div>}
    </Section>
  )

  const renderAutomations = () => (
    <Section title="Automatizaciones" description="Tareas programadas o disparadas por eventos para esta conexión." icon={Settings2} action={onOpenAutomations ? <button onClick={onOpenAutomations} className="text-xs text-blue-300 hover:text-blue-200">Abrir Centro de Automatizaciones</button> : null}>
      {connectionAutomations.length === 0 ? <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-500">No hay automatizaciones asociadas a esta conexión.</p> : <div className="space-y-2">{connectionAutomations.slice(0, 3).map(automation => <div key={automation.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-zinc-100">{automation.name}</p><span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">{automation.status}</span></div><p className="mt-1 text-xs text-zinc-500">{automation.trigger.type} · próxima ejecución: {automation.nextExecutionAt ? relativeTime(automation.nextExecutionAt) : 'No programada'}</p>{onExecuteAutomation ? <button onClick={() => onExecuteAutomation(automation.id)} disabled={automation.status !== 'active'} className="mt-2 inline-flex items-center gap-1 rounded border border-violet-800 px-2 py-1 text-xs text-violet-200 disabled:opacity-40"><RefreshCcw size={12} />Ejecutar ahora</button> : null}</div>)}</div>}
    </Section>
  )

  const renderOperations = () => (
    <Section title="Operaciones recientes" description="Jobs masivos que incluyen esta conexión." icon={Settings2} action={onOpenOperations ? <button onClick={onOpenOperations} className="text-xs text-blue-300 hover:text-blue-200">Abrir Centro de Operaciones</button> : null}>
      {connectionOperations.length === 0 ? <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-500">No hay Jobs masivos registrados para esta conexión.</p> : <div className="space-y-2">{connectionOperations.slice(0, 3).map(operation => <div key={operation.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-zinc-100">{operation.operation.type}</p><span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">{operation.status}</span></div><p className="mt-1 text-xs text-zinc-500">{operation.progress.completed}/{operation.progress.total} completadas · {operation.progress.errors} errores</p></div>)}</div>}
    </Section>
  )

  const renderInsights = () => (
    <Section title="Insights" description="Recomendaciones automáticas basadas en reglas simples y actividad disponible." icon={Radio}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {insights.map(item => <div key={item.title} className={`rounded-lg border px-3 py-3 ${componentTone(item.tone)}`}><p className="text-sm font-medium text-zinc-100">{item.title}</p><p className="mt-1 text-xs text-zinc-400">{item.detail}</p></div>)}
      </div>
    </Section>
  )

  const renderQuickActions = () => (
    <div className="flex flex-wrap gap-2">
      <button onClick={onOpenTests} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"><Send size={13} />Centro de Pruebas</button>
      <button onClick={runReconnect} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><RefreshCcw size={13} />Reconectar</button>
      <button onClick={() => window.open('https://business.facebook.com/latest/whatsapp_manager', '_blank', 'noopener,noreferrer')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><ExternalLink size={13} />Abrir Meta</button>
      <button onClick={() => void copyText(callbackUrl, 'callback', 'Callback copiado')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600">{copyKey === 'callback' ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Copy size={13} />}Copiar callback</button>
      <button onClick={() => setActiveTab('diagnostics')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><TerminalSquare size={13} />Ver logs</button>
      <button onClick={() => setActiveTab('activity')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><Activity size={13} />Ver eventos</button>
    </div>
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button onClick={onBack} className="mt-0.5 rounded-md border border-zinc-800 p-2 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200" title="Volver"><ArrowLeft size={16} /></button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-zinc-100">{instance.profileName || instance.name}</h2>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone.text} ${tone.border}`}><span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />{statusLabel(instance)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span>{instance.phone || 'Número pendiente'}</span><span className="text-zinc-700">•</span>
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${connectionIconTone(instance)}`}>{official ? <BadgeCheck size={13} /> : <Cloud size={13} />}{connectionTypeLabel(instance)}</span>
                <span className="rounded-md border border-zinc-800 px-2 py-1">{environment}</span>
                <span>Estado desde {relativeTime(instance.createdAt || instance.lastSeen)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2"><button onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><RefreshCcw size={13} />Actualizar</button>{qrEnabled && !official && instance.status !== 'open' ? <button onClick={() => onQR(instance.name)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"><Smartphone size={13} />Escanear QR</button> : null}</div>
        </div>
        <div className="mt-4 border-t border-zinc-800 pt-4">{renderQuickActions()}</div>
      </header>

      <div className="overflow-x-auto border-b border-zinc-800">
        <div className="flex min-w-max gap-1">
          {TABS.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`border-b-2 px-3 py-2.5 text-sm transition-colors ${activeTab === tab.id ? 'border-blue-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>{tab.label}</button>)}
        </div>
      </div>

      {activeTab === 'summary' ? <div className="flex flex-col gap-5">{renderOperationalState()}{renderAlerts()}{renderAutomations()}{renderOperations()}{renderHealth()}{renderProvisioning()}{renderInsights()}{renderTimeline()}</div> : null}
      {activeTab === 'activity' ? <ActivityCenter events={activity} /> : null}
      {activeTab === 'tests' ? <Section title="Centro de Pruebas" description="Ejecuta pruebas operacionales y revisa el recorrido completo sin volver a elegir esta conexión." icon={Send}><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm text-zinc-200">Smoke Test, mensajería, multimedia, Round Trip y webhook están centralizados en un único lugar.</p><p className="mt-1 text-xs text-zinc-500">La conexión actual se abre preseleccionada y el historial queda guardado localmente.</p><button onClick={onOpenTests} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"><Send size={13} />Abrir Centro de Pruebas</button><button onClick={onOpenMessages} className="ml-2 mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><Send size={13} />Consola técnica</button></div></Section> : null}
      {activeTab === 'webhooks' ? <Section title="Webhooks" description="La administración detallada se mantiene en el módulo existente de webhooks." icon={Radio}><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm text-zinc-200">Callback actual: <span className="font-mono text-xs text-zinc-400">{callbackUrl}</span></p><p className="mt-1 text-xs text-zinc-500">Última recepción: {relativeTime(latestInbound?.timestamp)}.</p><button onClick={onOpenWebhooks} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600"><Radio size={13} />Administrar webhooks</button></div></Section> : null}
      {activeTab === 'diagnostics' ? <Section title="Diagnóstico" description="Problemas detectados y controles técnicos existentes." icon={ShieldCheck} action={diagnosticsLoading ? <Loader2 size={15} className="animate-spin text-zinc-500" /> : null}>{visibleDiagnostics.length === 0 ? <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/20 px-3 py-3 text-sm text-emerald-300">No hay problemas detectados. {healthLabel(instance)}</div> : <div className="grid grid-cols-1 gap-2">{visibleDiagnostics.map(item => <ProblemRow key={`${item.code}-${item.message}`} item={item} />)}</div>}<div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">{healthChecks.map((check: HealthCheck) => <div key={check.code} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><p className="text-sm text-zinc-200">{check.label}</p><p className="mt-1 text-xs text-zinc-500">{check.status === 'passed' ? 'Correcto' : check.details || 'Sin detalle adicional'}</p></div>)}</div></Section> : null}
      {activeTab === 'settings' ? <Section title="Configuración" description="Datos operativos y accesos técnicos por niveles." icon={Settings2}><div className="grid grid-cols-1 gap-3 lg:grid-cols-2"><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-xs text-zinc-500">Callback de recepción</p><p className="mt-1 break-all font-mono text-xs text-zinc-300">{callbackUrl}</p><button onClick={() => void copyText(callbackUrl, 'settings-callback', 'Callback copiado')} className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200"><Clipboard size={13} />Copiar callback</button></div><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-xs text-zinc-500">Endpoint de envío</p><p className="mt-1 break-all font-mono text-xs text-zinc-300">{sendUrl}</p><button onClick={() => void copyText(sendUrl, 'send', 'Endpoint de envío copiado')} className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200"><Copy size={13} />Copiar endpoint</button></div></div><div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"><button onClick={() => setAdminMode(value => !value)} className="flex w-full items-center justify-between text-sm font-medium text-zinc-100"><span className="flex items-center gap-2">{adminMode ? <EyeOff size={14} /> : <Eye size={14} />}Detalles técnicos</span></button>{adminMode ? <div className="mt-3 space-y-1.5 text-xs text-zinc-500"><p>Nombre interno: <span className="font-mono text-zinc-300">{instance.name}</span></p><p>ID: <span className="font-mono text-zinc-300">{instance.id}</span></p><p>Estado de ciclo: <span className="font-mono text-zinc-300">{instance.lifecycleState || '-'}</span></p><p>API key: <span className="font-mono text-zinc-300">{apiKeyInfo?.hasApiKey ? apiKeyInfo.maskedApiKey || 'generada' : 'sin generar'}</span></p><button onClick={() => onApiKey(instance.name)} className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200"><KeyRound size={13} />Administrar acceso interno</button></div> : <p className="mt-2 text-xs text-zinc-500">Los identificadores internos permanecen ocultos por defecto.</p>}</div><button onClick={() => onDelete(instance.name)} className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-red-900/70 px-3 py-2 text-xs text-red-300 hover:border-red-800"><Unplug size={13} />Eliminar conexión</button></Section> : null}
    </div>
  )
}
