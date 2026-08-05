import type { Connection } from '@/domain/connection'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'

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

function stateDetails(connection: Connection): { label: string; tone: StatusTone } {
  if (connection.status.state === 'connected' || connection.status.health === 'healthy') return { label: 'Operativa', tone: 'healthy' }
  if (connection.status.state === 'pending') return { label: 'Pendiente', tone: 'pending' }
  if (connection.status.state === 'connecting') return { label: 'Configurando', tone: 'configuring' }
  if (connection.status.health === 'unhealthy' || connection.status.state === 'disconnected') return { label: 'Problema crítico', tone: 'critical' }
  return { label: 'Atención requerida', tone: 'attention' }
}

export function ConnectionCard({ connection, onOpen }: ConnectionCardProps) {
  const activity = activityLabel(connection.lastActivityAt)
  const state = stateDetails(connection)

  return (
    <article className="connection-card" role="button" tabIndex={0} aria-label={`Abrir conexión ${connection.name}`} onClick={() => onOpen(connection.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(connection.id) } }}>
      <div>
        <h3>{connection.name}</h3>
        <p>{connection.channel.displayName} · {connection.provider.displayName}</p>
      </div>
      <div className="connection-card-footer">
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
        <span>{activity ? `Última actividad: ${activity}` : 'Sin actividad registrada'}</span>
      </div>
    </article>
  )
}
