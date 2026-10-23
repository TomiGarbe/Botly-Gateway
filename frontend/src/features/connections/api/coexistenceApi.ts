import { gatewayRequest } from '@/shared/lib/gatewayClient'

export interface CoexistenceState {
  requestedAt?: string
  history?: 'requested' | 'receiving' | 'complete' | 'declined' | 'failed'
  historyProgress?: number | null
  historyMessages?: number
  historyRequest?: { requestId?: string; error?: string }
  contacts?: { requestId?: string; error?: string }
}

export async function getCoexistence(connectionId: string): Promise<CoexistenceState> {
  const payload = await gatewayRequest<{ coexistence: CoexistenceState }>(`/connections/${encodeURIComponent(connectionId)}/whatsapp/coexistence`)
  return payload.coexistence
}

export async function requestCoexistenceSync(connectionId: string): Promise<void> {
  await gatewayRequest(`/connections/${encodeURIComponent(connectionId)}/whatsapp/coexistence/sync`, { method: 'POST' })
}
