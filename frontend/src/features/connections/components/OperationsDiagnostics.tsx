import { Activity, CheckCircle2, CircleAlert, CloudCog, LoaderCircle, RefreshCw, RotateCw, ShieldCheck, Unplug, Webhook, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { Toast } from '@/shared/components/Toast'
import type { ConnectionAvailability, ConnectionDiagnosticCheck, ConnectionDiagnostics, WebhookConfigurationVerification } from '../api/connectionOperationsApi'
import { getConnectionAvailability, getConnectionDiagnostics, testConnectionWebhook, verifyConnectionWebhookConfiguration } from '../api/connectionOperationsApi'

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

function lifecycleLabel(state: string, lifecycle: string | null): string {
  const value = String(lifecycle || state || '').toLowerCase()
  return ({ ready: 'Lista', connected: 'Lista', pending: 'Pendiente', connecting: 'Configurando', disconnected: 'Desconectada', failed: 'Con atención requerida' } as Record<string, string>)[value] || 'Sin verificar'
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
  connectionState: string
  connectionLifecycle: string | null
  onReconnect: () => Promise<void>
  onRefreshConnection: () => Promise<void>
  onManageWebhooks: () => void
}

export function OperationsDiagnostics({ connectionId, providerId, connectionState, connectionLifecycle, onReconnect, onRefreshConnection, onManageWebhooks }: Props) {
  const [data, setData] = useState<ConnectionDiagnostics | null>(null)
  const [availability, setAvailability] = useState<ConnectionAvailability | null>(null)
  const [webhookVerification, setWebhookVerification] = useState<WebhookConfigurationVerification | null>(null)
  const [webhookTest, setWebhookTest] = useState<{ ok: boolean; status: number; error: string | null } | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false)
  const [isWebhookTestOpen, setIsWebhookTestOpen] = useState(false)
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
      const result = await getConnectionAvailability(connectionId)
      setAvailability(result)
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
      setWebhookVerification(result)
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

  async function sendWebhookTest() {
    setRunning('webhook-test')
    setError(null)
    try {
      const result = await testConnectionWebhook(connectionId)
      setWebhookTest(result)
      setNotice(result.ok ? 'Webhook respondió correctamente.' : 'El webhook no respondió correctamente.')
      await Promise.all([refreshDiagnostics(), onRefreshConnection()])
    } catch {
      setWebhookTest(null)
      setError('No se pudo enviar la prueba al webhook. Revisá su configuración y volvé a intentarlo.')
    } finally {
      setRunning(null)
      setIsWebhookTestOpen(false)
    }
  }

  const runtimeCheck = data?.checks.find((check) => check.code === 'gateway')
  const webhookCheck = data?.checks.find((check) => check.code === 'webhook')
  const canReconnect = !isMeta && runtimeCheck?.status === 'degraded'
  const availabilityLabel = availability ? (availability.available ? 'Disponible' : 'No disponible') : healthLabel(data?.summary.status || 'unknown')
  const webhookLabel = webhookVerification
    ? (webhookVerification.configuration_valid ? 'Configuración válida' : 'Requiere revisión')
    : webhookCheck?.status === 'healthy' ? 'Configurado' : webhookCheck?.status === 'degraded' ? 'Requiere revisión' : 'Sin verificar'

  const operationButton = (name: string, label: string, Icon: typeof RefreshCw, onClick: () => void, kind: 'action' | 'diagnostic', disabled = false) => (
    <button type="button" className={`operation-button operation-button-${kind}`} disabled={disabled || running === name} onClick={onClick}>
      {running === name ? <LoaderCircle className="animate-spin" size={16} aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
      <span>{running === name ? ({ reconnect: 'Reconectando…', availability: 'Verificando disponibilidad…', 'webhook-configuration': 'Verificando configuración…', 'webhook-test': 'Enviando prueba…' } as Record<string, string>)[name] : label}</span>
    </button>
  )

  return <section className="operations-console" aria-label="Operaciones de conexión">
    <div className="operations-console-heading"><div><p>Operaciones</p><h3>Estado, diagnóstico y acciones</h3><span>Primero verificá el estado; las acciones reales se muestran por separado.</span></div></div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />

    <section className="operation-section operation-status-card" aria-labelledby="connection-status-heading">
      <div className="operation-section-heading"><div><p>Estado de la conexión</p><h4 id="connection-status-heading">{refreshing ? 'Actualizando diagnóstico…' : healthLabel(data?.summary.status || 'unknown')}</h4><span>Última verificación: {dateTime(data?.summary.lastVerifiedAt || null)}</span></div>
        {operationButton('refresh', 'Actualizar diagnóstico', RefreshCw, () => void refreshDiagnostics(), 'diagnostic', refreshing)}
      </div>
      <dl className="operation-status-grid">
        <div><dt>Lifecycle</dt><dd>{lifecycleLabel(connectionState, connectionLifecycle)}</dd></div>
        <div><dt>Runtime</dt><dd>{runtimeLabel(runtimeCheck?.status)}</dd></div>
        <div><dt>Salud</dt><dd>{healthLabel(data?.summary.status || 'unknown')}</dd></div>
        <div><dt>Disponibilidad</dt><dd>{availabilityLabel}</dd></div>
      </dl>
    </section>

    <section className="operation-section" aria-labelledby="diagnostics-heading">
      <div className="operation-section-heading"><div><p>Diagnóstico</p><h4 id="diagnostics-heading">Qué podés revisar</h4><span>Estas consultas no cambian la conexión ni envían solicitudes al webhook.</span></div></div>
      <div className="operation-diagnostics-grid">
        {isMeta ? <article className="operation-diagnostic-card"><CloudCog size={18} aria-hidden="true" /><div><strong>Disponibilidad</strong><span>{availability ? availabilityLabel : 'Consultá credenciales, runtime y salud disponible.'}</span>{availability?.limitation ? <small>{availability.limitation}</small> : null}</div>{operationButton('availability', 'Verificar disponibilidad', Activity, () => void verifyAvailability(), 'diagnostic')}</article> : <article className="operation-diagnostic-card"><Activity size={18} aria-hidden="true" /><div><strong>Runtime y disponibilidad</strong><span>{runtimeLabel(runtimeCheck?.status)}</span></div><button type="button" className="operation-link" onClick={() => void refreshDiagnostics()} disabled={refreshing}>Actualizar</button></article>}
        <article className="operation-diagnostic-card"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Webhook</strong><span>{webhookLabel}</span>{webhookVerification ? <small>La verificación revisa configuración local; no prueba conectividad.</small> : null}</div>{operationButton('webhook-configuration', 'Verificar configuración', ShieldCheck, () => void verifyWebhookConfiguration(), 'diagnostic')}</article>
      </div>
      {data?.summary.lastError ? <p className="operation-last-error"><CircleAlert size={16} aria-hidden="true" /> Último error: {data.summary.lastError}</p> : null}
      <button type="button" className="connection-text-action" onClick={() => setIsDiagnosticsOpen(true)} disabled={!data}>Ver detalle del diagnóstico</button>
    </section>

    <section className="operation-section" aria-labelledby="actions-heading">
      <div className="operation-section-heading"><div><p>Acciones reales</p><h4 id="actions-heading">Acciones disponibles</h4><span>Estas acciones pueden cambiar el estado o enviar una solicitud externa.</span></div></div>
      <div className="operation-actions-grid">
        {canReconnect ? <article className="operation-action-card"><RotateCw size={18} aria-hidden="true" /><div><strong>Reconectar</strong><span>Solicita una reconexión al runtime de Evolution. No confirma la conexión hasta el próximo diagnóstico.</span></div>{operationButton('reconnect', 'Reconectar', RotateCw, () => void reconnect(), 'action')}</article> : !isMeta ? <article className="operation-action-card is-muted"><Activity size={18} aria-hidden="true" /><div><strong>Reconectar no disponible</strong><span>{runtimeCheck?.status === 'healthy' ? 'El runtime ya está conectado.' : 'Esperá a que el runtime esté disponible y actualizá el diagnóstico.'}</span></div></article> : null}
        <article className="operation-action-card"><Webhook size={18} aria-hidden="true" /><div><strong>Probar webhook</strong><span>Envía una solicitud de prueba al destino configurado.</span></div>{operationButton('webhook-test', 'Probar webhook', Webhook, () => setIsWebhookTestOpen(true), 'action')}</article>
      </div>
      {webhookTest ? <div className={`operation-result ${webhookTest.ok ? 'is-success' : 'is-error'}`} role="status"><StatusIcon status={webhookTest.ok ? 'healthy' : 'unhealthy'} /><div><strong>{webhookTest.ok ? 'Webhook respondió correctamente' : 'El webhook no respondió correctamente'}</strong><span>{webhookTest.status ? `HTTP ${webhookTest.status}` : 'Sin respuesta HTTP'}{webhookTest.error ? ` · ${webhookTest.error}` : ''}</span></div></div> : null}
      <button type="button" className="connection-text-action" onClick={onManageWebhooks}>Administrar webhooks</button>
    </section>

    {isDiagnosticsOpen ? <div className="activity-panel-backdrop" role="presentation" onMouseDown={() => setIsDiagnosticsOpen(false)}><aside className="activity-panel diagnostics-panel" role="dialog" aria-modal="true" aria-label="Diagnóstico de conexión" onMouseDown={(event) => event.stopPropagation()}><div className="activity-panel-heading"><div><h3>Detalle del diagnóstico</h3><p>Controles de disponibilidad y configuración.</p></div><button type="button" onClick={() => setIsDiagnosticsOpen(false)} aria-label="Cerrar diagnóstico"><X size={18} /></button></div>{data ? <ul className="diagnostics-checks">{data.checks.map((check) => <li key={check.code}><StatusIcon status={check.status} /><div><div><strong>{check.label}</strong><span className={`diagnostic-check-status diagnostic-check-status-${check.status}`}>{healthLabel(check.status)}</span></div><p>{check.message}</p><small>Verificado: {dateTime(check.lastVerifiedAt)}</small>{check.action ? <em>Acción sugerida: {check.action}</em> : null}</div></li>)}</ul> : null}</aside></div> : null}
    <ConfirmDialog isOpen={isWebhookTestOpen} title="Enviar prueba de webhook" description="Esto enviará una solicitud de prueba al destino configurado. No se mostrarán secretos ni el payload completo." confirmLabel="Enviar prueba" submittingLabel="Enviando prueba…" tone="default" isSubmitting={running === 'webhook-test'} onCancel={() => setIsWebhookTestOpen(false)} onConfirm={() => void sendWebhookTest()} />
  </section>
}
