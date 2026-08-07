import { ArrowLeft, BadgeCheck, CheckCircle2, LoaderCircle, MessageCircle, QrCode, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client } from '@/domain/client'
import type { Connection } from '@/domain/connection'
import { getClient } from '@/features/clients/api/clientsApi'
import { getGatewayChannels, getGatewayProviders, type GatewayChannelSettings, type GatewayProviderSettings } from '@/features/settings/api/gatewaySettingsApi'
import { LoadingState } from '@/shared/components/LoadingState'
import { getConnectionStatusSummary } from '../api/connectionOperationsApi'
import { createConnection, getConnection, getConnectionQr } from '../api/connectionsApi'
import { completeMetaSignup, getMetaSignupConfig } from '../api/metaSignupApi'

type ProviderId = 'meta' | 'evolution'
type EmbeddedSession = { phoneNumberId: string; businessAccountId: string; raw: Record<string, unknown> }
type ProvisioningStep = 'connecting' | 'authorizing' | 'creating' | 'webhook' | 'testing' | 'ready'

const provisioningSteps: Array<{ id: ProvisioningStep; label: string }> = [
  { id: 'connecting', label: 'Conectando…' },
  { id: 'authorizing', label: 'Autorizando…' },
  { id: 'creating', label: 'Creando conexión…' },
  { id: 'webhook', label: 'Configurando webhook…' },
  { id: 'testing', label: 'Probando conexión…' },
  { id: 'ready', label: 'Listo' },
]

declare global {
  interface Window {
    FB?: { init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void; login: (callback: (response: { authResponse?: { code?: string }; status?: string }) => void, options: Record<string, unknown>) => void }
    fbAsyncInit?: () => void
  }
}

function isFacebookOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))
  } catch {
    return false
  }
}

function waitForSession(): Promise<EmbeddedSession> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', listener)
      reject(new Error('signup_timeout'))
    }, 120000)
    const listener = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return
      let raw: unknown = event.data
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { return }
      }
      if (typeof raw !== 'object' || raw === null) return
      const data = raw as { type?: string; event?: string; data?: Record<string, unknown> }
      if (data.type !== 'WA_EMBEDDED_SIGNUP') return
      if (['CANCEL', 'CANCELLED', 'ERROR'].includes(String(data.event || '').toUpperCase())) {
        window.clearTimeout(timeout)
        window.removeEventListener('message', listener)
        reject(new Error('signup_cancelled'))
        return
      }
      const payload: Record<string, unknown> = data.data || data
      const phoneNumberId = String(payload.phone_number_id || payload.phoneNumberId || '')
      const businessAccountId = String(payload.waba_id || payload.business_account_id || payload.businessAccountId || '')
      if (!phoneNumberId || !businessAccountId) return
      window.clearTimeout(timeout)
      window.removeEventListener('message', listener)
      resolve({ phoneNumberId, businessAccountId, raw: payload })
    }
    window.addEventListener('message', listener)
  })
}

async function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('signup_unavailable')), 20000)
    window.fbAsyncInit = () => {
      if (!window.FB) return
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
      window.clearTimeout(timeout)
      resolve()
    }
    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    script.onerror = () => reject(new Error('signup_unavailable'))
    document.body.appendChild(script)
  })
}

function loginWithFacebook(configId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.FB) return reject(new Error('signup_unavailable'))
    window.FB.login((response) => {
      const code = response.authResponse?.code
      if (code) resolve(code)
      else reject(new Error(response.status === 'not_authorized' ? 'signup_cancelled' : 'signup_incomplete'))
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { sessionInfoVersion: '3', featureType: 'whatsapp_business_app_onboarding' },
    })
  })
}

function qrSource(payload: { qrcode?: { base64?: string; code?: string }; base64?: string }): string | null {
  const value = payload.qrcode?.base64 || payload.base64 || payload.qrcode?.code
  if (!value) return null
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`
}

function friendlyError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : ''
  if (message === 'signup_cancelled') return 'La autorización se canceló antes de terminar. Podés intentarlo nuevamente.'
  if (message === 'signup_timeout') return 'La autorización tardó demasiado. Verificá la ventana de Meta e intentá nuevamente.'
  if (message === 'signup_unavailable') return 'No pudimos abrir la autorización de Meta. Revisá tu conexión e intentá nuevamente.'
  if (message === 'signup_incomplete') return 'La autorización no pudo completarse. Intentá nuevamente.'
  if (message.includes('configurada')) return 'La conexión oficial no está disponible en este momento. Intentá más tarde.'
  return message || 'No pudimos terminar la conexión. Podés reintentar sin perder el avance.'
}

export function NewConnectionPage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const [client, setClient] = useState<Client | null>(null)
  const [channels, setChannels] = useState<Record<string, GatewayChannelSettings>>({})
  const [providers, setProviders] = useState<Record<string, GatewayProviderSettings>>({})
  const [connection, setConnection] = useState<Connection | null>(null)
  const [connectionName, setConnectionName] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isStarting, setIsStarting] = useState(false)
  const [step, setStep] = useState<ProvisioningStep>('connecting')

  const loadClient = useCallback(async () => {
    if (!clientId) return
    try {
      const [nextClient, nextChannels, nextProviders] = await Promise.all([getClient(clientId), getGatewayChannels(), getGatewayProviders()])
      setClient(nextClient)
      setChannels(nextChannels)
      setProviders(nextProviders)
    } catch {
      setError('No pudimos abrir este cliente. Volvé a intentarlo desde Clientes.')
    } finally {
      setIsLoading(false)
    }
  }, [clientId])

  useEffect(() => { void loadClient() }, [loadClient])

  async function loadQr(connectionId: string) {
    const payload = await getConnectionQr(connectionId)
    const nextQr = qrSource(payload)
    if (!nextQr) throw new Error('Evolution no devolvió un código QR. Actualizalo e intentá nuevamente.')
    setQr(nextQr)
  }

  async function selectProvider(provider: ProviderId) {
    if (!clientId) return
    const name = connectionName.trim()
    if (!name) {
      setError('Ingresá un nombre para la conexión.')
      return
    }
    setError(null)
    setIsStarting(true)
    try {
      const created = await createConnection({ clientId, channel: 'whatsapp', name, provider })
      setConnection(created)
      if (provider === 'evolution') await loadQr(created.id)
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setIsStarting(false)
    }
  }

  async function startMetaSignup() {
    if (!connection) return
    setError(null)
    setIsStarting(true)
    const progressTimers: number[] = []
    try {
      setStep('authorizing')
      const config = await getMetaSignupConfig()
      if (!config.enabled || !config.app_id || !config.config_id) throw new Error('configurada')
      await loadFacebookSdk(config.app_id, config.graph_version)
      const sessionPromise = waitForSession()
      const code = await loginWithFacebook(config.config_id)
      const session = await sessionPromise
      setStep('creating')
      progressTimers.push(window.setTimeout(() => setStep('webhook'), 900))
      progressTimers.push(window.setTimeout(() => setStep('testing'), 2100))
      const completed = await completeMetaSignup(connection.id, code, session, config.supports_coexistence)
      progressTimers.forEach(window.clearTimeout)
      setStep('testing')
      await getConnection(completed.id)
      await getConnectionStatusSummary(completed.id).catch(() => undefined)
      setStep('ready')
      window.setTimeout(() => navigate(`/connections/${completed.id}`, { replace: true }), 750)
    } catch (reason) {
      progressTimers.forEach(window.clearTimeout)
      setError(friendlyError(reason))
    } finally {
      setIsStarting(false)
    }
  }

  if (isLoading) return <LoadingState label="Cargando cliente…" />
  if (!client) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'Cliente no encontrado.'}</p><button type="button" onClick={() => navigate('/clients')}>Volver a clientes</button></div>

  const activeIndex = provisioningSteps.findIndex((item) => item.id === step)
  const whatsappEnabled = channels.whatsapp?.implemented && channels.whatsapp.enabled
  const metaEnabled = providers.meta?.implemented && providers.meta.enabled
  const evolutionEnabled = providers.evolution?.implemented && providers.evolution.enabled

  return <section className="new-connection-page">
    {!connection ? <button type="button" className="client-back-link" onClick={() => navigate(`/clients/${client.id}`)}><ArrowLeft size={16} aria-hidden="true" /> {client.name}</button> : null}
    <div className="new-connection-heading"><p>Agregar conexión</p><h2>{connection ? `Conectando ${connection.name}` : `Nueva conexión para ${client.name}`}</h2></div>
    {!connection ? <>
      <label className="new-connection-name"><span>Nombre de la conexión</span><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} maxLength={160} placeholder="Ej.: Ventas Argentina" autoFocus /></label>
      <div className="channel-selection">
        {whatsappEnabled && metaEnabled ? <button type="button" className="channel-card channel-card-active" onClick={() => void selectProvider('meta')} disabled={isStarting}><BadgeCheck size={20} aria-hidden="true" /><span><strong>WhatsApp oficial con Meta</strong><small>Conectá una cuenta de WhatsApp Business mediante Meta.</small></span></button> : null}
        {whatsappEnabled && evolutionEnabled ? <button type="button" className="channel-card channel-card-active" onClick={() => void selectProvider('evolution')} disabled={isStarting}><QrCode size={20} aria-hidden="true" /><span><strong>WhatsApp con Evolution</strong><small>Conectá WhatsApp Web escaneando un código QR.</small></span></button> : null}
        {!whatsappEnabled || (!metaEnabled && !evolutionEnabled) ? <div className="channel-card channel-card-disabled"><MessageCircle size={20} aria-hidden="true" /><span><strong>WhatsApp</strong><small>Habilitá el canal y al menos un proveedor desde Configuración.</small></span></div> : null}
      </div>
    </> : connection.provider.id === 'evolution' ? <div className="connection-provisioning evolution-qr-panel">
      <h3>Escaneá el código QR</h3><p>Abrí WhatsApp en el teléfono y vinculá un dispositivo para terminar la conexión.</p>
      {qr ? <img src={qr} alt="Código QR para conectar WhatsApp con Evolution" /> : <LoaderCircle size={28} className="animate-spin" aria-label="Cargando código QR" />}
      <div className="evolution-qr-actions"><button type="button" className="client-button-secondary" onClick={() => void loadQr(connection.id).catch((reason) => setError(friendlyError(reason)))} disabled={isStarting}>Actualizar código QR</button><button type="button" className="client-button-primary" onClick={() => navigate(`/connections/${connection.id}`)}>Abrir conexión</button></div>
      {error ? <div className="provisioning-error" role="alert"><p>{error}</p></div> : null}
    </div> : <div className="connection-provisioning">
      <ol>{provisioningSteps.map((item, index) => <li key={item.id} className={index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-active' : ''}>{index < activeIndex || step === 'ready' ? <CheckCircle2 size={17} aria-hidden="true" /> : index === activeIndex ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <span aria-hidden="true" />}{item.label}</li>)}</ol>
      {!isStarting && step === 'connecting' && !error ? <button type="button" className="client-button-primary" onClick={() => void startMetaSignup()}>Continuar con WhatsApp</button> : null}
      {error ? <div className="provisioning-error" role="alert"><p>{error}</p><button type="button" className="client-button-primary" onClick={() => void startMetaSignup()} disabled={isStarting}><RotateCcw size={15} aria-hidden="true" /> Reintentar</button></div> : null}
    </div>}
    {error && !connection ? <p className="client-form-error" role="alert">{error}</p> : null}
  </section>
}
