import { Instagram, MessageCircle } from 'lucide-react'
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

export function connectionState(connection: Connection): { label: string; tone: StatusTone } {
  if (connection.status.state === 'connected' || connection.status.health === 'healthy') return { label: 'Operativa', tone: 'healthy' }
  if (connection.status.state === 'pending') return { label: 'Pendiente', tone: 'pending' }
  if (connection.status.state === 'connecting') return { label: 'Configurando', tone: 'configuring' }
  if (connection.status.health === 'unhealthy' || connection.status.state === 'disconnected') return { label: 'Problema crítico', tone: 'critical' }
  return { label: 'Atención requerida', tone: 'attention' }
}

/** "5491122334455@s.whatsapp.net" → "+5491122334455"; other addresses (Instagram handles) pass through. */
export function connectionAddress(address: string | null): string | null {
  if (!address) return null
  const local = address.split('@')[0]
  return /^\d{8,15}$/.test(local) ? `+${local}` : local
}

export function ConnectionCard({ connection, onOpen }: ConnectionCardProps) {
  const activity = activityLabel(connection.lastActivityAt)
  const state = connectionState(connection)
  const ChannelIcon = connection.channel.id === 'instagram' ? Instagram : MessageCircle
  const account = [connection.displayName !== connection.name ? connection.displayName : null, connectionAddress(connection.address)].filter(Boolean).join(' · ')

  return (
    <article className={`connection-card connection-card-${state.tone}`} role="button" tabIndex={0} aria-label={`Abrir conexión ${connection.name}`} onClick={() => onOpen(connection.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(connection.id) } }}>
      <div className="connection-card-head">
        <span className="connection-card-icon" aria-hidden="true"><ChannelIcon size={18} /></span>
        <div className="connection-card-title">
          <h3>{connection.name}</h3>
          <p>{account || `${connection.channel.displayName} · ${connection.provider.displayName}`}</p>
        </div>
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
      </div>
      <div className="connection-card-footer">
        <span>{connection.client?.name || 'Sin cliente'}</span>
        <span>{connection.channel.displayName} · {connection.provider.displayName}</span>
        <span>{activity ? `Actividad: ${activity}` : 'Sin actividad registrada'}</span>
      </div>
    </article>
  )
}
