import type { Channel } from '../channel/model'
import type { Provider } from '../provider/model'

export interface ConnectionCapabilities {
  supportsMessaging: boolean
  supportsWebhook: boolean
  supportsMedia: boolean
  supportsQr: boolean
  supportsReconnect: boolean
  supportsApiKey: boolean
  supportsOfficialApi: boolean
  supportsTemplates: boolean
}

export interface ConnectionStatus {
  state: 'pending' | 'connected' | 'connecting' | 'disconnected'
  lifecycle: string | null
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
}

export interface ConnectionClient {
  id: string
  name: string
}

export interface Connection {
  id: string
  clientId: string
  name: string
  displayName: string | null
  address: string | null
  provider: Provider
  channel: Channel
  status: ConnectionStatus
  capabilities: ConnectionCapabilities
  webhook: { supported: boolean }
  apiKey: { supported: boolean }
  client: ConnectionClient | null
  lastActivityAt: string | null
  createdAt: string | null
  updatedAt: string | null
  runtimeName: string | null
}

export interface CreateConnectionInput {
  clientId: string
  channel: string
}
