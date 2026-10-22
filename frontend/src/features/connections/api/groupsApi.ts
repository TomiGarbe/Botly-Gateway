import { gatewayRequest } from '@/shared/lib/gatewayClient'

export type GroupState = 'captured' | 'excluded' | 'not_authorized'

export interface ConnectionGroup {
  externalId: string
  displayName: string
  state: GroupState
  participants: number
  delivered: number
  failed: number
  lastEventAt: number | null
  lastEventStatus: string | null
  lastError: string | null
}

export interface ConnectionGroups {
  configured: boolean
  enabled: boolean
  admission: 'account' | 'explicit'
  coreChannelId: string | null
  botIdentities: string[]
  directoryLoaded: boolean
  groups: ConnectionGroup[]
}

export function listConnectionGroups(connectionId: string): Promise<ConnectionGroups> {
  return gatewayRequest<ConnectionGroups>(`/connections/${encodeURIComponent(connectionId)}/groups`)
}
