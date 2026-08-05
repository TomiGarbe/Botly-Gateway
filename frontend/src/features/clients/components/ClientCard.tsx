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

  return <article className="client-card">
    <div className="client-card-content">
      <h2>{client.name}</h2>
      {client.description ? <p>{client.description}</p> : null}
      <div className="client-card-meta">
        <span>{client.connectionCount} {client.connectionCount === 1 ? 'conexión' : 'conexiones'}</span>
        <StatusBadge tone={hasConnections ? 'healthy' : 'pending'}>{hasConnections ? 'Operativa' : 'Pendiente'}</StatusBadge>
        <span>{lastActivity ? `Última actividad: ${lastActivity}` : 'Sin actividad registrada'}</span>
      </div>
    </div>
    <button type="button" className="client-button-secondary client-card-action" onClick={() => onOpen(client.id)}>Abrir</button>
  </article>
}
