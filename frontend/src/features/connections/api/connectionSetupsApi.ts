import { gatewayRequest } from '@/shared/lib/gatewayClient'

export interface ConnectionSetup {
  id: string
  clientId: string
  name: string
  provider: 'meta' | 'evolution'
  channel: string
  state: string
  connectionId: string | null
  expiresAt: string
  cleanupRequired: boolean
  diagnostic: { code?: string; message?: string } | null
}

interface ApiConnectionSetup {
  id: string; client_id: string; name: string; provider: 'meta' | 'evolution'; channel: string
  state: string; connection_id: string | null; expires_at: string; cleanup_required: boolean; diagnostic: { code?: string; message?: string } | null
}

function toSetup(item: ApiConnectionSetup): ConnectionSetup {
  return { id: item.id, clientId: item.client_id, name: item.name, provider: item.provider, channel: item.channel, state: item.state, connectionId: item.connection_id, expiresAt: item.expires_at, cleanupRequired: item.cleanup_required, diagnostic: item.diagnostic }
}

export async function createConnectionSetup(input: { clientId: string; channel: string; name: string; provider: 'meta' | 'evolution' }): Promise<ConnectionSetup> {
  const item = await gatewayRequest<ApiConnectionSetup>('/connection-setups', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ client_id: input.clientId, channel: input.channel, name: input.name, provider: input.provider }) })
  return toSetup(item)
}

export async function getConnectionSetupQr(setupId: string): Promise<{ qrcode?: { base64?: string; code?: string } }> {
  return gatewayRequest<{ qrcode?: { base64?: string; code?: string } }>(`/connection-setups/${encodeURIComponent(setupId)}/qr`)
}

export async function getConnectionSetup(setupId: string): Promise<ConnectionSetup> {
  return toSetup(await gatewayRequest<ApiConnectionSetup>(`/connection-setups/${encodeURIComponent(setupId)}`))
}

export async function cancelConnectionSetup(setupId: string): Promise<ConnectionSetup> {
  return toSetup(await gatewayRequest<ApiConnectionSetup>(`/connection-setups/${encodeURIComponent(setupId)}/cancel`, { method: 'POST' }))
}
