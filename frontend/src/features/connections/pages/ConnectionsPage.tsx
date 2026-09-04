import { Link2, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { ConnectionCard } from '../components/ConnectionCard'
import { listConnections } from '../api/connectionsApi'

export function ConnectionsPage() {
  const navigate = useNavigate()
  const [connections, setConnections] = useState<Connection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => { setIsLoading(true); setError(null); try { setConnections(await listConnections()) } catch { setError('No se pudieron cargar las conexiones.') } finally { setIsLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  return <section className="clients-page connections-page"><div className="clients-page-heading"><div><p>Conexiones</p><h2>Canales conectados</h2></div><button className="client-button-primary" onClick={() => navigate('/connections/new')}><Plus size={16} /> Agregar conexión</button></div>{isLoading ? <LoadingState label="Cargando conexiones…" /> : null}{error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Reintentar</button></div> : null}{!isLoading && !error && connections.length === 0 ? <EmptyState icon={Link2} title="No hay conexiones." description="Agregá una conexión para comenzar." action={<button className="client-button-primary" onClick={() => navigate('/connections/new')}><Plus size={16} /> Agregar conexión</button>} /> : null}{!isLoading && !error && connections.length > 0 ? <div className="connections-page-grid">{connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} onOpen={(id) => navigate(`/connections/${id}`)} />)}</div> : null}</section>
}
