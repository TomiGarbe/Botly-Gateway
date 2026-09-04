import { ArrowLeft, CheckCircle2, Instagram, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client } from '@/domain/client'
import { getClient } from '@/features/clients/api/clientsApi'
import { environment } from '@/app/config/environment'
import { Field, Input } from '@/shared/components/FormControls'
import { LoadingState } from '@/shared/components/LoadingState'
import { createConnection } from '../api/connectionsApi'

function authorizeUrl(connectionId: string): string {
  const baseUrl = environment.gatewayUrl || window.location.origin
  const url = new URL('/connections/meta/instagram/authorize', baseUrl)
  url.searchParams.set('connection_id', connectionId)
  url.searchParams.set('ui_return', 'true')
  return url.toString()
}

export function InstagramConnectionPage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const [client, setClient] = useState<Client | null>(null)
  const [name, setName] = useState('Instagram')
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void (async () => { try { if (clientId) setClient(await getClient(clientId)); else setError('Cliente no encontrado.') } catch { setError('No se pudo cargar el cliente.') } finally { setIsLoading(false) } })() }, [clientId])

  async function createInstagramConnection() {
    if (!clientId || isSubmitting) return
    setError(null); setIsSubmitting(true)
    try { const connection = await createConnection({ clientId, name: name.trim() || 'Instagram', provider: 'meta', channel: 'instagram' }); setConnectionId(connection.id) }
    catch { setError('No se pudo crear la conexión de Instagram. Intentá nuevamente.') }
    finally { setIsSubmitting(false) }
  }

  if (isLoading) return <LoadingState label="Preparando Instagram…" />
  if (!client) return <section className="clients-state clients-state-error" role="alert"><p>{error || 'Cliente no encontrado.'}</p></section>
  return <section className="new-connection-page instagram-onboarding">
    <button type="button" className="client-back-link" onClick={() => navigate(`/clients/${client.id}/connections/new`)}><ArrowLeft size={16} /> Elegir conexión</button>
    <header className="new-connection-heading"><p>{client.name}</p><h2>Conectar Instagram</h2><span>Conectá una cuenta profesional de Instagram mediante Meta. Nunca te pediremos tokens ni credenciales técnicas.</span></header>
    {!connectionId ? <div className="connection-choice-form"><Field label="Nombre de la conexión"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} disabled={isSubmitting} /></Field><button type="button" className="client-button-primary" disabled={isSubmitting} onClick={() => void createInstagramConnection()}>{isSubmitting ? <><LoaderCircle className="animate-spin" size={16} /> Creando conexión…</> : <><Instagram size={16} /> Crear y conectar Instagram</>}</button>{error ? <p className="client-form-error" role="alert">{error}</p> : null}</div> : <div className="instagram-oauth-card"><CheckCircle2 size={28} aria-hidden="true" /><div><h3>Conexión creada</h3><p>Continuá con Meta Business Login para detectar tu cuenta profesional.</p></div><button type="button" className="client-button-primary" onClick={() => window.location.assign(authorizeUrl(connectionId))}>Conectar con Instagram</button></div>}
  </section>
}
