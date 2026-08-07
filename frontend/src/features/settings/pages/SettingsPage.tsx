import { Boxes, Camera, Check, MessageCircle, MessagesSquare, Send, Server, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { LoadingState } from '@/shared/components/LoadingState'
import {
  getGatewayChannels,
  getGatewayProviders,
  type GatewayChannelSettings,
  type GatewayProviderSettings,
  updateGatewayChannel,
  updateGatewayProvider,
} from '../api/gatewaySettingsApi'

const channelIcons: Record<string, LucideIcon> = {
  'message-circle': MessageCircle,
  instagram: Camera,
  facebook: MessagesSquare,
  send: Send,
}

const providerIcons: Record<string, LucideIcon> = {
  meta: Boxes,
  server: Server,
}

export function SettingsPage() {
  const [channels, setChannels] = useState<Record<string, GatewayChannelSettings> | null>(null)
  const [providers, setProviders] = useState<Record<string, GatewayProviderSettings> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const loadSettings = useCallback(async () => {
    try {
      setError(null)
      const [nextChannels, nextProviders] = await Promise.all([getGatewayChannels(), getGatewayProviders()])
      setChannels(nextChannels)
      setProviders(nextProviders)
    } catch {
      setError('No pudimos cargar la configuración disponible.')
    }
  }, [])

  useEffect(() => { void loadSettings() }, [loadSettings])

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

  async function toggleProvider(providerId: string, enabled: boolean) {
    setSaving(providerId)
    setError(null)
    try {
      setProviders(await updateGatewayProvider(providerId, enabled))
    } catch {
      setError('No pudimos actualizar la configuración del proveedor.')
    } finally {
      setSaving(null)
    }
  }

  if ((!channels || !providers) && !error) return <LoadingState label="Cargando configuración…" />

  return <section className="settings-page">
    <div className="settings-heading"><p>Configuración</p><h2>Canales y proveedores</h2><span>Definí qué canales y proveedores se pueden utilizar en el Gateway.</span></div>
    {error ? <div className="settings-error" role="alert"><p>{error}</p><button type="button" onClick={() => void loadSettings()}>Reintentar</button></div> : null}
    {providers ? <SettingsList title="Proveedores" description="Controlan las nuevas conexiones que usan Meta y Evolution." items={providers} icons={providerIcons} saving={saving} onToggle={toggleProvider} /> : null}
    {channels ? <SettingsList title="Canales disponibles" description="Definí qué canales se pueden utilizar en el Gateway." items={channels} icons={channelIcons} saving={saving} onToggle={toggleChannel} /> : null}
  </section>
}

function SettingsList({
  title,
  description,
  items,
  icons,
  saving,
  onToggle,
}: {
  title: string
  description: string
  items: Record<string, GatewayChannelSettings | GatewayProviderSettings>
  icons: Record<string, LucideIcon>
  saving: string | null
  onToggle: (id: string, enabled: boolean) => Promise<void>
}) {
  return <div className="settings-group"><h3>{title}</h3><p>{description}</p><div className="settings-channel-list">
    {Object.entries(items).map(([id, item]) => {
      const Icon = icons[item.icon] || Server
      const canToggle = item.implemented && saving !== id
      return <article key={id} className="settings-channel-card">
        <Icon size={21} aria-hidden="true" />
        <div><h3>{item.name}</h3><p>{item.description}</p><small>{item.implemented ? 'Implementado' : 'Próximamente'}</small></div>
        <button
          type="button"
          role="switch"
          aria-checked={item.enabled}
          aria-label={`${item.enabled ? 'Deshabilitar' : 'Habilitar'} ${item.name}`}
          className={`settings-channel-toggle ${item.enabled ? 'is-enabled' : ''}`}
          disabled={!canToggle}
          onClick={() => void onToggle(id, !item.enabled)}
        >
          <span className="settings-channel-toggle-label">{item.implemented ? (item.enabled ? 'Activo' : 'Inactivo') : 'Próximamente'}</span>
          <span className="settings-channel-toggle-track" aria-hidden="true"><span className="settings-channel-toggle-thumb">{item.enabled ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}</span></span>
        </button>
      </article>
    })}
  </div></div>
}
