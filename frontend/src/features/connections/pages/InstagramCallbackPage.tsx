import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  bindInstagramCoreChannel,
  getConnection,
  getInstagramReadiness,
  listInstagramCoreChannels,
} from '../api/connectionsApi'

export function InstagramCallbackPage() {
  const { connectionId } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [message, setMessage] = useState('Verificando la cuenta de Instagram…')
  const outcome = params.get('oauth') || 'success'

  useEffect(() => {
    if (!connectionId) return
    if (outcome !== 'success') {
      setMessage(outcome === 'cancelled' ? 'La autorización de Instagram fue cancelada.' : 'No se pudo completar la conexión de Instagram.')
      return
    }

    let stopped = false
    let attempts = 0
    const check = async () => {
      try {
        const [connection, readiness] = await Promise.all([
          getConnection(connectionId),
          getInstagramReadiness(connectionId),
        ])
        if (!stopped && connection.providerAccount && readiness.authenticated) {
          if (readiness.coreDeliveryReady) {
            navigate(`/connections/${connectionId}?instagram=connected`, { replace: true })
            return
          }

          setMessage('Vinculando Instagram con Botly…')
          const channels = await listInstagramCoreChannels(connectionId)
          const activeChannels = channels.filter((channel) => channel.status.toLowerCase() === 'active')
          if (activeChannels.length === 1) {
            const bound = await bindInstagramCoreChannel(connectionId, activeChannels[0].id)
            if (!stopped && bound.readiness?.coreDeliveryReady) {
              navigate(`/connections/${connectionId}?instagram=connected`, { replace: true })
              return
            }
          }
        }
      } catch {
        // OAuth and Core channel persistence can settle shortly after redirect.
      }

      attempts += 1
      if (!stopped && attempts < 20) window.setTimeout(() => void check(), 1500)
      else if (!stopped) setMessage('La cuenta está autenticada, pero todavía no pudo vincularse con un canal activo de Botly.')
    }

    void check()
    return () => { stopped = true }
  }, [connectionId, navigate, outcome])

  return <section className="instagram-callback-state">{outcome === 'success' ? <LoaderCircle className="animate-spin" size={24} /> : <CheckCircle2 size={24} />}<h2>{outcome === 'success' ? 'Instagram conectado' : 'Conexión de Instagram'}</h2><p>{message}</p>{outcome !== 'success' && connectionId ? <button className="client-button-primary" onClick={() => navigate(`/connections/${connectionId}`)}>Ver conexión</button> : null}</section>
}
