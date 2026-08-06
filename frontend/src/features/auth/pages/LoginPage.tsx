import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'

interface GoogleAccounts {
  id: {
    initialize: (config: { client_id: string; callback: (response: { credential?: string }) => void }) => void
    renderButton: (element: HTMLElement, options: Record<string, string | number>) => void
  }
}

declare global {
  interface Window { google?: { accounts?: GoogleAccounts } }
}

let googleScript: Promise<GoogleAccounts> | null = null

function loadGoogleAccounts(): Promise<GoogleAccounts> {
  if (window.google?.accounts) return Promise.resolve(window.google.accounts)
  if (googleScript) return googleScript
  googleScript = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => window.google?.accounts ? resolve(window.google.accounts) : reject(new Error('Google unavailable'))
    script.onerror = () => reject(new Error('Google unavailable'))
    document.head.appendChild(script)
  })
  return googleScript
}

export function LoginPage() {
  const host = useRef<HTMLDivElement>(null)
  const { user, googleClientId, isLoading, accessDenied, signInWithGoogle } = useAuth()
  const [isGoogleReady, setIsGoogleReady] = useState(false)

  useEffect(() => {
    let active = true
    if (!googleClientId || !host.current) return
    void loadGoogleAccounts().then((accounts) => {
      if (!active || !host.current) return
      accounts.id.initialize({ client_id: googleClientId, callback: (response) => { if (response.credential) void signInWithGoogle(response.credential) } })
      accounts.id.renderButton(host.current, { type: 'standard', theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular', width: 280 })
      setIsGoogleReady(true)
    }).catch(() => { if (active) setIsGoogleReady(false) })
    return () => { active = false }
  }, [googleClientId, signInWithGoogle])

  if (user) return <Navigate to="/dashboard" replace />
  if (accessDenied) return <Navigate to="/access-denied" replace />
  return <main className="auth-page">
    <section className="auth-login" aria-label="Acceso a Botly Gateway">
      <img className="auth-logo" src="/logo-gateway-mark.svg" alt="" />
      <h1>Botly Gateway</h1>
      <div ref={host} className="auth-google-button" aria-label="Continuar con Google" />
      {isLoading || (!isGoogleReady && !!googleClientId) ? <LoaderCircle size={18} className="auth-loading animate-spin" aria-label="Cargando" /> : null}
      {!googleClientId ? <span className="auth-unavailable">Google no está configurado.</span> : null}
    </section>
  </main>
}
