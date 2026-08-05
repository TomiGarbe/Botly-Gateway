import type { Client } from '@/domain/client'
import { StatusBadge } from '@/shared/components/StatusBadge'

interface ClientCardProps {
  client: Client
  onOpen: (clientId: string) => void
}

function formatLastActivity(value: string): string | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function ClientCard({ client, onOpen }: ClientCardProps) {
  const lastActivity = client.lastActivityAt ? formatLastActivity(client.lastActivityAt) : null
  const hasConnections = client.connectionCount > 0

  return <article className="client-card" role="button" tabIndex={0} aria-label={`Abrir cliente ${client.name}`} onClick={() => onOpen(client.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(client.id) } }}>
    <div className="client-card-content">
      <h2>{client.name}</h2>
      {client.description ? <p>{client.description}</p> : null}
      <div className="client-card-meta">
        <span>{client.connectionCount} {client.connectionCount === 1 ? 'conexión' : 'conexiones'}</span>
        <StatusBadge tone={hasConnections ? 'healthy' : 'pending'}>{hasConnections ? 'Operativa' : 'Pendiente'}</StatusBadge>
        <span>{lastActivity ? `Última actividad: ${lastActivity}` : 'Sin actividad registrada'}</span>
      </div>
    </div>
  </article>
}
