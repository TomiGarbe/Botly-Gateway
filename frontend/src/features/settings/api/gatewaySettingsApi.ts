import { gatewayRequest } from '@/shared/lib/gatewayClient'

export interface GatewayChannelSettings {
  name: string
  description: string
  icon: string
  implemented: boolean
  enabled: boolean
}

type ChannelsPayload = { channels: Record<string, GatewayChannelSettings> }

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
