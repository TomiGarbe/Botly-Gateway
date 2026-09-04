import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayRequest } from '@/shared/lib/gatewayClient'
import { bindInstagramCoreChannel, listInstagramCoreChannels } from './connectionsApi'

vi.mock('@/shared/lib/gatewayClient', () => ({ gatewayRequest: vi.fn() }))

const connectionPayload = {
  id: 'connection-a', client_id: 'client-a', name: 'Instagram', display_name: null, address: null,
  provider: { id: 'meta', display_name: 'Meta' }, channel: { id: 'instagram', display_name: 'Instagram' },
  status: { state: 'connected', lifecycle: null, health: 'healthy' },
  capabilities: { supports_messaging: true, supports_webhook: true, supports_media: true, supports_qr: false, supports_reconnect: false, supports_api_key: false, supports_official_api: false, supports_templates: false },
  webhook: { supported: true }, api_key: { supported: false }, client: { id: 'client-a', name: 'Client A' },
  last_activity_at: null, created_at: null, updated_at: null, runtime_name: null,
  provider_account: null, core_channel: { channelId: 'channel-a', name: 'Instagram consultas', configured: true }, readiness: null,
}

describe('Instagram Core Channel API contract', () => {
  beforeEach(() => vi.mocked(gatewayRequest).mockReset())

  it('sends only the selected Core Channel identifier for a binding', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue(connectionPayload as never)

    await bindInstagramCoreChannel('connection-a', 'channel-a')

    const [, options] = vi.mocked(gatewayRequest).mock.calls[0]
    expect(options?.method).toBe('PUT')
    expect(JSON.parse(String(options?.body))).toEqual({ core_channel_id: 'channel-a' })
  })

  it('returns only the safe metadata supplied by the Core Channel discovery route', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({
      items: [{ id: 'channel-a', name: 'Instagram consultas', channel_type: 'instagram', status: 'active' }],
    } as never)

    await expect(listInstagramCoreChannels('connection-a')).resolves.toEqual([
      { id: 'channel-a', name: 'Instagram consultas', channel_type: 'instagram', status: 'active' },
    ])
  })
})
