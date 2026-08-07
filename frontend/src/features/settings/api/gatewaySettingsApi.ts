import { gatewayRequest } from '@/shared/lib/gatewayClient'

export interface GatewayChannelSettings {
  name: string
  description: string
  icon: string
  implemented: boolean
  enabled: boolean
}

export interface GatewayProviderSettings {
  name: string
  description: string
  icon: string
  implemented: boolean
  enabled: boolean
}

type ChannelsPayload = { channels: Record<string, GatewayChannelSettings> }
type ProvidersPayload = { providers: Record<string, GatewayProviderSettings> }

export async function getGatewayChannels(): Promise<Record<string, GatewayChannelSettings>> {
  return (await gatewayRequest<ChannelsPayload>('/settings/channels')).channels
}

export async function updateGatewayChannel(channelId: string, enabled: boolean): Promise<Record<string, GatewayChannelSettings>> {
  return (await gatewayRequest<ChannelsPayload>('/settings/channels', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: { [channelId]: { enabled } } }),
  })).channels
}

export async function getGatewayProviders(): Promise<Record<string, GatewayProviderSettings>> {
  return (await gatewayRequest<ProvidersPayload>('/settings/providers')).providers
}

export async function updateGatewayProvider(providerId: string, enabled: boolean): Promise<Record<string, GatewayProviderSettings>> {
  return (await gatewayRequest<ProvidersPayload>('/settings/providers', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { [providerId]: { enabled } } }),
  })).providers
}
