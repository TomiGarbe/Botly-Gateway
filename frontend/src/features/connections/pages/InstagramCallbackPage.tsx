import { CheckCircle2, Circle, LoaderCircle, RotateCcw, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { InstagramReadiness } from '@/domain/connection'
import { getInstagramReadiness, verifyInstagramConnection } from '../api/connectionsApi'

const MAX_ATTEMPTS = 120
const RETRY_DELAY_MS = 1500

type StageId = 'oauth' | 'meta' | 'webhook' | 'core' | 'test'
const stages: Array<{ id: StageId; label: string }> = [
  { id: 'oauth', label: 'Autorizando cuenta de Instagram' },
  { id: 'meta', label: 'Validando credenciales con Meta' },
  { id: 'webhook', label: 'Comprobando webhook de mensajes' },
  { id: 'core', label: 'Configurando canal en Botly' },
  { id: 'test', label: 'Validando la ruta de recepción' },
]

function completedStages(readiness: InstagramReadiness | null): Set<StageId> {
  const completed = new Set<StageId>()
  if (readiness?.authenticated) completed.add('oauth')
  if (readiness?.credentialValid && readiness?.requiredScopesPresent) completed.add('meta')
  if (readiness?.webhookSubscribed) completed.add('webhook')
  if (readiness?.coreBindingPresent && readiness?.coreCredentialValid) completed.add('core')
  if (readiness?.ready && readiness?.coreDeliveryReady) completed.add('test')
  return completed
}

export function InstagramCallbackPage() {
  const { connectionId } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const outcome = params.get('oauth') || 'success'
  const [readiness, setReadiness] = useState<InstagramReadiness | null>(null)
  const [message, setMessage] = useState('Validando la cuenta con Meta…')
  const [failed, setFailed] = useState(outcome === 'failed' || outcome === 'cancelled')
  const [retryKey, setRetryKey] = useState(0)
  const completed = useMemo(() => completedStages(readiness), [readiness])

  useEffect(() => {
    if (!connectionId || failed) return
    let stopped = false
    let timer: number | undefined

    const check = async (attempt: number) => {
      try {
        const current = await getInstagramReadiness(connectionId)
        if (stopped) return
        setReadiness(current)
        if (current.ready && current.coreDeliveryReady) {
          setMessage('La conexión superó todas las verificaciones.')
          window.setTimeout(() => navigate(`/connections/${connectionId}?instagram=connected`, { replace: true }), 700)
          return
        }
        setMessage(current.authenticated ? 'Configurando y probando el canal…' : 'Esperando la autorización de Meta…')
        const verified = await verifyInstagramConnection(connectionId)
        if (stopped) return
        const next = verified.readiness || await getInstagramReadiness(connectionId)
        setReadiness(next)
        if (next.ready && next.coreDeliveryReady) {
          setMessage('La conexión superó todas las verificaciones.')
          window.setTimeout(() => navigate(`/connections/${connectionId}?instagram=connected`, { replace: true }), 700)
          return
        }
      } catch {
        // Meta and Core can settle asynchronously. Keep this blocking setup
        // screen active and resumable instead of opening an unusable channel.
      }

      if (!stopped && attempt + 1 < MAX_ATTEMPTS) {
        timer = window.setTimeout(() => void check(attempt + 1), RETRY_DELAY_MS)
      } else if (!stopped) {
        setFailed(true)
        setMessage('No pudimos completar todas las pruebas. La conexión no fue habilitada.')
      }
    }

    void check(0)
    return () => { stopped = true; if (timer) window.clearTimeout(timer) }
  }, [connectionId, failed, navigate, retryKey])

  const cancelled = outcome === 'cancelled'
  return <section className="instagram-callback-state instagram-setup-state">
    {failed ? <XCircle className="text-red-400" size={28} /> : <LoaderCircle className="animate-spin" size={28} />}
    <h2>{failed ? (cancelled ? 'Autorización cancelada' : 'No se pudo conectar Instagram') : 'Configurando Instagram'}</h2>
    <p>{cancelled ? 'Meta canceló la autorización. La conexión quedó inactiva.' : message}</p>
    {!failed ? <div className="instagram-setup-steps" aria-live="polite">
      {stages.map((stage) => {
        const done = completed.has(stage.id)
        const active = !done && stages.find((candidate) => !completed.has(candidate.id))?.id === stage.id
        return <div key={stage.id} className={done ? 'is-complete' : active ? 'is-active' : ''}>
          {done ? <CheckCircle2 size={18} /> : active ? <LoaderCircle className="animate-spin" size={18} /> : <Circle size={18} />}
          <span>{stage.label}</span>
        </div>
      })}
    </div> : null}
    {failed && !cancelled ? <button type="button" className="client-button-primary" onClick={() => { setFailed(false); setMessage('Reintentando las verificaciones…'); setRetryKey((value) => value + 1) }}><RotateCcw size={16} /> Reintentar pruebas</button> : null}
    {cancelled && connectionId ? <button type="button" className="client-button-primary" onClick={() => navigate(`/connections/${connectionId}`)}>Volver a autorizar</button> : null}
  </section>
}
