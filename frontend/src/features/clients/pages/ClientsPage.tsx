import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Client, ClientInput } from '@/domain/client'
import { createClient, listClients } from '../api/clientsApi'
import { ClientCard } from '../components/ClientCard'
import { ClientForm } from '../components/ClientForm'

export function ClientsPage() {
  const navigate = useNavigate()
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const loadClients = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      setClients(await listClients())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudieron cargar los clientes.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadClients() }, [loadClients])

  async function handleCreate(input: ClientInput) {
    const client = await createClient(input)
    setClients((current) => [...current, client].sort((left, right) => left.name.localeCompare(right.name, 'es')))
    setIsCreating(false)
  }

  return (
    <section className="clients-page">
      <div className="clients-page-heading">
        <div>
          <p>Clientes</p>
          <h2>Organizaciones conectadas a Botly</h2>
        </div>
        <button type="button" className="client-button-primary" onClick={() => setIsCreating(true)}>
          <Plus size={16} aria-hidden="true" /> Nuevo cliente
        </button>
      </div>

      {isCreating ? <ClientForm submitLabel="Crear cliente" onCancel={() => setIsCreating(false)} onSubmit={handleCreate} /> : null}
      {isLoading ? <p className="clients-state">Cargando clientes…</p> : null}
      {error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadClients()}>Reintentar</button></div> : null}
      {!isLoading && !error && clients.length === 0 ? <p className="clients-state">Todavía no hay clientes. Creá el primero para empezar.</p> : null}
      {!isLoading && !error && clients.length > 0 ? <div className="clients-list">
        {clients.map((client) => <ClientCard key={client.id} client={client} onOpen={(clientId) => navigate(`/clients/${clientId}`)} />)}
      </div> : null}
    </section>
  )
}
