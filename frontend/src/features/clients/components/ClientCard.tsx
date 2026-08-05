import type { Client } from '@/domain/client'

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

  return (
    <article className="client-card">
      <button type="button" className="client-card-link" onClick={() => onOpen(client.id)}>
        <h2>{client.name}</h2>
        {client.description ? <p>{client.description}</p> : null}
        <div className="client-card-meta">
          <span>{client.connectionCount} {client.connectionCount === 1 ? 'conexión' : 'conexiones'}</span>
          {lastActivity ? <span>Última actividad: {lastActivity}</span> : null}
        </div>
      </button>
    </article>
  )
}
