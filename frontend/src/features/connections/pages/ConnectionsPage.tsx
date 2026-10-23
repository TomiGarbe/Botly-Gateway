import { LayoutGrid, Link2, Plus, Rows3, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { ConnectionCard, connectionAddress, connectionState } from '../components/ConnectionCard'
import { listConnections } from '../api/connectionsApi'

type Filter = 'all' | 'problems' | 'healthy'
const severity = { critical: 0, attention: 1, pending: 2, configuring: 3, healthy: 4 } as Record<string, number>

function matches(connection: Connection, query: string): boolean {
  if (!query) return true
  const haystack = [connection.name, connection.displayName, connectionAddress(connection.address), connection.client?.name, connection.channel.displayName, connection.provider.displayName]
  return haystack.some((value) => value?.toLowerCase().includes(query))
}

const VIEW_KEY = 'gateway.connections.view'
function savedView(): 'list' | 'clients' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'clients' ? 'clients' : 'list' } catch { return 'list' }
}

export function ConnectionsPage() {
  const navigate = useNavigate()
  const [connections, setConnections] = useState<Connection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<'list' | 'clients'>(savedView)
  function changeView(next: 'list' | 'clients') { setView(next); try { window.localStorage.setItem(VIEW_KEY, next) } catch { /* sin storage: la vista no se recuerda */ } }
  const load = useCallback(async () => { setIsLoading(true); setError(null); try { setConnections(await listConnections()) } catch { setError('No se pudieron cargar las conexiones.') } finally { setIsLoading(false) } }, [])
  useEffect(() => { void load() }, [load])

  const ranked = useMemo(() => connections
    .map((connection) => ({ connection, tone: connectionState(connection).tone }))
    .sort((left, right) => severity[left.tone] - severity[right.tone] || left.connection.name.localeCompare(right.connection.name, 'es')), [connections])
  const problems = ranked.filter((item) => item.tone !== 'healthy').length
  const visible = ranked.filter((item) => (filter === 'all' || (filter === 'healthy') === (item.tone === 'healthy')) && matches(item.connection, query.trim().toLowerCase()))
  const byClient = useMemo(() => {
    const groups = new Map<string, { name: string; items: typeof visible; problems: number }>()
    for (const item of visible) {
      const key = item.connection.client?.id || item.connection.clientId || 'none'
      const group = groups.get(key) || { name: item.connection.client?.name || 'Sin cliente', items: [], problems: 0 }
      group.items.push(item)
      if (item.tone !== 'healthy') group.problems += 1
      groups.set(key, group)
    }
    return [...groups.entries()].sort(([, left], [, right]) => right.problems - left.problems || left.name.localeCompare(right.name, 'es'))
  }, [visible])
  const card = ({ connection }: (typeof visible)[number]) => <ConnectionCard key={connection.id} connection={connection} onOpen={(id) => navigate(`/connections/${id}`)} />
  const filters: Array<{ id: Filter; label: string; count: number }> = [
    { id: 'all', label: 'Todas', count: ranked.length },
    { id: 'problems', label: 'Problemas', count: problems },
    { id: 'healthy', label: 'Operativas', count: ranked.length - problems },
  ]

  return <section className="clients-page connections-page">
    <div className="clients-page-heading"><div><p>Conexiones</p><h2>Canales conectados</h2></div><button className="client-button-primary" onClick={() => navigate('/connections/new')}><Plus size={16} /> Agregar conexión</button></div>
    {isLoading ? <LoadingState label="Cargando conexiones…" /> : null}
    {error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Reintentar</button></div> : null}
    {!isLoading && !error && connections.length === 0 ? <EmptyState icon={Link2} title="No hay conexiones." description="Agregá una conexión para comenzar." action={<button className="client-button-primary" onClick={() => navigate('/connections/new')}><Plus size={16} /> Agregar conexión</button>} /> : null}
    {!isLoading && !error && connections.length > 0 ? <>
      <div className="connections-toolbar">
        <label className="workspace-message-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, número o cliente" aria-label="Buscar conexiones" /></label>
        <div className="connections-filter" role="group" aria-label="Filtrar por estado">
          {filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)}>{item.label}<span>{item.count}</span></button>)}
        </div>
        <div className="connections-filter connections-view" role="group" aria-label="Vista">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'is-active' : ''} onClick={() => changeView('list')} title="Lista"><LayoutGrid size={15} aria-hidden="true" /><span className="sr-only">Lista</span></button>
          <button type="button" aria-pressed={view === 'clients'} className={view === 'clients' ? 'is-active' : ''} onClick={() => changeView('clients')} title="Agrupar por cliente"><Rows3 size={15} aria-hidden="true" /><span className="sr-only">Por cliente</span></button>
        </div>
      </div>
      {visible.length === 0 ? <p className="connections-empty-filter">Ninguna conexión coincide con la búsqueda.</p>
        : view === 'clients' ? byClient.map(([key, group]) => <section key={key} className="connections-client-group" aria-label={group.name}>
          <h3><button type="button" onClick={() => key !== 'none' && navigate(`/clients/${key}`)}>{group.name}</button><span>{group.items.length} {group.items.length === 1 ? 'conexión' : 'conexiones'}{group.problems ? ` · ${group.problems} con problemas` : ''}</span></h3>
          <div className="connections-page-grid">{group.items.map(card)}</div>
        </section>)
        : <div className="connections-page-grid">{visible.map(card)}</div>}
    </> : null}
  </section>
}
