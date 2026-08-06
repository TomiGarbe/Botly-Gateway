import { Camera, MessageCircle, MessagesSquare, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { LoadingState } from '@/shared/components/LoadingState'
import { getGatewayChannels, type GatewayChannelSettings, updateGatewayChannel } from '../api/gatewaySettingsApi'

const channelIcons: Record<string, LucideIcon> = {
  'message-circle': MessageCircle,
  instagram: Camera,
  facebook: MessagesSquare,
  send: Send,
}

export function SettingsPage() {
  const [channels, setChannels] = useState<Record<string, GatewayChannelSettings> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const loadChannels = useCallback(async () => {
    try {
      setError(null)
      setChannels(await getGatewayChannels())
    } catch {
      setError('No pudimos cargar los canales disponibles.')
    }
  }, [])

  useEffect(() => { void loadChannels() }, [loadChannels])

  async function toggleChannel(channelId: string, enabled: boolean) {
    setSaving(channelId)
    setError(null)
    try {
      setChannels(await updateGatewayChannel(channelId, enabled))
    } catch {
      setError('No pudimos actualizar la configuración del canal.')
    } finally {
      setSaving(null)
    }
  }

  if (!channels && !error) return <LoadingState label="Cargando configuración…" />

  return <section className="settings-page">
    <div className="settings-heading"><p>Configuración</p><h2>Canales disponibles</h2><span>Definí qué canales se pueden utilizar en el Gateway.</span></div>
    {error ? <div className="settings-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadChannels()}>Reintentar</button></div> : null}
    {channels ? <div className="settings-channel-list">
      {Object.entries(channels).map(([channelId, channel]) => {
        const Icon = channelIcons[channel.icon] || MessageCircle
        const canToggle = channel.implemented && saving !== channelId
        return <article key={channelId} className="settings-channel-card">
          <Icon size={21} aria-hidden="true" />
          <div><h3>{channel.name}</h3><p>{channel.description}</p><small>{channel.implemented ? 'Implementado' : 'Próximamente'}</small></div>
          <label className="settings-channel-toggle">
            <span>{channel.implemented ? (channel.enabled ? 'Habilitado' : 'Deshabilitado') : 'Próximamente'}</span>
            <input type="checkbox" checked={channel.enabled} disabled={!canToggle} onChange={(event) => void toggleChannel(channelId, event.target.checked)} aria-label={`Habilitar ${channel.name}`} />
          </label>
        </article>
      })}
    </div> : null}
  </section>
}
