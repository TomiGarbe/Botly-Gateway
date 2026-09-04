import { CheckCircle2, CircleAlert, Instagram, LoaderCircle, RefreshCw, Unplug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Connection, InstagramReadiness } from '@/domain/connection'
import { environment } from '@/app/config/environment'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { StatusBadge } from '@/shared/components/StatusBadge'
import { Toast } from '@/shared/components/Toast'
import { bindInstagramCoreChannel, disconnectInstagram, getInstagramReadiness, listInstagramCoreChannels, type CoreChannelOption } from '../api/connectionsApi'

function startAuthorize(connectionId: string) {
  const url = new URL('/connections/meta/instagram/authorize', environment.gatewayUrl || window.location.origin)
  url.searchParams.set('connection_id', connectionId); url.searchParams.set('ui_return', 'true')
  window.location.assign(url.toString())
}

function readinessCopy(readiness: InstagramReadiness | null): { label: string; tone: 'healthy' | 'attention' | 'pending' } {
  if (!readiness) return { label: 'Sin verificar', tone: 'pending' }
  if (readiness.ready) return { label: 'Ready', tone: 'healthy' }
  return { label: readiness.state === 'oauth_pending' ? 'Conexión pendiente' : 'Configuración pendiente', tone: 'attention' }
}

export function InstagramConnectionPanel({ connection, onConnectionChange }: { connection: Connection; onConnectionChange: (connection: Connection) => void }) {
  const [readiness, setReadiness] = useState<InstagramReadiness | null>(connection.readiness)
  const [channels, setChannels] = useState<CoreChannelOption[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)
  const [isBinding, setIsBinding] = useState(false)
  const [isDisconnectOpen, setIsDisconnectOpen] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setIsRefreshing(true); setError(null)
    try { setReadiness(await getInstagramReadiness(connection.id)) } catch { setError('No se pudo actualizar el estado de Instagram.') } finally { setIsRefreshing(false) }
  }, [connection.id])
  useEffect(() => { void refresh() }, [refresh])

  async function loadChannels() {
    setIsLoadingChannels(true); setError(null)
    try { const items = await listInstagramCoreChannels(connection.id); setChannels(items); setSelectedChannelId((current) => current || items[0]?.id || '') }
    catch { setError('No se pudieron cargar los canales de Botly. Revisá la configuración e intentá nuevamente.') }
    finally { setIsLoadingChannels(false) }
  }
  async function bindChannel() {
    if (!selectedChannelId || isBinding) return
    setIsBinding(true); setError(null)
    try { const updated = await bindInstagramCoreChannel(connection.id, selectedChannelId); onConnectionChange(updated); setNotice('Canal de Botly vinculado correctamente.') }
    catch { setError('No se pudo vincular el canal seleccionado. Intentá nuevamente.') }
    finally { setIsBinding(false) }
  }
  async function disconnect() {
    setIsDisconnecting(true); setError(null)
    try { const updated = await disconnectInstagram(connection.id); onConnectionChange(updated); setReadiness(updated.readiness); setNotice('La cuenta de Instagram fue desconectada.') }
    catch { setError('No se pudo desconectar Instagram. Intentá nuevamente.') }
    finally { setIsDisconnecting(false); setIsDisconnectOpen(false) }
  }

  const account = connection.providerAccount?.metadata || {}
  const state = readinessCopy(readiness)
  const isConnected = connection.status.state === 'connected' && !!connection.providerAccount
  return <section className="connection-section instagram-connection-panel">
    <Toast message={error} tone="error" onDismiss={() => setError(null)} />
    <Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />
    <div className="connection-section-heading"><div><div className="instagram-title"><Instagram size={20} aria-hidden="true" /><h3>Instagram</h3></div><p>{account.username ? `@${account.username}` : account.displayName || 'Cuenta profesional pendiente de conexión'}</p></div><StatusBadge tone={state.tone}>{state.label}</StatusBadge></div>
    <dl className="connection-information-list instagram-status-list"><div><dt>Cuenta</dt><dd>{isConnected ? 'Conectada' : 'No conectada'}</dd></div><div><dt>Readiness</dt><dd>{state.label}</dd></div><div><dt>Canal de Botly</dt><dd>{connection.coreChannel?.name || (connection.coreChannel?.configured ? 'Canal vinculado' : 'No vinculado')}</dd></div></dl>
    {readiness ? <ul className="instagram-readiness-list">{[
      ['Cuenta conectada', readiness.authenticated], ['Credenciales configuradas', readiness.credentialValid], ['Cuenta profesional detectada', readiness.accountDiscovered], ['Scopes requeridos', readiness.requiredScopesPresent],
    ].filter(([, value]) => value !== undefined).map(([label, value]) => <li key={String(label)}>{value ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span>{label}</span></li>)}</ul> : null}
    {!isConnected && connection.status.state !== 'disconnected' ? <button type="button" className="client-button-primary" onClick={() => startAuthorize(connection.id)}>Conectar con Instagram</button> : null}
    {isConnected && !connection.coreChannel?.configured ? <div className="instagram-channel-binding"><div><h4>Canal de Botly</h4><p>Seleccioná qué canal recibirá los mensajes de esta cuenta.</p></div>{channels.length === 0 ? <button type="button" className="client-button-secondary" disabled={isLoadingChannels} onClick={() => void loadChannels()}>{isLoadingChannels ? <><LoaderCircle className="animate-spin" size={15} /> Cargando canales…</> : 'Seleccionar canal'}</button> : <><select value={selectedChannelId} onChange={(event) => setSelectedChannelId(event.target.value)} aria-label="Canal de Botly">{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select><button type="button" className="client-button-primary" disabled={!selectedChannelId || isBinding} onClick={() => void bindChannel()}>{isBinding ? 'Vinculando canal…' : 'Vincular canal'}</button></>}</div> : null}
    <div className="connection-inline-actions"><button type="button" className="client-button-secondary" disabled={isRefreshing} onClick={() => void refresh()}><RefreshCw size={15} className={isRefreshing ? 'animate-spin' : ''} /> Actualizar estado</button>{isConnected ? <button type="button" className="client-button-danger" onClick={() => setIsDisconnectOpen(true)}><Unplug size={15} /> Desconectar</button> : null}</div>
    <ConfirmDialog isOpen={isDisconnectOpen} title="¿Desconectar esta cuenta de Instagram?" description="Se revocará el vínculo de integración y esta conexión dejará de recibir eventos. No se borrará historial de negocio." confirmLabel="Desconectar Instagram" isSubmitting={isDisconnecting} onCancel={() => setIsDisconnectOpen(false)} onConfirm={() => void disconnect()} />
  </section>
}
