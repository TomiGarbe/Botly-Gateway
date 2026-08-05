import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client, ClientInput } from '@/domain/client'
import type { Connection } from '@/domain/connection'
import { listConnections } from '@/features/connections/api/connectionsApi'
import { ConnectionCard } from '@/features/connections/components/ConnectionCard'
import { deleteClient, getClient, updateClient } from '../api/clientsApi'
import { ClientForm } from '../components/ClientForm'

export function ClientDetailPage() {
  const navigate = useNavigate()
  const { clientId } = useParams()
  const [client, setClient] = useState<Client | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [connections, setConnections] = useState<Connection[]>([])
  const [isConnectionsLoading, setIsConnectionsLoading] = useState(true)

  const loadClient = useCallback(async () => {
    if (!clientId) {
      setError('Cliente no encontrado.')
      setIsLoading(false)
      return
    }
    setError(null)
    setIsLoading(true)
    try {
      setClient(await getClient(clientId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el cliente.')
    } finally {
      setIsLoading(false)
    }
  }, [clientId])

  const loadConnections = useCallback(async () => {
    if (!clientId) return
    setIsConnectionsLoading(true)
    try {
      setConnections(await listConnections(clientId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudieron cargar las conexiones.')
    } finally {
      setIsConnectionsLoading(false)
    }
  }, [clientId])

  useEffect(() => { void loadClient() }, [loadClient])
  useEffect(() => { void loadConnections() }, [loadConnections])

  async function handleUpdate(input: ClientInput) {
    if (!clientId) return
    setClient(await updateClient(clientId, input))
    setIsEditing(false)
  }

  async function handleDelete() {
    if (!client || client.connectionCount > 0) return
    setError(null)
    setIsDeleting(true)
    try {
      await deleteClient(client.id)
      navigate('/clients')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo eliminar el cliente.')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) return <p className="clients-state">Cargando cliente…</p>
  if (error && !client) return <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadClient()}>Reintentar</button></div>
  if (!client) return null

  return (
    <section className="client-detail">
      <button type="button" className="client-back-link" onClick={() => navigate('/clients')}><ArrowLeft size={16} aria-hidden="true" /> Clientes</button>
      <div className="client-detail-heading">
        <div>
          <h2>{client.name}</h2>
          {client.description ? <p>{client.description}</p> : null}
        </div>
        <div className="client-detail-actions">
          <button type="button" className="client-button-secondary" onClick={() => setIsEditing(true)}><Pencil size={15} aria-hidden="true" /> Editar</button>
          {client.connectionCount === 0 ? <button type="button" className="client-button-danger" onClick={() => void handleDelete()} disabled={isDeleting}><Trash2 size={15} aria-hidden="true" /> {isDeleting ? 'Eliminando…' : 'Eliminar'}</button> : null}
        </div>
      </div>

      {isEditing ? <ClientForm initialValue={{ name: client.name, description: client.description }} submitLabel="Guardar cambios" onCancel={() => setIsEditing(false)} onSubmit={handleUpdate} /> : null}
      {error ? <p className="client-form-error" role="alert">{error}</p> : null}

      <div className="client-connections-heading">
        <div><p>Conexiones</p><span>{client.connectionCount} {client.connectionCount === 1 ? 'conexión' : 'conexiones'}</span></div>
        <button type="button" className="client-button-primary" onClick={() => navigate(`/clients/${client.id}/connections/new`)}><Plus size={16} aria-hidden="true" /> Agregar conexión</button>
      </div>
      <div className="client-connections-list" aria-label="Conexiones del cliente">
        {isConnectionsLoading ? <p className="clients-state">Cargando conexiones…</p> : null}
        {!isConnectionsLoading && connections.length === 0 ? <div className="client-connections-empty">Todavía no hay conexiones para este cliente.</div> : null}
        {!isConnectionsLoading && connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} onOpen={(connectionId) => navigate(`/connections/${connectionId}`)} />)}
      </div>
    </section>
  )
}
