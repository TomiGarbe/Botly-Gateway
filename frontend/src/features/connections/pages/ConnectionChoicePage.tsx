import { ArrowLeft, Instagram, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client } from '@/domain/client'
import { getClient, listClients } from '@/features/clients/api/clientsApi'
import { LoadingState } from '@/shared/components/LoadingState'

export function ConnectionChoicePage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const [clients, setClients] = useState<Client[]>([])
  const [selectedClientId, setSelectedClientId] = useState(clientId || '')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        if (clientId) await getClient(clientId)
        else setClients(await listClients())
      } catch { setError('No se pudo cargar el cliente para la nueva conexión.') } finally { setIsLoading(false) }
    })()
  }, [clientId])

  if (isLoading) return <LoadingState label="Preparando conexiones…" />
  if (error) return <section className="clients-state clients-state-error" role="alert"><p>{error}</p><button onClick={() => navigate('/clients')}>Volver a clientes</button></section>
  const destination = (type: 'instagram' | 'whatsapp') => selectedClientId && navigate(`/clients/${selectedClientId}/connections/${type}/new`)

  return <section className="new-connection-page connection-choice-page">
    <button type="button" className="client-back-link" onClick={() => navigate(clientId ? `/clients/${clientId}` : '/connections')}><ArrowLeft size={16} /> Conexiones</button>
    <header className="new-connection-heading"><p>Nueva conexión</p><h2>¿Qué querés conectar?</h2><span>Elegí el canal que vas a configurar para este cliente.</span></header>
    {!clientId ? <label className="connection-choice-client">Cliente<select value={selectedClientId} onChange={(event) => setSelectedClientId(event.target.value)}><option value="">Seleccioná un cliente</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label> : null}
    <div className="connection-choice-grid">
      <article><Instagram size={28} aria-hidden="true" /><h3>Instagram</h3><p>Conectá una cuenta profesional mediante Meta Business Login.</p><button type="button" className="client-button-primary" disabled={!selectedClientId} onClick={() => destination('instagram')}>Continuar con Instagram</button></article>
      <article><MessageCircle size={28} aria-hidden="true" /><h3>WhatsApp</h3><p>Usá el flujo de conexión existente para WhatsApp.</p><button type="button" className="client-button-secondary" disabled={!selectedClientId} onClick={() => destination('whatsapp')}>Continuar con WhatsApp</button></article>
    </div>
  </section>
}
