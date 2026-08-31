import { ArrowLeft, BadgeCheck, CheckCircle2, LoaderCircle, MessageCircle, QrCode, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client } from '@/domain/client'
import { getClient } from '@/features/clients/api/clientsApi'
import { getGatewayChannels, getGatewayProviders, type GatewayChannelSettings, type GatewayProviderSettings } from '@/features/settings/api/gatewaySettingsApi'
import { LoadingState } from '@/shared/components/LoadingState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { getConnectionStatusSummary } from '../api/connectionOperationsApi'
import { getConnection } from '../api/connectionsApi'
import { cancelConnectionSetup, createConnectionSetup, getConnectionSetup, getConnectionSetupQr, type ConnectionSetup } from '../api/connectionSetupsApi'
import { completeMetaSignup, getMetaSignupConfig, type MetaSignupConfig } from '../api/metaSignupApi'
import { gatewayRequest } from '@/shared/lib/gatewayClient'
import { useAuth } from '@/app/providers/AuthProvider'

type ProviderId = 'meta' | 'evolution'
type EmbeddedSession = { phoneNumberId?: string; businessAccountId: string; raw: Record<string, unknown> }
type ProvisioningStep = 'connecting' | 'authorizing' | 'creating' | 'webhook' | 'testing' | 'ready'

let facebookSdkPromise: Promise<void> | null = null

const provisioningSteps: Array<{ id: ProvisioningStep; label: string }> = [
  { id: 'connecting', label: 'Conectando…' },
  { id: 'authorizing', label: 'Autorizando…' },
  { id: 'creating', label: 'Creando conexión…' },
  { id: 'webhook', label: 'Configurando webhook…' },
  { id: 'testing', label: 'Probando conexión…' },
  { id: 'ready', label: 'Listo' },
]

const setupStateLabel: Record<string, string> = {
  draft: 'Preparando', onboarding: 'Configurando', provisioning: 'Conectando', ready: 'Completado',
  failed: 'Error', cancelled: 'Cancelado', cleanup_pending: 'Requiere limpieza', expired: 'Configuración expirada',
}

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

function waitForSession(signal: AbortSignal): Promise<EmbeddedSession> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { session?: EmbeddedSession; error?: Error }) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.removeEventListener('message', listener)
      signal.removeEventListener('abort', abort)
      if (result.error) reject(result.error)
      else if (result.session) resolve(result.session)
    }
    const timeout = window.setTimeout(() => {
      finish({ error: new Error('signup_timeout') })
    }, 120000)
    const abort = () => finish({ error: new Error('signup_cancelled') })
    const listener = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return
      let raw: unknown = event.data
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw) } catch { return }
      }
      if (typeof raw !== 'object' || raw === null) return
      const data = raw as { type?: string; event?: string; version?: unknown; data?: Record<string, unknown> }
      if (data.type !== 'WA_EMBEDDED_SIGNUP') return
      if (['CANCEL', 'CANCELLED', 'ERROR'].includes(String(data.event || '').toUpperCase())) {
        finish({ error: new Error('signup_cancelled') })
        return
      }
      if (!['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(String(data.event || '').toUpperCase())) return
      const payload: Record<string, unknown> = data.data || data
      const phoneNumberId = String(payload.phone_number_id || payload.phoneNumberId || '')
      const businessAccountId = String(payload.waba_id || payload.business_account_id || payload.businessAccountId || '')
      // Coexistence completion can provide the WABA without a phone ID.  The
      // Gateway resolves one unambiguous phone through Graph after exchanging
      // the OAuth code; do not discard this valid completion event.
      if (!businessAccountId) return
      finish({ session: {
        ...(phoneNumberId ? { phoneNumberId } : {}),
        businessAccountId,
        raw: { ...payload, event: String(data.event || ''), version: data.version },
      } })
    }
    window.addEventListener('message', listener)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
    return
  }
  if (!facebookSdkPromise) {
    facebookSdkPromise = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        facebookSdkPromise = null
        reject(new Error('signup_unavailable'))
      }, 20000)
      window.fbAsyncInit = () => {
        if (!window.FB) return
        window.clearTimeout(timeout)
        resolve()
      }
      const script = document.getElementById('facebook-jssdk') as HTMLScriptElement | null
      if (script) {
        script.addEventListener('error', () => reject(new Error('signup_unavailable')), { once: true })
        return
      }
      const nextScript = document.createElement('script')
      nextScript.id = 'facebook-jssdk'
      nextScript.src = 'https://connect.facebook.net/en_US/sdk.js'
      nextScript.async = true
      nextScript.defer = true
      nextScript.onerror = () => {
        facebookSdkPromise = null
        reject(new Error('signup_unavailable'))
      }
      document.body.appendChild(nextScript)
    })
  }
  await facebookSdkPromise
  const facebook = window.FB as { init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void } | undefined
  if (!facebook) throw new Error('signup_unavailable')
  facebook.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
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
  return 'No pudimos terminar la conexión. Podés reintentar sin perder el avance.'
}

export function NewConnectionPage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const [client, setClient] = useState<Client | null>(null)
  const [channels, setChannels] = useState<Record<string, GatewayChannelSettings>>({})
  const [providers, setProviders] = useState<Record<string, GatewayProviderSettings>>({})
  const [setup, setSetup] = useState<ConnectionSetup | null>(null)
  const [connectionName, setConnectionName] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isStarting, setIsStarting] = useState(false)
  const [step, setStep] = useState<ProvisioningStep>('connecting')
  const [registrationPin, setRegistrationPin] = useState('')
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [metaSignupConfig, setMetaSignupConfig] = useState<MetaSignupConfig | null>(null)
  const [isMetaSdkLoading, setIsMetaSdkLoading] = useState(false)
  const { user } = useAuth()

  const loadClient = useCallback(async () => {
    if (!clientId) return
    try {
      const reviewerCatalog = user?.role === 'meta_reviewer'
        ? gatewayRequest<{ items: Array<{ id: string; methods: Array<{ id: string }> }> }>('/channels/')
        : null
      const [nextClient, nextChannels, nextProviders, catalog] = await Promise.all([getClient(clientId), reviewerCatalog ? Promise.resolve({}) : getGatewayChannels(), reviewerCatalog ? Promise.resolve({}) : getGatewayProviders(), reviewerCatalog || Promise.resolve(null)])
      setClient(nextClient)
      if (catalog) {
        const whatsapp = catalog.items.find((item) => item.id === 'whatsapp')
        setChannels({ whatsapp: { name: 'WhatsApp', description: '', icon: 'message-circle', implemented: true, enabled: Boolean(whatsapp) } })
        setProviders({
          meta: { name: 'Meta', description: '', icon: 'server', implemented: true, enabled: Boolean(whatsapp?.methods.some((method) => method.id === 'official')) },
          evolution: { name: 'Evolution', description: '', icon: 'server', implemented: true, enabled: Boolean(whatsapp?.methods.some((method) => method.id === 'web')) },
        })
      } else { setChannels(nextChannels); setProviders(nextProviders) }
    } catch {
      setError('No pudimos abrir este cliente. Volvé a intentarlo desde Clientes.')
    } finally {
      setIsLoading(false)
    }
  }, [clientId, user?.role])

  useEffect(() => { void loadClient() }, [loadClient])

  const storageKey = clientId ? `botly.connection-setup.${clientId}` : ''

  useEffect(() => {
    if (!storageKey) return
    const setupId = sessionStorage.getItem(storageKey)
    if (!setupId) return
    void getConnectionSetup(setupId).then((saved) => {
      if (saved.state === 'ready' && saved.connectionId) {
        sessionStorage.removeItem(storageKey)
        navigate(`/connections/${saved.connectionId}`, { replace: true })
        return
      }
      if (!['cancelled', 'expired'].includes(saved.state)) setSetup(saved)
      else sessionStorage.removeItem(storageKey)
    }).catch(() => sessionStorage.removeItem(storageKey))
  }, [navigate, storageKey])

  useEffect(() => {
    if (!setup || ['ready', 'cancelled', 'expired'].includes(setup.state)) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [setup])

  useEffect(() => {
    if (setup?.provider !== 'meta' || setup.state !== 'onboarding') return
    let active = true
    setIsMetaSdkLoading(true)
    void getMetaSignupConfig()
      .then(async (config) => {
        if (!config.enabled || !config.app_id || !config.config_id) throw new Error('configurada')
        await loadFacebookSdk(config.app_id, config.graph_version)
        if (active) setMetaSignupConfig(config)
      })
      .catch((reason) => { if (active) setError(friendlyError(reason)) })
      .finally(() => { if (active) setIsMetaSdkLoading(false) })
    return () => { active = false }
  }, [setup?.id, setup?.provider, setup?.state])

  async function loadQr(setupId: string) {
    const payload = await getConnectionSetupQr(setupId)
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
      const created = await createConnectionSetup({ clientId, channel: 'whatsapp', name, provider })
      setSetup(created)
      sessionStorage.setItem(`botly.connection-setup.${clientId}`, created.id)
      if (provider === 'evolution') await loadQr(created.id)
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setIsStarting(false)
    }
  }

  async function cancelSetup() {
    if (!setup) return
    setIsCancelling(true)
    try {
      const cancelled = await cancelConnectionSetup(setup.id)
      sessionStorage.removeItem(storageKey)
      setSetup(cancelled)
      setIsCancelDialogOpen(false)
      if (cancelled.state === 'cleanup_pending') {
        setNotice('El proceso fue cancelado. No se creó una conexión operativa; quedaron recursos pendientes de limpieza.')
      } else {
        navigate(`/clients/${clientId}`, { replace: true })
      }
    } catch (reason) {
      if (reason instanceof Error && reason.message) {
        setError(reason.message)
        return
      }
      setError('No pudimos cancelar la configuración. Podés reintentar o continuar configurando.')
    } finally { setIsCancelling(false) }
  }

  function startMetaSignup() {
    if (!setup) return
    if (!metaSignupConfig || !window.FB) {
      setError('La autorizacion de Meta se esta preparando. Espera un instante e intentalo nuevamente.')
      return
    }
    setError(null)
    setIsStarting(true)
    const progressTimers: number[] = []
    setStep('authorizing')
    // FB.login must be called before any await so the popup remains directly
    // user initiated. The SDK and configuration are preloaded by the setup UI.
    const signupAbort = new AbortController()
    const sessionPromise = waitForSession(signupAbort.signal)
    const codePromise = loginWithFacebook(metaSignupConfig.config_id!)
    void (async () => {
      try {
      const [code, session] = await Promise.all([codePromise, sessionPromise])
      setStep('creating')
      progressTimers.push(window.setTimeout(() => setStep('webhook'), 900))
      progressTimers.push(window.setTimeout(() => setStep('testing'), 2100))
      // The provider request may take time. Keep cancellation available while
      // the setup is in provisioning; the backend prevents any later promote.
      setIsStarting(false)
      const completed = await completeMetaSignup(setup.id, code, session, metaSignupConfig.supports_coexistence, registrationPin)
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
      signupAbort.abort()
      setIsStarting(false)
    }
    })()
  }

  if (isLoading) return <LoadingState label="Cargando cliente…" />
  if (!client) return <div className="clients-state clients-state-error" role="alert"><p>{error || 'Cliente no encontrado.'}</p><button type="button" onClick={() => navigate('/clients')}>Volver a clientes</button></div>

  const activeIndex = provisioningSteps.findIndex((item) => item.id === step)
  const whatsappEnabled = channels.whatsapp?.implemented && channels.whatsapp.enabled
  const metaEnabled = providers.meta?.implemented && providers.meta.enabled
  const evolutionEnabled = providers.evolution?.implemented && providers.evolution.enabled
  const canRetry = Boolean(setup && ['onboarding', 'provisioning'].includes(setup.state))

  return <section className="new-connection-page">
    {!setup ? <button type="button" className="client-back-link" onClick={() => navigate(`/clients/${client.id}`)}><ArrowLeft size={16} aria-hidden="true" /> {client.name}</button> : null}
    <div className="new-connection-heading"><p>Agregar conexión</p><h2>{setup ? `Conectando ${setup.name}` : `Nueva conexión para ${client.name}`}</h2></div>
    {setup ? <div className={`connection-setup-state connection-setup-state-${setup.state}`} role="status"><strong>{setupStateLabel[setup.state] || 'Configurando'}</strong><span>{setup.state === 'cleanup_pending' ? 'No existe una conexión operativa.' : 'La conexión se agregará al inventario sólo al finalizar.'}</span></div> : null}
    {notice ? <div className="connection-setup-notice" role="status"><p>{notice}</p><button type="button" className="client-button-secondary" onClick={() => navigate(`/clients/${client.id}`, { replace: true })}>Volver a conexiones</button></div> : null}
    {!setup ? <>
      <label className="new-connection-name"><span>Nombre de la conexión</span><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} maxLength={160} placeholder="Ej.: Ventas Argentina" autoFocus /></label>
      <div className="channel-selection">
        {whatsappEnabled && metaEnabled ? <button type="button" className="channel-card channel-card-active" onClick={() => void selectProvider('meta')} disabled={isStarting}><BadgeCheck size={20} aria-hidden="true" /><span><strong>WhatsApp oficial con Meta</strong><small>Conectá una cuenta de WhatsApp Business mediante Meta.</small></span></button> : null}
        {whatsappEnabled && evolutionEnabled ? <button type="button" className="channel-card channel-card-active" onClick={() => void selectProvider('evolution')} disabled={isStarting}><QrCode size={20} aria-hidden="true" /><span><strong>WhatsApp con Evolution</strong><small>Conectá WhatsApp Web escaneando un código QR.</small></span></button> : null}
        {!whatsappEnabled || (!metaEnabled && !evolutionEnabled) ? <div className="channel-card channel-card-disabled"><MessageCircle size={20} aria-hidden="true" /><span><strong>WhatsApp</strong><small>Habilitá el canal y al menos un proveedor desde Configuración.</small></span></div> : null}
      </div>
    </> : setup.provider === 'evolution' ? <div className="connection-provisioning evolution-qr-panel">
      <h3>Escaneá el código QR</h3><p>Abrí WhatsApp en el teléfono y vinculá un dispositivo para terminar la conexión.</p>
      {qr ? <img src={qr} alt="Código QR para conectar WhatsApp con Evolution" /> : <LoaderCircle size={28} className="animate-spin" aria-label="Cargando código QR" />}
      <div className="evolution-qr-actions"><button type="button" className="client-button-secondary" onClick={() => void loadQr(setup.id).catch((reason) => setError(friendlyError(reason)))} disabled={isStarting}>Actualizar código QR</button><button type="button" className="client-button-primary" onClick={() => setup.connectionId && navigate(`/connections/${setup.connectionId}`)} disabled={!setup.connectionId}>Abrir conexión</button></div>
      {setup.state !== 'ready' ? <button type="button" className="client-button-danger" onClick={() => setIsCancelDialogOpen(true)} disabled={isStarting}>Cancelar configuración</button> : null}
      {error ? <div className="provisioning-error" role="alert"><p>{error}</p></div> : null}
    </div> : <div className="connection-provisioning">
      <ol>{provisioningSteps.map((item, index) => <li key={item.id} className={index < activeIndex ? 'is-complete' : index === activeIndex ? 'is-active' : ''}>{index < activeIndex || step === 'ready' ? <CheckCircle2 size={17} aria-hidden="true" /> : index === activeIndex ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <span aria-hidden="true" />}{item.label}</li>)}</ol>
      {!isStarting && step === 'connecting' ? <label className="new-connection-name meta-pin-field"><span>PIN de verificación en dos pasos (6 dígitos)</span><input value={registrationPin} onChange={(event) => setRegistrationPin(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" maxLength={6} placeholder="Ej.: 123456" autoComplete="off" /><small>Si tu número ya tiene verificación en dos pasos activada, ingresá ese PIN. Si no tiene, elegí uno nuevo y anotalo: va a quedar como el PIN de tu número. Dejalo vacío solo si el número nunca tuvo PIN.</small></label> : null}
      {!isStarting && step === 'connecting' && !error ? <button type="button" className="client-button-primary" onClick={startMetaSignup} disabled={isMetaSdkLoading}>{isMetaSdkLoading ? 'Preparando Meta...' : 'Conectar con Meta'}</button> : null}
      {error ? <div className="provisioning-error" role="alert"><p>{error}</p>{canRetry ? <button type="button" className="client-button-primary" onClick={() => void startMetaSignup()} disabled={isStarting}><RotateCcw size={15} aria-hidden="true" /> Reintentar</button> : null}</div> : null}
      {setup.state !== 'ready' ? <button type="button" className="client-button-danger" onClick={() => setIsCancelDialogOpen(true)} disabled={isStarting}>Cancelar configuración</button> : null}
    </div>}
    {error && !setup ? <p className="client-form-error" role="alert">{error}</p> : null}
    <ConfirmDialog isOpen={isCancelDialogOpen} title="¿Cancelar la configuración?" description="La conexión todavía no se completó. Si cancelás ahora, el setup se cerrará sin crear una conexión operativa." confirmLabel="Cancelar configuración" isSubmitting={isCancelling} onCancel={() => setIsCancelDialogOpen(false)} onConfirm={() => void cancelSetup()} />
  </section>
}
