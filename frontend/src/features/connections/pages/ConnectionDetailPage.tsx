import { AlertTriangle, ArrowLeft, Clipboard, Info, KeyRound, Link2, Eye, EyeOff, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'
import { LoadingState } from '@/shared/components/LoadingState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { Toast } from '@/shared/components/Toast'
import { Field, Input } from '@/shared/components/FormControls'
import { ConnectionApiKey, ConnectionIntegrationEndpoints, ConnectionStatusSummary, describeProviderSession, disconnectConnection, getConnectionApiKey, getConnectionIntegrationEndpoints, getConnectionStatusSummary, reconnectConnection, regenerateConnectionApiKey } from '../api/connectionOperationsApi'
import { deleteConnection, disconnectInstagram, getConnection, updateConnectionName } from '../api/connectionsApi'
import { MessagesWorkspace } from '../components/MessagesWorkspace'
import { ConnectionGroups } from '../components/ConnectionGroups'
import { CoexistenceSync } from '../components/CoexistenceSync'
import { ConnectionWebhooks } from '../components/ConnectionWebhooks'
import { OperationsDiagnostics } from '../components/OperationsDiagnostics'
import { ConnectionOverview } from '../components/ConnectionOverview'
import { ConnectionSecurity } from '../components/ConnectionSecurity'
import { environment } from '@/app/config/environment'
import { completeMetaSignup, getMetaSignupConfig, type MetaSignupConfig } from '../api/metaSignupApi'
import { loadFacebookSdk, loginWithFacebook, waitForSession } from '../lib/metaEmbeddedSignup'
import { EvolutionQrRelink } from '../components/EvolutionQrRelink'
import { connectionAddress } from '../components/ConnectionCard'

type WorkspaceTab = 'general' | 'security' | 'messages' | 'groups' | 'webhooks'
const tabs: Array<{ id: WorkspaceTab; label: string }> = [{ id: 'general', label: 'General' }, { id: 'security', label: 'Seguridad' }, { id: 'messages', label: 'Mensajes' }, { id: 'groups', label: 'Grupos' }, { id: 'webhooks', label: 'Webhooks' }]

function workspaceState(connection: Connection, status: ConnectionStatusSummary | null): { label: string; tone: StatusTone } {
  if (status?.connected || connection.status.health === 'healthy') return { label: 'Operativa', tone: 'healthy' }
  if (connection.status.state === 'pending') return { label: 'Pendiente', tone: 'pending' }
  if (connection.status.state === 'connecting') return { label: 'Configurando', tone: 'configuring' }
  if (connection.status.health === 'unhealthy' || connection.status.state === 'disconnected') return { label: 'Problema crítico', tone: 'critical' }
  return { label: 'Atención requerida', tone: 'attention' }
}
type Problem = { tone: 'critical' | 'warning' | 'info'; title: string; detail: string; action?: { label: string; icon: 'relink' | 'authorize'; run: () => void } }
/** What is wrong with the connection right now and the one action that fixes it. */
export function connectionProblem(connection: Connection, status: ConnectionStatusSummary | null, actions: { relink?: () => void; authorize?: () => void }): Problem | null {
  if (actions.relink && status && !status.connected) {
    if (status.managedElsewhere) return { tone: 'info', title: 'Administrada por otro Gateway', detail: 'Esta instancia pertenece a otro entorno (por ejemplo, dev). Vinculala o desvinculala desde ese Gateway.' }
    if (status.state === 'connecting' && !status.providerSession) return null
    return { tone: 'critical', title: 'WhatsApp sin sesión', detail: describeProviderSession(status.providerSession) || 'El número no está vinculado: no recibe ni envía mensajes hasta escanear un QR nuevo.', action: { label: 'Volver a vincular', icon: 'relink', run: actions.relink } }
  }
  const readiness = connection.readiness
  if (actions.authorize && readiness) {
    const authorize = (label: string) => ({ label, icon: 'authorize' as const, run: actions.authorize! })
    if (readiness.state === 'expired' || readiness.state === 'credential_missing') return { tone: 'critical', title: 'Instagram sin autorización', detail: 'El acceso a la cuenta venció: no se reciben ni envían mensajes hasta reautorizarla.', action: authorize('Reautorizar') }
    if (readiness.state === 'oauth_pending') return { tone: 'warning', title: 'Falta autorizar la cuenta', detail: 'Conectá la cuenta de Instagram para empezar a recibir mensajes.', action: authorize('Autorizar') }
    if (readiness.state === 'missing_scopes') return { tone: 'warning', title: 'Faltan permisos de Instagram', detail: `La autorización no incluye: ${(readiness.missingScopes || []).join(', ')}. Reautorizá aceptando todos los permisos.`, action: authorize('Reautorizar') }
    if (readiness.tokenExpiry === 'expiring') return { tone: 'warning', title: 'Autorización por vencer', detail: 'El acceso a Instagram vence en menos de 7 días y no se pudo renovar solo.', action: authorize('Reautorizar') }
  }
  return null
}
const oauthNotice: Record<string, { tone: 'success' | 'error' | 'warning'; message: string }> = {
  success: { tone: 'success', message: 'Instagram quedó autorizado nuevamente.' },
  cancelled: { tone: 'warning', message: 'La autorización de Instagram se canceló. La conexión no cambió.' },
  failed: { tone: 'error', message: 'No se pudo reautorizar Instagram. Revisá el diagnóstico e intentá de nuevo.' },
}

function signupErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : ''
  if (message === 'signup_cancelled') return 'La autorización de Meta se canceló. La conexión no cambió.'
  if (message === 'signup_timeout') return 'La autorización de Meta tardó demasiado. Intentá nuevamente.'
  if (message === 'signup_unavailable') return 'No pudimos abrir la autorización de Meta. Revisá tu conexión e intentá nuevamente.'
  if (message === 'signup_incomplete') return 'La autorización de Meta no pudo completarse. Intentá nuevamente.'
  return message || 'No se pudo reautorizar la cuenta de WhatsApp.'
}

function dateTime(value: string | null | undefined, fallback = 'Sin actividad registrada'): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ConnectionDetailPage() {
  const navigate = useNavigate(); const location = useLocation(); const { connectionId } = useParams()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [integrationEndpoints, setIntegrationEndpoints] = useState<ConnectionIntegrationEndpoints | null>(null)
  const [apiKey, setApiKey] = useState<ConnectionApiKey | null>(null)
  const [statusSummary, setStatusSummary] = useState<ConnectionStatusSummary | null>(null)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('general')
  const [isLoading, setIsLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null)
  const [isEditingName, setIsEditingName] = useState(false); const [name, setName] = useState(''); const [isSaving, setIsSaving] = useState(false)
  const [showKey, setShowKey] = useState(false); const [isDeleting, setIsDeleting] = useState(false); const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false); const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false); const [isProviderDisconnectOpen, setIsProviderDisconnectOpen] = useState(false)
  const [isQrRelinkOpen, setIsQrRelinkOpen] = useState(false)
  const [isUnlinkOpen, setIsUnlinkOpen] = useState(false)
  const [isUnlinking, setIsUnlinking] = useState(false)
  const [metaSignupConfig, setMetaSignupConfig] = useState<MetaSignupConfig | null>(null); const [isReauthorizing, setIsReauthorizing] = useState(false)
  const [oauthToast, setOauthToast] = useState<{ tone: 'success' | 'error' | 'warning'; message: string } | null>(null)

  const loadConnection = useCallback(async () => {
    if (!connectionId) return
    setError(null)
    try {
      const loaded = await getConnection(connectionId)
      setConnection(loaded); setName(loaded.name)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo cargar la conexión.') } finally { setIsLoading(false) }
  }, [connectionId, navigate])
  const loadOperations = useCallback(async () => {
    if (!connectionId) return
    try {
      const [nextApiKey, nextStatus, nextEndpoints] = await Promise.all([getConnectionApiKey(connectionId), getConnectionStatusSummary(connectionId), getConnectionIntegrationEndpoints(connectionId)])
      setApiKey(nextApiKey); setStatusSummary(nextStatus); setIntegrationEndpoints(nextEndpoints)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo cargar la operación de la conexión.') }
  }, [connectionId])
  useEffect(() => { void loadConnection() }, [loadConnection])
  useEffect(() => { if (connection) void loadOperations() }, [connection, loadOperations])
  useEffect(() => {
    if (location.pathname.endsWith('/webhooks')) setActiveTab('webhooks')
    else { const requested = new URLSearchParams(location.search).get('tab'); setActiveTab(tabs.some((tab) => tab.id === requested) ? requested as WorkspaceTab : 'general') }
  }, [location.pathname, location.search])

  // Resultado del OAuth de Instagram: el Gateway vuelve a esta página con ?oauth=<resultado>.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const outcome = params.get('oauth')
    if (!outcome) return
    setOauthToast(oauthNotice[outcome] || oauthNotice.failed)
    params.delete('oauth')
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true })
  }, [location.pathname, location.search, navigate])
  const isMetaWhatsapp = connection?.provider.id === 'meta' && connection.channel.id === 'whatsapp'
  // FB.login tiene que llamarse sincrónicamente en el click, así que el SDK se precarga.
  useEffect(() => {
    if (!isMetaWhatsapp) return
    let active = true
    void getMetaSignupConfig().then(async (config) => {
      if (!active || !config.enabled || !config.app_id || !config.config_id) return
      await loadFacebookSdk(config.app_id, config.graph_version)
      if (active) setMetaSignupConfig(config)
    }).catch(() => undefined)
    return () => { active = false }
  }, [isMetaWhatsapp])

  async function refreshWorkspace() { await loadConnection(); await loadOperations() }
  async function saveName(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!connection) return; setError(null); setIsSaving(true); try { setConnection(await updateConnectionName(connection.id, name)); setIsEditingName(false) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la conexión.') } finally { setIsSaving(false) } }
  async function regenerateKey() { if (!connection) return; setError(null); try { const updated = await regenerateConnectionApiKey(connection.id); setApiKey(updated); setShowKey(true); setNotice('Nueva API Key generada. Podés mostrarla o copiarla cuando la necesites.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo regenerar la API Key.') } }
  async function revealKey() { if (!connection) return null; if (apiKey?.apiKey) return apiKey.apiKey; try { const updated = await getConnectionApiKey(connection.id, true); setApiKey(updated); return updated.apiKey || null } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo mostrar la API Key.'); return null } }
  async function toggleKeyVisibility() { if (showKey) { setShowKey(false); return }; if (await revealKey()) setShowKey(true) }
  async function copyKey() { const value = apiKey?.apiKey || await revealKey(); if (!value) return; try { await navigator.clipboard.writeText(value); setNotice('API Key copiada.') } catch { setError('No se pudo copiar la API Key.') } }
  async function copyIntegrationUrl(url: string) { try { await navigator.clipboard.writeText(url); setNotice('URL de envío copiada.') } catch { setError('No se pudo copiar la URL de envío.') } }
  async function reconnect() { if (!connection) return; setError(null); try { await reconnectConnection(connection.id); await refreshWorkspace() } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo iniciar la reconexión.') } }
  async function removeConnection() { if (!connection) return; setError(null); setIsDeleting(true); try { await deleteConnection(connection.id); navigate(`/clients/${connection.clientId}`) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo eliminar la conexión.') } finally { setIsDeleting(false) } }
  function authorizeInstagram() { if (!connection) return; const url = new URL('/connections/meta/instagram/authorize', environment.gatewayUrl || window.location.origin); url.searchParams.set('connection_id', connection.id); url.searchParams.set('ui_return', 'true'); window.location.assign(url.toString()) }
  function reauthorizeWhatsapp() {
    if (!connection) return
    if (!metaSignupConfig?.config_id || !window.FB) { setError('La autorización de Meta todavía se está preparando. Esperá un instante e intentá de nuevo.'); return }
    setError(null); setIsReauthorizing(true)
    const signupAbort = new AbortController()
    const sessionPromise = waitForSession(signupAbort.signal)
    const codePromise = loginWithFacebook(metaSignupConfig.config_id)
    void (async () => {
      try {
        const [code, session] = await Promise.all([codePromise, sessionPromise])
        await completeMetaSignup({ connectionId: connection.id }, code, session, metaSignupConfig.supports_coexistence)
        await refreshWorkspace()
        setNotice('La cuenta de WhatsApp quedó autorizada nuevamente.')
      } catch (reason) { setError(signupErrorMessage(reason)) } finally { signupAbort.abort(); setIsReauthorizing(false) }
    })()
  }
  function handleQrLinked() {
    setNotice('WhatsApp quedó vinculado nuevamente.')
    void refreshWorkspace()
    window.setTimeout(() => setIsQrRelinkOpen(false), 1500)
  }
  async function unlinkWhatsapp() { if (!connection) return; setIsUnlinking(true); try { await disconnectConnection(connection.id); setIsUnlinkOpen(false); setIsQrRelinkOpen(true); void refreshWorkspace() } catch (reason) { setIsUnlinkOpen(false); setError(reason instanceof Error ? reason.message : 'No se pudo desconectar la sesión.') } finally { setIsUnlinking(false) } }
  async function disconnectProvider() { if (!connection || connection.channel.id !== 'instagram' || connection.provider.id !== 'meta') return; setIsDisconnecting(true); try { setConnection(await disconnectInstagram(connection.id)); setNotice('La cuenta fue desconectada.') } catch { setError('No se pudo desconectar la cuenta.') } finally { setIsDisconnecting(false) } }

  if (isLoading) return <LoadingState label="Cargando conexión…" />
  if (!connection) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'Conexión no encontrada.'}</p><button type="button" onClick={() => void loadConnection()}>Reintentar</button></div>
  const displayedKey = showKey && apiKey?.apiKey ? apiKey.apiKey : apiKey?.maskedApiKey
  const headerState = workspaceState(connection, statusSummary)
  const messageId = new URLSearchParams(location.search).get('message_id')
  const isEvolution = connection.provider.id === 'evolution'
  const isInstagram = connection.channel.id === 'instagram' && connection.provider.id === 'meta'
  const problem = connectionProblem(connection, statusSummary, {
    relink: isEvolution ? () => setIsUnlinkOpen(true) : undefined,
    authorize: isInstagram ? authorizeInstagram : undefined,
  })
  const isConnected = Boolean(statusSummary?.connected) || connection.status.state === 'connected'
  // Cada proveedor se recupera distinto: Instagram re-hace OAuth, WhatsApp Cloud repite Embedded Signup y Evolution re-escanea el QR.
  const authorization = connection.channel.id === 'instagram' && connection.provider.id === 'meta'
    ? { onAuthorize: authorizeInstagram }
    : isMetaWhatsapp
      ? { onAuthorize: reauthorizeWhatsapp, authorizeLabel: 'Reautorizar con Meta', isAuthorizing: isReauthorizing }
      : isEvolution && !isConnected
        ? { onAuthorize: () => setIsQrRelinkOpen(true), authorizeLabel: 'Vincular con QR' }
        : {}

  return <section className="connection-detail workspace-detail">
    <header className="workspace-header"><button type="button" className="client-back-link" onClick={() => navigate(`/clients/${connection.clientId}`)}><ArrowLeft size={16} aria-hidden="true" /> {connection.client?.name || 'Cliente'}</button><div className="workspace-header-main"><div><StatusBadge tone={headerState.tone}>{headerState.label}</StatusBadge><h2>{connection.name}</h2><p>{[connection.client?.name || 'Cliente', connection.displayName !== connection.name ? connection.displayName : null, connectionAddress(connection.address), `${connection.channel.displayName} · ${connection.provider.displayName}`].filter(Boolean).join(' · ')}</p></div><div className="workspace-header-actions"><button type="button" className="client-button-secondary" onClick={() => void refreshWorkspace()}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></div></div></header>
    {problem ? <div className={`workspace-problem is-${problem.tone}`} role={problem.tone === 'info' ? 'status' : 'alert'}>{problem.tone === 'info' ? <Info size={20} aria-hidden="true" /> : <AlertTriangle size={20} aria-hidden="true" />}<div><strong>{problem.title}</strong><p>{problem.detail}</p></div>{problem.action ? <button type="button" className="client-button-primary" onClick={problem.action.run}>{problem.action.icon === 'relink' ? <Link2 size={15} aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />} {problem.action.label}</button> : null}</div> : null}
    <div className="workspace-tabs" role="tablist" aria-label="Secciones del Workspace">{tabs.filter((tab) => tab.id !== 'groups' || (connection.provider.id === 'evolution' && connection.channel.id === 'whatsapp')).map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => navigate(tab.id === 'webhooks' ? `/connections/${connection.id}/webhooks` : `/connections/${connection.id}${tab.id === 'general' ? '' : `?tab=${tab.id}`}`)}>{tab.label}</button>)}</div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} /><Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />
    <div className="workspace-tab-content">
      {activeTab === 'webhooks' ? <ConnectionWebhooks connection={connection} /> : null}
      {activeTab === 'general' ? <>
        {isEditingName ? <form className="connection-name-form" onSubmit={saveName}><Field label="Nombre" required><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required autoFocus /></Field><div><button type="button" className="client-button-secondary" onClick={() => { setName(connection.name); setIsEditingName(false) }}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSaving}>{isSaving ? 'Guardando…' : 'Guardar'}</button></div></form> : null}
        <section className="connection-section workspace-general-info"><div className="connection-section-heading"><h3>Información general</h3><button type="button" className="client-button-secondary" onClick={() => setIsEditingName((value) => !value)}><Pencil size={15} aria-hidden="true" /> Editar nombre</button></div><dl className="connection-information-list"><div><dt>Cliente</dt><dd>{connection.client?.name || 'No disponible'}</dd></div><div><dt>Canal</dt><dd>{connection.channel.displayName}</dd></div><div><dt>Provider</dt><dd>{connection.provider.displayName}</dd></div><div><dt>Estado</dt><dd><StatusBadge tone={headerState.tone}>{headerState.label}</StatusBadge></dd></div><div><dt>Última actividad</dt><dd>{dateTime(statusSummary?.lastActivityAt || connection.lastActivityAt)}</dd></div></dl></section>
        <section className="connection-section connection-integration-section"><div className="connection-section-heading"><div><h3>Integración con tu bot</h3><p>Usá esta URL para que tu bot solicite el envío de mensajes por esta conexión.</p></div></div><div className="connection-endpoint"><span>API de envío</span><code>{integrationEndpoints?.messageApiUrl || 'No disponible'}</code>{integrationEndpoints ? <button type="button" className="client-button-secondary" onClick={() => void copyIntegrationUrl(integrationEndpoints.messageApiUrl)}><Clipboard size={15} aria-hidden="true" /> Copiar</button> : null}</div><p className="connection-endpoint-note">Método POST · requiere autenticación del Gateway · esta URL no incluye claves.</p></section>
        <OperationsDiagnostics connectionId={connection.id} providerId={connection.provider.id} onReconnect={reconnect} onRefreshConnection={refreshWorkspace} onManageWebhooks={() => navigate(`/connections/${connection.id}/webhooks`)} onRelinkQr={isEvolution ? () => setIsQrRelinkOpen(true) : undefined} onUnlink={isEvolution ? () => setIsUnlinkOpen(true) : undefined} />
        {connection.provider.id === 'meta' && connection.channel.id === 'whatsapp' ? <CoexistenceSync connectionId={connection.id} /> : null}
        <ConnectionOverview connection={connection} onRefresh={() => void refreshWorkspace()} {...authorization} onDisconnect={connection.channel.id === 'instagram' && connection.provider.id === 'meta' ? () => setIsProviderDisconnectOpen(true) : undefined} />
        <section className="connection-section"><h3>Administración</h3><div className="connection-inline-actions"><button type="button" className="client-button-danger" onClick={() => setIsDeleteDialogOpen(true)} disabled={isDeleting}><Trash2 size={15} aria-hidden="true" /> Eliminar conexión</button></div></section>
      </> : null}
      {activeTab === 'security' ? <><ConnectionSecurity connection={connection} onAuthorize={connection.channel.id === 'instagram' && connection.provider.id === 'meta' ? authorizeInstagram : undefined} /><section className="connection-section workspace-security"><div className="connection-section-heading"><div><h3>API Key</h3><p>{apiKey?.enabled && apiKey.hasApiKey ? 'Activa' : 'Sin API Key activa'}</p></div></div><dl className="connection-information-list"><div><dt>Estado</dt><dd>{apiKey?.enabled && apiKey.hasApiKey ? 'Activa' : 'Sin API Key activa'}</dd></div><div><dt>API Key</dt><dd className="connection-key-value">{displayedKey || 'No hay una API Key disponible'}</dd></div></dl>{apiKey?.hasApiKey && !apiKey.canRevealApiKey ? <p className="connection-endpoint-note">Esta clave fue creada antes de habilitar la visualización. Regenerala una vez para poder mostrarla y copiarla luego.</p> : null}<div className="connection-inline-actions">{apiKey?.canRevealApiKey ? <button type="button" className="client-button-secondary" onClick={() => void toggleKeyVisibility()}>{showKey ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}{showKey ? 'Ocultar' : 'Mostrar'}</button> : null}<button type="button" className="client-button-secondary" onClick={() => void copyKey()} disabled={!apiKey?.canRevealApiKey && !apiKey?.apiKey}><Clipboard size={15} aria-hidden="true" /> Copiar</button><button type="button" className="client-button-secondary" onClick={() => setIsRegenerateDialogOpen(true)}>Regenerar</button></div></section></> : null}
      {activeTab === 'messages' ? <MessagesWorkspace connectionId={connection.id} messageId={messageId} /> : null}
      {activeTab === 'groups' ? <ConnectionGroups connectionId={connection.id} /> : null}
    </div>
    <Toast message={oauthToast?.message || null} tone={oauthToast?.tone} onDismiss={() => setOauthToast(null)} />
    {isQrRelinkOpen ? <EvolutionQrRelink connectionId={connection.id} onClose={() => setIsQrRelinkOpen(false)} onLinked={handleQrLinked} /> : null}
    <ConfirmDialog isOpen={isDeleteDialogOpen} title="Eliminar conexión" description="Esta acción eliminará la conexión y su acceso al Workspace." confirmLabel="Eliminar conexión" isSubmitting={isDeleting} onCancel={() => setIsDeleteDialogOpen(false)} onConfirm={() => void removeConnection()} />
    <ConfirmDialog isOpen={isRegenerateDialogOpen} title="Regenerar API Key" description="La API Key actual dejará de ser válida. Asegurate de copiar la nueva clave al finalizar." confirmLabel="Regenerar API Key" tone="default" onCancel={() => setIsRegenerateDialogOpen(false)} onConfirm={() => { setIsRegenerateDialogOpen(false); void regenerateKey() }} />
    <ConfirmDialog isOpen={isUnlinkOpen} title="Desconectar WhatsApp" description="Se desvincula este dispositivo de WhatsApp y el canal deja de recibir y enviar mensajes hasta que escanees un QR nuevo. Si la sesión estaba rota, la instancia se recrea con el mismo nombre: la configuración y el canal de Botly se conservan, pero el historial guardado en el proveedor se pierde (lo ya importado a Botly queda)." confirmLabel="Desconectar y mostrar QR" submittingLabel="Desconectando…" isSubmitting={isUnlinking} onCancel={() => { if (!isUnlinking) setIsUnlinkOpen(false) }} onConfirm={() => void unlinkWhatsapp()} />
    <ConfirmDialog isOpen={isProviderDisconnectOpen} title="Desconectar cuenta" description="La cuenta dejara de recibir y enviar mensajes hasta que la conectes nuevamente." confirmLabel="Desconectar" isSubmitting={isDisconnecting} onCancel={() => { if (!isDisconnecting) setIsProviderDisconnectOpen(false) }} onConfirm={() => { setIsProviderDisconnectOpen(false); void disconnectProvider() }} />
  </section>
}
