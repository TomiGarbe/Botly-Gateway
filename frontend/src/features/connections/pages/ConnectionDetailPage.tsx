import { ArrowLeft, Clipboard, Eye, EyeOff, MessageCircle, Pencil, RefreshCw, RotateCw, Trash2, Webhook, X } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'
import { LoadingState } from '@/shared/components/LoadingState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { EmptyState } from '@/shared/components/EmptyState'
import { Toast } from '@/shared/components/Toast'
import {
  ConnectionActivity,
  ConnectionApiKey,
  ConnectionStatusSummary,
  ConnectionWebhook,
  getConnectionApiKey,
  getConnectionStatusSummary,
  getConnectionWebhook,
  listConnectionActivity,
  reconnectConnection,
  regenerateConnectionApiKey,
  testConnectionWebhook,
  updateConnectionWebhook,
} from '../api/connectionOperationsApi'
import { deleteConnection, getConnection, updateConnectionName } from '../api/connectionsApi'
import { MessagesWorkspace } from '../components/MessagesWorkspace'
import { OperationsDiagnostics } from '../components/OperationsDiagnostics'

type WorkspaceTab = 'general' | 'security' | 'messages' | 'webhooks'

const tabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'security', label: 'Seguridad' },
  { id: 'messages', label: 'Mensajes' },
  { id: 'webhooks', label: 'Webhooks' },
]

function workspaceState(connection: Connection, status: ConnectionStatusSummary | null): { label: string; tone: StatusTone } {
  if (status?.connected || connection.status.health === 'healthy') return { label: 'Operativa', tone: 'healthy' }
  if (connection.status.state === 'pending') return { label: 'Pendiente', tone: 'pending' }
  if (connection.status.state === 'connecting') return { label: 'Configurando', tone: 'configuring' }
  if (connection.status.health === 'unhealthy' || connection.status.state === 'disconnected') return { label: 'Problema crítico', tone: 'critical' }
  return { label: 'Atención requerida', tone: 'attention' }
}

function dateTime(value: string | null | undefined, fallback = 'Sin actividad registrada'): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function eventTime(value: number): string {
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function isWebhookActivity(activity: ConnectionActivity): boolean {
  return `${activity.description} ${activity.technical.Componente || ''} ${activity.technical.Evento || ''}`.toLowerCase().includes('webhook')
}

export function ConnectionDetailPage() {
  const navigate = useNavigate()
  const { connectionId } = useParams()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [webhook, setWebhook] = useState<ConnectionWebhook | null>(null)
  const [apiKey, setApiKey] = useState<ConnectionApiKey | null>(null)
  const [statusSummary, setStatusSummary] = useState<ConnectionStatusSummary | null>(null)
  const [activity, setActivity] = useState<ConnectionActivity[]>([])
  const [selectedActivity, setSelectedActivity] = useState<ConnectionActivity | null>(null)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('general')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [name, setName] = useState('')
  const [isEditingWebhook, setIsEditingWebhook] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false)

  const loadConnection = useCallback(async () => {
    if (!connectionId) return
    setError(null)
    try {
      const loaded = await getConnection(connectionId)
      setConnection(loaded)
      setName(loaded.name)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar la conexión.')
    } finally {
      setIsLoading(false)
    }
  }, [connectionId])

  const loadOperations = useCallback(async () => {
    if (!connectionId) return
    try {
      const [nextWebhook, nextApiKey, nextStatus, nextActivity] = await Promise.all([
        getConnectionWebhook(connectionId), getConnectionApiKey(connectionId), getConnectionStatusSummary(connectionId), listConnectionActivity(connectionId),
      ])
      setWebhook(nextWebhook)
      setWebhookUrl(nextWebhook.url || '')
      setApiKey(nextApiKey)
      setStatusSummary(nextStatus)
      setActivity(nextActivity)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar la operación de la conexión.')
    }
  }, [connectionId])

  useEffect(() => { void loadConnection() }, [loadConnection])
  useEffect(() => { void loadOperations() }, [loadOperations])

  async function refreshWorkspace() { await Promise.all([loadConnection(), loadOperations()]) }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    setError(null); setIsSaving(true)
    try { setConnection(await updateConnectionName(connection.id, name)); setIsEditingName(false) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la conexión.') } finally { setIsSaving(false) }
  }

  async function saveWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    setError(null); setIsSaving(true)
    try { const updated = await updateConnectionWebhook(connection.id, webhookUrl); setWebhook(updated); setWebhookUrl(updated.url || ''); setIsEditingWebhook(false); setNotice('Webhook actualizado.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo actualizar el webhook.') } finally { setIsSaving(false) }
  }

  async function runWebhookTest() {
    if (!connection) return
    setError(null)
    try { const result = await testConnectionWebhook(connection.id); setNotice(result.ok ? 'Webhook probado correctamente.' : result.error || 'El webhook respondió con un error.'); await refreshWorkspace() } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo probar el webhook.') }
  }

  async function regenerateKey() {
    if (!connection) return
    setError(null)
    try { const updated = await regenerateConnectionApiKey(connection.id); setApiKey(updated); setShowKey(true); setNotice('Nueva API Key generada. Copiala ahora: no volverá a mostrarse completa.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo regenerar la API Key.') }
  }

  async function copyKey() {
    const value = apiKey?.apiKey || apiKey?.maskedApiKey
    if (!value) return
    try { await navigator.clipboard.writeText(value); setNotice('API Key copiada.') } catch { setError('No se pudo copiar la API Key.') }
  }

  async function reconnect() {
    if (!connection) return
    setError(null)
    try { await reconnectConnection(connection.id); setNotice('Reconexión iniciada.'); await refreshWorkspace() } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo iniciar la reconexión.') }
  }

  async function removeConnection() {
    if (!connection) return
    setError(null); setIsDeleting(true)
    try { await deleteConnection(connection.id); navigate(`/clients/${connection.clientId}`) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo eliminar la conexión.') } finally { setIsDeleting(false) }
  }

  const channelActivity = useMemo(() => activity.filter((item) => !isWebhookActivity(item)), [activity])
  const webhookActivity = useMemo(() => activity.filter(isWebhookActivity), [activity])

  if (isLoading) return <LoadingState label="Cargando conexión…" />
  if (!connection) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'Conexión no encontrada.'}</p><button type="button" onClick={() => void loadConnection()}>Reintentar</button></div>

  const displayedKey = showKey && apiKey?.apiKey ? apiKey.apiKey : apiKey?.maskedApiKey
  const headerState = workspaceState(connection, statusSummary)

  return <section className="connection-detail workspace-detail">
    <header className="workspace-header">
      <button type="button" className="client-back-link" onClick={() => navigate(`/clients/${connection.clientId}`)}><ArrowLeft size={16} aria-hidden="true" /> {connection.client?.name || 'Cliente'}</button>
      <div className="workspace-header-main"><div><StatusBadge tone={headerState.tone}>{headerState.label}</StatusBadge><h2>{connection.name}</h2><p>{connection.client?.name || 'Cliente'} · {connection.channel.displayName} · {connection.provider.displayName}</p></div><div className="workspace-header-actions"><button type="button" className="client-button-secondary" onClick={() => void reconnect()}><RotateCw size={15} aria-hidden="true" /> Reconectar</button><button type="button" className="client-button-secondary" onClick={() => void refreshWorkspace()}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></div></div>
      <div className="workspace-tabs" role="tablist" aria-label="Secciones del Workspace">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</div>
    </header>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />

    <div className="workspace-tab-content">
      {activeTab === 'general' ? <>
        {isEditingName ? <form className="connection-name-form" onSubmit={saveName}><label><span>Nombre</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required autoFocus /></label><div><button type="button" className="client-button-secondary" onClick={() => { setName(connection.name); setIsEditingName(false) }}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar'}</button></div></form> : null}
        <section className="connection-section workspace-general-info"><div className="connection-section-heading"><h3>Información general</h3><button type="button" className="client-button-secondary" onClick={() => setIsEditingName((value) => !value)}><Pencil size={15} aria-hidden="true" /> Editar nombre</button></div><dl className="connection-information-list"><div><dt>Cliente</dt><dd>{connection.client?.name || 'No disponible'}</dd></div><div><dt>Canal</dt><dd>{connection.channel.displayName}</dd></div><div><dt>Provider</dt><dd>{connection.provider.displayName}</dd></div><div><dt>Estado</dt><dd><StatusBadge tone={headerState.tone}>{headerState.label}</StatusBadge></dd></div><div><dt>Última actividad</dt><dd>{dateTime(statusSummary?.lastActivityAt || connection.lastActivityAt)}</dd></div></dl></section>
        <OperationsDiagnostics connectionId={connection.id} runtimeName={connection.runtimeName} onReconnect={reconnect} onTestWebhook={runWebhookTest} onRefreshConnection={refreshWorkspace} />
        <section className="connection-section"><h3>Administración</h3><div className="connection-inline-actions"><button type="button" className="client-button-danger" onClick={() => setIsDeleteDialogOpen(true)} disabled={isDeleting}><Trash2 size={15} aria-hidden="true" /> Eliminar conexión</button></div></section>
      </> : null}

      {activeTab === 'security' ? <section className="connection-section workspace-security"><div className="connection-section-heading"><div><h3>API Key</h3><p>{apiKey?.enabled && apiKey.hasApiKey ? 'Activa' : 'Sin API Key activa'}</p></div></div><dl className="connection-information-list"><div><dt>Estado</dt><dd>{apiKey?.enabled && apiKey.hasApiKey ? 'Activa' : 'Sin API Key activa'}</dd></div><div><dt>API Key</dt><dd className="connection-key-value">{displayedKey || 'No hay una API Key disponible'}</dd></div></dl><div className="connection-inline-actions">{apiKey?.apiKey ? <button type="button" className="client-button-secondary" onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}{showKey ? 'Ocultar' : 'Mostrar'}</button> : null}<button type="button" className="client-button-secondary" onClick={() => void copyKey()} disabled={!displayedKey}><Clipboard size={15} aria-hidden="true" /> Copiar</button><button type="button" className="client-button-secondary" onClick={() => setIsRegenerateDialogOpen(true)}>Regenerar</button></div></section> : null}

      {activeTab === 'messages' ? <><MessagesWorkspace runtimeName={connection.runtimeName} /><section className="connection-section"><div className="connection-section-heading"><div><h3>Actividad del canal</h3><p>Gateway · Meta · Canal</p></div></div>{channelActivity.length === 0 ? <EmptyState icon={MessageCircle} title="No hay actividad del canal." description="La actividad de mensajería aparecerá aquí cuando se produzca." /> : <ol className="connection-activity-list">{channelActivity.map((item) => <li key={item.id}><button type="button" onClick={() => setSelectedActivity(item)}><div><strong>{item.description}</strong><span>{eventTime(item.occurredAt)}</span></div><em>{item.status}</em></button></li>)}</ol>}</section></> : null}

      {activeTab === 'webhooks' ? <><section className="connection-section workspace-webhooks"><div className="connection-section-heading"><div><h3>Webhook</h3><p>{webhook?.configured ? (webhook.enabled ? 'Activo' : 'Desactivado') : 'Sin configurar'}</p></div><button type="button" className="client-button-secondary" onClick={() => setIsEditingWebhook((value) => !value)}>Editar</button></div>{webhook?.url && !isEditingWebhook ? <p className="connection-section-value">{webhook.url}</p> : null}{isEditingWebhook ? <form className="connection-inline-form" onSubmit={saveWebhook}><label><span>URL</span><input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://…" required autoFocus /></label><div><button type="button" className="client-button-secondary" onClick={() => { setWebhookUrl(webhook?.url || ''); setIsEditingWebhook(false) }}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar'}</button></div></form> : null}<dl className="connection-webhook-summary"><div><dt>Último envío</dt><dd>{dateTime(webhook?.lastDeliveryAt, 'Sin envíos')}</dd></div><div><dt>Último error</dt><dd>{webhook?.lastError || 'Sin errores'}</dd></div><div><dt>Envíos exitosos</dt><dd>{webhook?.successfulDeliveries || 0}</dd></div><div><dt>Errores</dt><dd>{webhook?.failedDeliveries || 0}</dd></div></dl><button type="button" className="connection-text-action" onClick={() => void runWebhookTest()} disabled={!webhook?.configured}>Probar webhook</button></section><section className="connection-section"><div className="connection-section-heading"><div><h3>Actividad del webhook</h3><p>Gateway · Webhook del cliente</p></div></div>{webhookActivity.length === 0 ? <EmptyState icon={Webhook} title="No hay actividad de webhook." description="Las entregas y pruebas del webhook aparecerán aquí." /> : <ol className="connection-activity-list">{webhookActivity.map((item) => <li key={item.id}><button type="button" onClick={() => setSelectedActivity(item)}><div><strong>{item.description}</strong><span>{eventTime(item.occurredAt)}</span></div><em>{item.status}</em></button></li>)}</ol>}</section></> : null}
    </div>

    {selectedActivity ? <div className="activity-panel-backdrop" role="presentation" onMouseDown={() => setSelectedActivity(null)}><aside className="activity-panel" role="dialog" aria-modal="true" aria-label="Detalle técnico de actividad" onMouseDown={(event) => event.stopPropagation()}><div className="activity-panel-heading"><div><h3>{selectedActivity.description}</h3><p>{eventTime(selectedActivity.occurredAt)}</p></div><button type="button" onClick={() => setSelectedActivity(null)} aria-label="Cerrar detalle"><X size={18} /></button></div><dl>{Object.entries(selectedActivity.technical).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></aside></div> : null}
    <ConfirmDialog isOpen={isDeleteDialogOpen} title="Eliminar conexión" description="Esta acción eliminará la conexión y su acceso al Workspace." confirmLabel="Eliminar conexión" isSubmitting={isDeleting} onCancel={() => setIsDeleteDialogOpen(false)} onConfirm={() => void removeConnection()} />
    <ConfirmDialog isOpen={isRegenerateDialogOpen} title="Regenerar API Key" description="La API Key actual dejará de ser válida. Asegurate de copiar la nueva clave al finalizar." confirmLabel="Regenerar API Key" tone="default" onCancel={() => setIsRegenerateDialogOpen(false)} onConfirm={() => { setIsRegenerateDialogOpen(false); void regenerateKey() }} />
  </section>
}
