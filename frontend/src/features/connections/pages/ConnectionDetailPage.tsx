import { ArrowLeft, Check, Clipboard, Eye, EyeOff, MessageSquare, Pencil, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
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
  sendConnectionQuickMessage,
  testConnectionWebhook,
  updateConnectionWebhook,
} from '../api/connectionOperationsApi'
import { deleteConnection, getConnection, updateConnectionName } from '../api/connectionsApi'

function stateLabel(state: Connection['status']['state']): string {
  return { pending: 'Pendiente', connected: 'Conectada', connecting: 'Conectando', disconnected: 'Desconectada' }[state]
}

function dateTime(value: string | null | undefined, fallback = 'Sin actividad registrada'): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function eventTime(value: number): string {
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
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
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [name, setName] = useState('')
  const [isEditingWebhook, setIsEditingWebhook] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [quickNumber, setQuickNumber] = useState('')
  const [quickMessage, setQuickMessage] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isTestingWebhook, setIsTestingWebhook] = useState(false)
  const [isRegeneratingKey, setIsRegeneratingKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

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
        getConnectionWebhook(connectionId),
        getConnectionApiKey(connectionId),
        getConnectionStatusSummary(connectionId),
        listConnectionActivity(connectionId),
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

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    setError(null)
    setIsSaving(true)
    try {
      setConnection(await updateConnectionName(connection.id, name))
      setIsEditingName(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la conexión.')
    } finally {
      setIsSaving(false)
    }
  }

  async function saveWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    setError(null)
    setIsSaving(true)
    try {
      const updated = await updateConnectionWebhook(connection.id, webhookUrl)
      setWebhook(updated)
      setWebhookUrl(updated.url || '')
      setIsEditingWebhook(false)
      setNotice('Webhook actualizado.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo actualizar el webhook.')
    } finally {
      setIsSaving(false)
    }
  }

  async function runWebhookTest() {
    if (!connection) return
    setError(null)
    setIsTestingWebhook(true)
    try {
      const result = await testConnectionWebhook(connection.id)
      setNotice(result.ok ? 'Webhook probado correctamente.' : result.error || 'El webhook respondió con un error.')
      await Promise.all([loadOperations(), loadConnection()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo probar el webhook.')
    } finally {
      setIsTestingWebhook(false)
    }
  }

  async function sendQuickMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!connection) return
    setError(null)
    setIsSending(true)
    try {
      await sendConnectionQuickMessage(connection.id, quickNumber, quickMessage)
      setQuickMessage('')
      setNotice('Mensaje enviado.')
      await Promise.all([loadOperations(), loadConnection()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo enviar el mensaje.')
    } finally {
      setIsSending(false)
    }
  }

  async function regenerateKey() {
    if (!connection) return
    setError(null)
    setIsRegeneratingKey(true)
    try {
      const updated = await regenerateConnectionApiKey(connection.id)
      setApiKey(updated)
      setShowKey(true)
      setNotice('Nueva API Key generada. Copiala ahora: no volverá a mostrarse completa.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo regenerar la API Key.')
    } finally {
      setIsRegeneratingKey(false)
    }
  }

  async function copyKey() {
    const value = apiKey?.apiKey || apiKey?.maskedApiKey
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice('API Key copiada.')
    } catch {
      setError('No se pudo copiar la API Key.')
    }
  }

  async function reconnect() {
    if (!connection) return
    setError(null)
    setIsReconnecting(true)
    try {
      await reconnectConnection(connection.id)
      setNotice('Reconexión iniciada.')
      await Promise.all([loadConnection(), loadOperations()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo iniciar la reconexión.')
    } finally {
      setIsReconnecting(false)
    }
  }

  async function removeConnection() {
    if (!connection) return
    setError(null)
    setIsDeleting(true)
    try {
      await deleteConnection(connection.id)
      navigate(`/clients/${connection.clientId}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo eliminar la conexión.')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) return <p className="clients-state">Cargando conexión…</p>
  if (!connection) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'Conexión no encontrada.'}</p><button type="button" onClick={() => void loadConnection()}>Reintentar</button></div>

  const displayedKey = apiKey?.apiKey || apiKey?.maskedApiKey

  return (
    <section className="connection-detail">
      <button type="button" className="client-back-link" onClick={() => navigate(`/clients/${connection.clientId}`)}><ArrowLeft size={16} aria-hidden="true" /> {connection.client?.name || 'Cliente'}</button>
      <header className="connection-detail-heading"><h2>{connection.name}</h2></header>
      {error ? <p className="client-form-error" role="alert">{error}</p> : null}
      {notice ? <p className="connection-notice" role="status"><Check size={15} aria-hidden="true" /> {notice}</p> : null}

      {isEditingName ? <form className="connection-name-form" onSubmit={saveName}><label><span>Nombre</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required autoFocus /></label><div><button type="button" className="client-button-secondary" onClick={() => { setName(connection.name); setIsEditingName(false) }}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar'}</button></div></form> : null}

      <section className="connection-section">
        <div className="connection-section-heading"><h3>Información</h3><button type="button" className="client-button-secondary" onClick={() => setIsEditingName((value) => !value)}><Pencil size={15} aria-hidden="true" /> Editar nombre</button></div>
        <dl className="connection-information-list">
          <div><dt>Cliente</dt><dd>{connection.client?.name || 'No disponible'}</dd></div>
          <div><dt>Canal</dt><dd>{connection.channel.displayName}</dd></div>
          <div><dt>Proveedor</dt><dd>{connection.provider.displayName}</dd></div>
          <div><dt>Estado</dt><dd><span className={`connection-status connection-status-${statusSummary?.connected ? 'connected' : connection.status.state}`}>{statusSummary?.connected ? 'Conectado' : stateLabel(connection.status.state)}</span></dd></div>
          <div><dt>Última actividad</dt><dd>{dateTime(statusSummary?.lastActivityAt || connection.lastActivityAt)}</dd></div>
          <div><dt>Último heartbeat</dt><dd>{dateTime(statusSummary?.lastHeartbeatAt, 'Sin heartbeat registrado')}</dd></div>
        </dl>
      </section>

      <section className="connection-section">
        <div className="connection-section-heading"><div><h3>Webhook</h3><p>{webhook?.configured ? (webhook.enabled ? 'Activo' : 'Desactivado') : 'Sin configurar'}</p></div><button type="button" className="client-button-secondary" onClick={() => setIsEditingWebhook((value) => !value)}>Editar</button></div>
        {webhook?.url && !isEditingWebhook ? <p className="connection-section-value">{webhook.url}</p> : null}
        {isEditingWebhook ? <form className="connection-inline-form" onSubmit={saveWebhook}><label><span>URL</span><input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://…" required autoFocus /></label><div><button type="button" className="client-button-secondary" onClick={() => { setWebhookUrl(webhook?.url || ''); setIsEditingWebhook(false) }}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar'}</button></div></form> : null}
        <dl className="connection-webhook-summary"><div><dt>Última entrega</dt><dd>{dateTime(webhook?.lastDeliveryAt, 'Sin entregas')}</dd></div><div><dt>Último error</dt><dd>{webhook?.lastError || 'Sin errores'}</dd></div><div><dt>Entregas exitosas</dt><dd>{webhook?.successfulDeliveries || 0}</dd></div><div><dt>Errores</dt><dd>{webhook?.failedDeliveries || 0}</dd></div></dl>
        <button type="button" className="connection-text-action" onClick={() => void runWebhookTest()} disabled={!webhook?.configured || isTestingWebhook}>{isTestingWebhook ? 'Probando…' : 'Probar webhook'}</button>
      </section>

      <section className="connection-section">
        <div className="connection-section-heading"><div><h3>API Key</h3><p>{apiKey?.enabled && apiKey.hasApiKey ? 'Activa' : 'Sin API Key activa'}</p></div></div>
        {showKey && displayedKey ? <p className="connection-key-value">{displayedKey}</p> : <p className="connection-section-value">La clave completa sólo se muestra cuando se regenera.</p>}
        <div className="connection-inline-actions"><button type="button" className="client-button-secondary" onClick={() => setShowKey((value) => !value)} disabled={!displayedKey}>{showKey ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}{showKey ? 'Ocultar' : 'Mostrar'}</button><button type="button" className="client-button-secondary" onClick={() => void regenerateKey()} disabled={isRegeneratingKey}>{isRegeneratingKey ? 'Regenerando…' : 'Regenerar'}</button><button type="button" className="client-button-secondary" onClick={() => void copyKey()} disabled={!displayedKey}><Clipboard size={15} aria-hidden="true" /> Copiar</button></div>
      </section>

      <section className="connection-section">
        <div className="connection-section-heading"><div><h3>Prueba rápida</h3><p>Enviá un mensaje de texto desde esta conexión.</p></div><MessageSquare size={18} aria-hidden="true" /></div>
        <form className="connection-quick-message" onSubmit={sendQuickMessage}><label><span>Número</span><input inputMode="numeric" value={quickNumber} onChange={(event) => setQuickNumber(event.target.value)} placeholder="549…" required /></label><label><span>Mensaje</span><textarea value={quickMessage} onChange={(event) => setQuickMessage(event.target.value)} rows={3} maxLength={4096} required /></label><button type="submit" className="client-button-primary" disabled={isSending}><Send size={15} aria-hidden="true" /> {isSending ? 'Enviando…' : 'Enviar mensaje'}</button></form>
      </section>

      <section className="connection-section">
        <h3>Acciones rápidas</h3>
        <div className="connection-inline-actions"><button type="button" className="client-button-secondary" onClick={() => void reconnect()} disabled={isReconnecting}><RefreshCw size={15} aria-hidden="true" /> {isReconnecting ? 'Reconectando…' : 'Reconectar'}</button><button type="button" className="client-button-danger" onClick={() => void removeConnection()} disabled={isDeleting}><Trash2 size={15} aria-hidden="true" /> {isDeleting ? 'Eliminando…' : 'Eliminar conexión'}</button></div>
      </section>

      <section className="connection-section">
        <div className="connection-section-heading"><div><h3>Actividad reciente</h3><p>Últimos eventos de esta conexión</p></div><button type="button" className="client-button-secondary" onClick={() => setNotice('La actividad completa se incorporará en una próxima fase.')}>Ver actividad completa</button></div>
        {activity.length === 0 ? <p className="connection-section-value">Todavía no hay actividad registrada.</p> : <ol className="connection-activity-list">{activity.map((item) => <li key={item.id}><button type="button" onClick={() => setSelectedActivity(item)}><div><strong>{item.description}</strong><span>{eventTime(item.occurredAt)}</span></div><em>{item.status}</em></button></li>)}</ol>}
      </section>

      {selectedActivity ? <div className="activity-panel-backdrop" role="presentation" onMouseDown={() => setSelectedActivity(null)}><aside className="activity-panel" role="dialog" aria-modal="true" aria-label="Detalle técnico de actividad" onMouseDown={(event) => event.stopPropagation()}><div className="activity-panel-heading"><div><h3>{selectedActivity.description}</h3><p>{eventTime(selectedActivity.occurredAt)}</p></div><button type="button" onClick={() => setSelectedActivity(null)} aria-label="Cerrar detalle"><X size={18} /></button></div><dl>{Object.entries(selectedActivity.technical).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></aside></div> : null}
    </section>
  )
}
