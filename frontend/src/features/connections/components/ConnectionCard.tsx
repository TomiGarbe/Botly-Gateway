import type { Connection } from '@/domain/connection'

interface ConnectionCardProps {
  connection: Connection
  onOpen: (connectionId: string) => void
}

function activityLabel(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function stateLabel(state: Connection['status']['state']): string {
  return { pending: 'Pendiente', connected: 'Conectada', connecting: 'Conectando', disconnected: 'Desconectada' }[state]
}

export function ConnectionCard({ connection, onOpen }: ConnectionCardProps) {
  const activity = activityLabel(connection.lastActivityAt)

  return (
    <article className="connection-card">
      <div>
        <h3>{connection.name}</h3>
        <p>{connection.channel.displayName} · {connection.provider.displayName}</p>
      </div>
      <div className="connection-card-footer">
        <span className={`connection-status connection-status-${connection.status.state}`}>{stateLabel(connection.status.state)}</span>
        <span>{activity ? `Última actividad: ${activity}` : 'Sin actividad registrada'}</span>
        <button type="button" className="client-button-secondary" onClick={() => onOpen(connection.id)}>Abrir</button>
      </div>
    </article>
  )
}
