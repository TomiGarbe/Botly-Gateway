import type { Client, ClientInput } from '@/domain/client'
import { gatewayRequest } from '@/shared/lib/gatewayClient'

interface ApiClient {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  connection_count: number
  last_activity_at: string | null
}

function toClient(payload: ApiClient): Client {
  return {
    id: payload.id,
    name: payload.name,
    description: payload.description,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    connectionCount: payload.connection_count,
    lastActivityAt: payload.last_activity_at,
  }
}

function clientRequestInit(method: 'POST' | 'PATCH', input: ClientInput): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      description: input.description || null,
    }),
  }
}

export async function listClients(): Promise<Client[]> {
  const payload = await gatewayRequest<ApiClient[]>('/clients')
  return payload.map(toClient)
}

export async function getClient(clientId: string): Promise<Client> {
  const payload = await gatewayRequest<ApiClient>(`/clients/${encodeURIComponent(clientId)}`)
  return toClient(payload)
}

export async function createClient(input: ClientInput): Promise<Client> {
  const payload = await gatewayRequest<ApiClient>('/clients', clientRequestInit('POST', input))
  return toClient(payload)
}

export async function updateClient(clientId: string, input: ClientInput): Promise<Client> {
  const payload = await gatewayRequest<ApiClient>(
    `/clients/${encodeURIComponent(clientId)}`,
    clientRequestInit('PATCH', input),
  )
  return toClient(payload)
}

export async function deleteClient(clientId: string): Promise<void> {
  await gatewayRequest<void>(`/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
}
