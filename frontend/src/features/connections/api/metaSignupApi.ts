import type { Connection } from '@/domain/connection'
import { gatewayRequest } from '@/shared/lib/gatewayClient'
import { toConnection } from './connectionsApi'

export interface MetaSignupConfig {
  enabled: boolean
  app_id: string | null
  config_id: string | null
  graph_version: string
  supports_coexistence: boolean
}

interface EmbeddedSignupSession {
  phoneNumberId?: string
  businessAccountId: string
  raw: Record<string, unknown>
}

/** Un setup nuevo o una conexión existente que se reautoriza. */
export type MetaSignupTarget = { setupId: string } | { connectionId: string }

export async function getMetaSignupConfig(): Promise<MetaSignupConfig> {
  return gatewayRequest<MetaSignupConfig>('/meta/signup/config')
}

export async function completeMetaSignup(
  target: MetaSignupTarget,
  code: string,
  session: EmbeddedSignupSession,
  coexistenceRequested: boolean,
  registrationPin?: string,
): Promise<Connection> {
  const trimmedPin = (registrationPin ?? '').trim()
  const payload = await gatewayRequest<Parameters<typeof toConnection>[0]>('/meta/signup/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...('setupId' in target ? { setup_id: target.setupId } : { connection_id: target.connectionId }),
      code,
      ...(session.phoneNumberId ? { phone_number_id: session.phoneNumberId } : {}),
      business_account_id: session.businessAccountId,
      session_info: { ...session.raw, coexistenceRequested },
      ...(trimmedPin ? { registration_pin: trimmedPin } : {}),
    }),
  })
  return toConnection(payload)
}
