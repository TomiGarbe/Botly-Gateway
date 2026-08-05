import { ArrowLeft, Link2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Client, ClientInput } from '@/domain/client'
import type { Connection } from '@/domain/connection'
import { ConnectionCard } from '@/features/connections/components/ConnectionCard'
import { listConnections } from '@/features/connections/api/connectionsApi'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
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
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [connections, setConnections] = useState<Connection[]>([])
  const [isConnectionsLoading, setIsConnectionsLoading] = useState(true)

  const loadClient = useCallback(async () => {
    if (!clientId) { setError('Cliente no encontrado.'); setIsLoading(false); return }
    setError(null); setIsLoading(true)
    try { setClient(await getClient(clientId)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo cargar el cliente.') } finally { setIsLoading(false) }
  }, [clientId])

  const loadConnections = useCallback(async () => {
    if (!clientId) return
    setIsConnectionsLoading(true)
    try { setConnections(await listConnections(clientId)) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron cargar las conexiones.') } finally { setIsConnectionsLoading(false) }
  }, [clientId])

  useEffect(() => { void loadClient() }, [loadClient])
  useEffect(() => { void loadConnections() }, [loadConnections])

  async function handleUpdate(input: ClientInput) {
    if (!clientId) return
    setClient(await updateClient(clientId, input)); setIsEditing(false)
  }

  async function handleDelete() {
    if (!client || client.connectionCount > 0) return
    setError(null); setIsDeleting(true)
    try { await deleteClient(client.id); navigate('/clients') } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo eliminar el cliente.') } finally { setIsDeleting(false) }
  }

  if (isLoading) return <LoadingState label="Cargando cliente…" />
  if (error && !client) return <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadClient()}>Reintentar</button></div>
  if (!client) return null

  const createConnection = () => navigate(`/clients/${client.id}/connections/new`)

  return <section className="client-detail">
    <button type="button" className="client-back-link" onClick={() => navigate('/clients')}><ArrowLeft size={16} aria-hidden="true" /> Clientes</button>
    <div className="client-detail-heading">
      <div><p>Cliente</p><h2>{client.name}</h2>{client.description ? <span>{client.description}</span> : null}</div>
      <div className="client-detail-actions">
        <button type="button" className="client-button-secondary" onClick={() => setIsEditing(true)}><Pencil size={15} aria-hidden="true" /> Editar</button>
        {client.connectionCount === 0 ? <button type="button" className="client-button-danger" onClick={() => setIsDeleteDialogOpen(true)} disabled={isDeleting}><Trash2 size={15} aria-hidden="true" /> Eliminar</button> : null}
      </div>
    </div>
    {isEditing ? <ClientForm initialValue={{ name: client.name, description: client.description }} submitLabel="Guardar cambios" onCancel={() => setIsEditing(false)} onSubmit={handleUpdate} /> : null}
    {client ? <Toast message={error} tone="error" onDismiss={() => setError(null)} /> : null}
    <div className="client-connections-heading">
      <div><p>Conexiones</p><span>{client.connectionCount} {client.connectionCount === 1 ? 'conexión' : 'conexiones'}</span></div>
      <button type="button" className="client-button-primary" onClick={createConnection}><Plus size={16} aria-hidden="true" /> Agregar conexión</button>
    </div>
    <div className="client-connections-list" aria-label="Conexiones del cliente">
      {isConnectionsLoading ? <LoadingState label="Cargando conexiones…" lines={2} /> : null}
      {!isConnectionsLoading && connections.length === 0 ? <EmptyState icon={Link2} title="No hay conexiones." description="Agregá una conexión para comenzar a operar este cliente." action={<button type="button" className="client-button-primary" onClick={createConnection}><Plus size={16} aria-hidden="true" /> Agregar conexión</button>} /> : null}
      {!isConnectionsLoading && connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} onOpen={(connectionId) => navigate(`/connections/${connectionId}`)} />)}
    </div>
    <ConfirmDialog isOpen={isDeleteDialogOpen} title="Eliminar cliente" description="Esta acción eliminará el cliente. Solo está disponible cuando no tiene conexiones asociadas." confirmLabel="Eliminar cliente" isSubmitting={isDeleting} onCancel={() => setIsDeleteDialogOpen(false)} onConfirm={() => void handleDelete()} />
  </section>
}
