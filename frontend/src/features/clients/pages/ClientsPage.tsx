import { Building2, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Client, ClientInput } from '@/domain/client'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
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
    try { setClients(await listClients()) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron cargar los clientes.') } finally { setIsLoading(false) }
  }, [])

  useEffect(() => { void loadClients() }, [loadClients])

  async function handleCreate(input: ClientInput) {
    const client = await createClient(input)
    setClients((current) => [...current, client].sort((left, right) => left.name.localeCompare(right.name, 'es')))
    setIsCreating(false)
  }

  return <section className="clients-page">
    <div className="clients-page-heading">
      <div><p>Clientes</p><h2>Organizaciones conectadas a Botly</h2></div>
      <button type="button" className="client-button-primary" onClick={() => setIsCreating(true)}><Plus size={16} aria-hidden="true" /> Nuevo cliente</button>
    </div>
    {isCreating ? <ClientForm submitLabel="Crear cliente" onCancel={() => setIsCreating(false)} onSubmit={handleCreate} /> : null}
    {isLoading ? <LoadingState label="Cargando clientes…" /> : null}
    {error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadClients()}>Reintentar</button></div> : null}
    {!isLoading && !error && clients.length === 0 ? <EmptyState icon={Building2} title="Aún no creaste ningún cliente." description="Creá un cliente para agrupar y operar sus conexiones." action={<button type="button" className="client-button-primary" onClick={() => setIsCreating(true)}><Plus size={16} aria-hidden="true" /> Crear cliente</button>} /> : null}
    {!isLoading && !error && clients.length > 0 ? <div className="clients-list">{clients.map((client) => <ClientCard key={client.id} client={client} onOpen={(clientId) => navigate(`/clients/${clientId}`)} />)}</div> : null}
  </section>
}
