import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BadgeCheck, Loader2, LogIn, QrCode, X } from 'lucide-react'
import { api } from '../lib/api'
import type { GatewayConfig } from '../lib/config'
import type { ChannelCatalogItem, ChannelMethod, ConnectionType, CreateConnectionPayload, MetaSignupConfig } from '../types'

interface Props {
  config: GatewayConfig
  onClose: () => void
  onCreate: (payload: CreateConnectionPayload) => Promise<void>
}

type CloudFields = {
  accessToken: string
  phoneNumberId: string
  businessId: string
}

type EmbeddedSignupSession = {
  phoneNumberId: string
  businessAccountId: string
  raw: Record<string, unknown>
}

type FacebookLoginResponse = {
  authResponse?: {
    code?: string
  }
  status?: string
}

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void
      login: (callback: (response: FacebookLoginResponse) => void, options: Record<string, unknown>) => void
    }
    fbAsyncInit?: () => void
  }
}

const NAME_PATTERN = /^[a-z0-9_]{1,64}$/
const FACEBOOK_SDK_ID = 'facebook-jssdk'
const COEXISTENCE_FEATURE_TYPE = 'whatsapp_business_app_onboarding'

// endsWith('facebook.com') tambien aceptaria https://evilfacebook.com: hay que
// comparar el hostname completo contra el dominio y sus subdominios.
function isFacebookOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== 'https:') return false
    return hostname === 'facebook.com' || hostname.endsWith('.facebook.com')
  } catch {
    return false
  }
}

function parseFacebookMessage(event: MessageEvent): EmbeddedSignupSession | 'cancelled' | null {
  if (!isFacebookOrigin(String(event.origin || ''))) return null

  let payload: unknown = event.data
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  if (data.type !== 'WA_EMBEDDED_SIGNUP') return null

  const eventName = String(data.event || '').toUpperCase()
  if (eventName === 'CANCEL' || eventName === 'CANCELLED' || eventName === 'ERROR') return 'cancelled'
  if (eventName !== 'FINISH' && eventName !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') return null

  const result = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : data
  const phoneNumberId = String(result.phone_number_id || result.phoneNumberId || '')
  const businessAccountId = String(result.waba_id || result.business_account_id || result.businessAccountId || '')
  if (!phoneNumberId || !businessAccountId) return null
  return { phoneNumberId, businessAccountId, raw: data }
}

async function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('El inicio guiado tardo demasiado en cargar')),
      20000
    )
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
      window.clearTimeout(timeout)
      resolve()
    }
    // Si ya hay una carga en curso, esperamos a que el SDK aparezca en vez de
    // salir sin resolver la promesa (dejaba el modal colgado para siempre).
    if (document.getElementById(FACEBOOK_SDK_ID)) {
      const poll = window.setInterval(() => {
        if (!window.FB) return
        window.clearInterval(poll)
        window.clearTimeout(timeout)
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: graphVersion })
        resolve()
      }, 150)
      return
    }
    const script = document.createElement('script')
    script.id = FACEBOOK_SDK_ID
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => reject(new Error('No se pudo cargar el inicio guiado'))
    document.body.appendChild(script)
  })
}

function waitForEmbeddedSignupSession(timeoutMs = 120000): Promise<EmbeddedSignupSession> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('La conexion excedio el tiempo de espera'))
    }, timeoutMs)

    const handler = (event: MessageEvent) => {
      const parsed = parseFacebookMessage(event)
      if (!parsed) return
      window.clearTimeout(timeout)
      window.removeEventListener('message', handler)
      if (parsed === 'cancelled') {
        reject(new Error('Se cancelo la conexion'))
        return
      }
      resolve(parsed)
    }

    window.addEventListener('message', handler)
  })
}

function loginWithFacebook(configId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.FB) {
      reject(new Error('El inicio guiado no esta disponible'))
      return
    }

    window.FB.login(
      response => {
        const code = response.authResponse?.code
        if (!code) {
          reject(new Error(response.status === 'not_authorized' ? 'No se autorizo la conexion' : 'No se pudo completar la conexion guiada'))
          return
        }
        resolve(code)
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          sessionInfoVersion: '3',
          featureType: COEXISTENCE_FEATURE_TYPE,
        },
      }
    )
  })
}

export default function CreateModal({ config, onClose, onCreate }: Props) {
  const [step, setStep] = useState<'type' | 'details'>('type')
  const [channels, setChannels] = useState<ChannelCatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [selectedMethod, setSelectedMethod] = useState<{ channel: ChannelCatalogItem; method: ChannelMethod } | null>(null)
  const [name, setName] = useState('')
  const [cloud, setCloud] = useState<CloudFields>({ accessToken: '', phoneNumberId: '', businessId: '' })
  const [manualFallback, setManualFallback] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [step, selectedMethod])

  useEffect(() => {
    let cancelled = false
    setCatalogLoading(true)
    api.channels.list(config)
      .then(items => {
        if (cancelled) return
        setChannels(items.filter(channel => channel.visible && channel.enabled))
        setError('')
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'No se pudo cargar el catalogo de canales')
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [config])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const selectMethod = (channel: ChannelCatalogItem, method: ChannelMethod) => {
    setSelectedMethod({ channel, method })
    setManualFallback(false)
    setError('')
    setStep('details')
  }

  const currentConnectionType = (selectedMethod?.method.currentConnectionType || 'baileys') as ConnectionType

  const validateName = () => {
    const trimmed = name.trim()
    if (!trimmed) return 'El nombre no puede estar vacio'
    if (!NAME_PATTERN.test(trimmed)) return 'Solo minusculas, numeros y guion bajo (max. 64 caracteres)'
    return ''
  }

  const validateManual = () => {
    const nameError = validateName()
    if (nameError) return nameError
    if (currentConnectionType === 'cloud') {
      if (!cloud.accessToken.trim()) return 'La credencial principal es obligatoria'
      if (!cloud.phoneNumberId.trim()) return 'El identificador del numero es obligatorio'
      if (!cloud.businessId.trim()) return 'El identificador de la cuenta es obligatorio'
    }
    return ''
  }

  const handleManualSubmit = async () => {
    const validationError = validateManual()
    if (validationError) {
      setError(validationError)
      return
    }

    const instanceName = name.trim()
    const payload: CreateConnectionPayload = currentConnectionType === 'cloud'
      ? {
          connectionType: 'cloud',
          instanceName,
          accessToken: cloud.accessToken.trim(),
          phoneNumberId: cloud.phoneNumberId.trim(),
          businessId: cloud.businessId.trim(),
        }
      : { connectionType: 'baileys', instanceName }

    setLoading(true)
    setError('')
    try {
      await onCreate(payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la conexion')
    } finally {
      setLoading(false)
    }
  }

  const handleEmbeddedSignup = async () => {
    const nameError = validateName()
    if (nameError) {
      setError(nameError)
      return
    }

    setLoading(true)
    setError('')
    try {
      const signupConfig: MetaSignupConfig = await api.metaSignup.config(config)
      if (!signupConfig.enabled || !signupConfig.app_id || !signupConfig.config_id) {
        throw new Error('La conexion oficial no esta configurada para iniciar sesion. Revisa la configuracion del panel.')
      }

      await loadFacebookSdk(signupConfig.app_id, signupConfig.graph_version)
      const sessionPromise = waitForEmbeddedSignupSession()
      let code = ''
      try {
        code = await loginWithFacebook(signupConfig.config_id)
      } catch (loginError) {
        sessionPromise.catch(() => undefined)
        throw loginError
      }
      const session = await sessionPromise

      await onCreate({
        connectionType: 'cloud_embedded',
        instanceName: name.trim(),
        code,
        phoneNumberId: session.phoneNumberId,
        businessAccountId: session.businessAccountId,
        sessionInfo: session.raw,
        coexistenceRequested: signupConfig.supports_coexistence,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error durante la conexion oficial')
    } finally {
      setLoading(false)
    }
  }

  const updateCloud = (key: keyof CloudFields, value: string) => {
    setCloud(current => ({ ...current, [key]: value }))
  }

  const visibleMethods = channels
    .flatMap(channel => (channel.methods || []).map(method => ({ channel, method })))
    .filter(item => item.method.visible && item.method.enabled && item.method.currentConnectionType)
    .sort((a, b) => a.channel.sortOrder - b.channel.sortOrder || a.method.sortOrder - b.method.sortOrder)
  const title = step === 'type' ? 'Nueva conexion' : selectedMethod?.method.displayName || 'Nueva conexion'
  const canManualSubmit = Boolean(name.trim()) && (currentConnectionType === 'baileys' || Boolean(cloud.accessToken && cloud.phoneNumberId && cloud.businessId))

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto flex flex-col gap-0 animate-slide-up">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            {step === 'details' && (
              <button
                onClick={() => setStep('type')}
                className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-md hover:bg-zinc-800"
                title="Volver"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <h2 className="font-semibold text-sm truncate">{title}</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-md hover:bg-zinc-800" title="Cerrar">
            <X size={16} />
          </button>
        </div>

        {step === 'type' ? (
          <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {catalogLoading ? (
              <>
                <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-4 h-32 animate-pulse" />
                <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-4 h-32 animate-pulse" />
              </>
            ) : visibleMethods.length === 0 ? (
              <p className="text-sm text-zinc-500 sm:col-span-2">{error || 'No hay metodos de conexion disponibles.'}</p>
            ) : visibleMethods.map(({ channel, method }) => {
              const Icon = method.icon === 'qr-code' ? QrCode : BadgeCheck
              const buttonTone = method.currentConnectionType === 'cloud' ? 'hover:border-emerald-500' : 'hover:border-blue-500'
              return (
                <button
                  key={`${channel.id}:${method.id}`}
                  onClick={() => selectMethod(channel, method)}
                  className={`text-left border border-zinc-800 ${buttonTone} bg-zinc-950/50 rounded-xl p-4 transition-colors`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <Icon size={18} className={method.currentConnectionType === 'cloud' ? 'text-emerald-400' : 'text-blue-400'} />
                    <span className="text-[10px] uppercase text-zinc-500 font-medium">{method.discovery === 'qr' ? 'QR' : method.name}</span>
                  </span>
                  <span className="block text-sm font-semibold text-zinc-100 mt-4">{method.displayName}</span>
                  <span className="block text-xs text-zinc-500 mt-1">{method.description}</span>
                </button>
              )
            })}
            {error && visibleMethods.length > 0 && (
              <p className="text-xs text-red-400 sm:col-span-2">{error}</p>
            )}
          </div>
        ) : (
          <>
            <div className="px-5 py-5 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-zinc-400">Nombre de la conexion</label>
                <input
                  ref={inputRef}
                  value={name}
                  onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  onKeyDown={e => { if (e.key === 'Enter' && currentConnectionType === 'baileys') handleManualSubmit() }}
                  placeholder="acme_support"
                  className="bg-zinc-800 border border-zinc-700 focus:border-blue-500 focus:outline-none rounded-lg px-3 py-2.5 text-sm font-mono placeholder:text-zinc-600 transition-colors"
                />
                <p className="text-xs text-zinc-600">Solo minusculas, numeros y guion bajo.</p>
              </div>

              {currentConnectionType === 'cloud' && !manualFallback && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 flex flex-col gap-3">
                  <div>
                    <p className="text-xs font-semibold text-zinc-300">Conexion guiada</p>
                    <p className="text-xs text-zinc-500 mt-1">Completa el inicio guiado y el panel preparara WhatsApp automaticamente. Si tu numero es compatible, podras conservar la aplicacion movil.</p>
                  </div>
                  <button
                    onClick={handleEmbeddedSignup}
                    disabled={loading || !name.trim()}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                    {loading ? 'Conectando...' : `Conectar ${selectedMethod?.method.displayName || 'conexion oficial'}`}
                  </button>
                  <button
                    onClick={() => setManualFallback(true)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Modo administrador: usar credenciales manuales
                  </button>
                </div>
              )}

              {(currentConnectionType === 'baileys' || manualFallback) && currentConnectionType === 'cloud' && (
                <div className="grid grid-cols-1 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-zinc-400">Credencial principal</label>
                    <input
                      type="password"
                      value={cloud.accessToken}
                      onChange={e => updateCloud('accessToken', e.target.value)}
                      autoComplete="off"
                      className="bg-zinc-800 border border-zinc-700 focus:border-emerald-500 focus:outline-none rounded-lg px-3 py-2.5 text-sm font-mono placeholder:text-zinc-600 transition-colors"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-zinc-400">Identificador del numero</label>
                      <input
                        value={cloud.phoneNumberId}
                        onChange={e => updateCloud('phoneNumberId', e.target.value)}
                        autoComplete="off"
                        className="bg-zinc-800 border border-zinc-700 focus:border-emerald-500 focus:outline-none rounded-lg px-3 py-2.5 text-sm font-mono placeholder:text-zinc-600 transition-colors"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-zinc-400">Identificador de la cuenta</label>
                      <input
                        value={cloud.businessId}
                        onChange={e => updateCloud('businessId', e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit() }}
                        autoComplete="off"
                        className="bg-zinc-800 border border-zinc-700 focus:border-emerald-500 focus:outline-none rounded-lg px-3 py-2.5 text-sm font-mono placeholder:text-zinc-600 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              )}

              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors rounded-lg hover:bg-zinc-800"
              >
                Cancelar
              </button>
              {(currentConnectionType === 'baileys' || manualFallback) && (
                <button
                  onClick={handleManualSubmit}
                  disabled={loading || !canManualSubmit}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  {loading && <Loader2 size={13} className="animate-spin" />}
                  {loading ? 'Creando...' : 'Crear conexion'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
