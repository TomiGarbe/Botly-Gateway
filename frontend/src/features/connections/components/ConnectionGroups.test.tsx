// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listConnectionGroups } = vi.hoisted(() => ({ listConnectionGroups: vi.fn() }))
vi.mock('../api/groupsApi', () => ({ listConnectionGroups }))

import { ConnectionGroups } from './ConnectionGroups'

const group = (overrides: object) => ({ externalId: 'a@g.us', displayName: 'Ventas', state: 'captured', participants: 3, delivered: 10, failed: 0, lastEventAt: 1_790_000_000_000, lastEventStatus: 'delivered', lastError: null, ...overrides })

describe('ConnectionGroups', () => {
  afterEach(() => { cleanup(); listConnectionGroups.mockReset() })

  it('summarizes the account transport and highlights failing groups', async () => {
    listConnectionGroups.mockResolvedValue({
      configured: true, enabled: true, admission: 'account', coreChannelId: 'core-1', botIdentities: ['bot@s.whatsapp.net'], directoryLoaded: true,
      groups: [group({}), group({ externalId: 'b@g.us', displayName: 'Soporte', failed: 2, lastError: 'core_unavailable' }), group({ externalId: 'c@g.us', displayName: 'Familia', state: 'excluded' })],
    })
    render(<ConnectionGroups connectionId="conn-1" />)
    expect(await screen.findByText('Ventas')).toBeTruthy()
    expect(listConnectionGroups).toHaveBeenCalledWith('conn-1')
    expect(screen.getByText('Activo')).toBeTruthy()
    expect(screen.getByText('2 fallidos')).toBeTruthy()
    expect(screen.getByText('Último error: core_unavailable')).toBeTruthy()
    expect(screen.getByText('Excluido en Botly')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Buscar grupo'), { target: { value: 'sop' } })
    expect(screen.queryByText('Ventas')).toBeNull()
    expect(screen.getByText('Soporte')).toBeTruthy()
  })

  it('explains an account that Botly has not linked yet', async () => {
    listConnectionGroups.mockResolvedValue({ configured: false, enabled: false, admission: 'explicit', coreChannelId: null, botIdentities: [], directoryLoaded: false, groups: [] })
    render(<ConnectionGroups connectionId="conn-2" />)
    expect(await screen.findByText('Sin vincular')).toBeTruthy()
    expect(screen.getByText('Sin grupos todavía')).toBeTruthy()
  })
})
