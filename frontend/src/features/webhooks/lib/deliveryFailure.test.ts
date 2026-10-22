import { describe, expect, it } from 'vitest'
import { describeDeliveryFailure } from './deliveryFailure'

describe('describeDeliveryFailure', () => {
  it('distinguishes connectivity, auth, content and server failures', () => {
    expect(describeDeliveryFailure('network_error', 0).title).toBe('No se pudo conectar con el destino.')
    expect(describeDeliveryFailure('timeout', 0).title).toMatch(/tardó demasiado/)
    expect(describeDeliveryFailure('failed', 401).title).toMatch(/autenticación \(HTTP 401\)/)
    expect(describeDeliveryFailure('failed', 422).advice).toMatch(/Reenviar no lo va a resolver/)
    expect(describeDeliveryFailure('failed', 503).title).toMatch(/HTTP 503/)
  })
})
