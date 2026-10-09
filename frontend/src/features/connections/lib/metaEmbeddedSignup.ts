/** Helpers de Meta Embedded Signup compartidos entre el alta y la reautorización de WhatsApp Cloud. */
export type EmbeddedSession = { phoneNumberId?: string; businessAccountId: string; raw: Record<string, unknown> }

let facebookSdkPromise: Promise<void> | null = null
// Embedded Signup often includes password recovery, 2FA and phone
// verification.  Two minutes is not enough for a real customer flow.
const META_SIGNUP_WAIT_TIMEOUT_MS = 30 * 60 * 1000

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

export function waitForSession(signal: AbortSignal): Promise<EmbeddedSession> {
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
    }, META_SIGNUP_WAIT_TIMEOUT_MS)
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

export async function loadFacebookSdk(appId: string, graphVersion: string): Promise<void> {
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

export function loginWithFacebook(configId: string): Promise<string> {
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

export function qrSource(payload: { qrcode?: { base64?: string; code?: string }; base64?: string }): string | null {
  const value = payload.qrcode?.base64 || payload.base64 || payload.qrcode?.code
  if (!value) return null
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`
}
