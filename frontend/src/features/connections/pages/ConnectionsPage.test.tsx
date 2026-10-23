// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '@/domain/connection'
import { ConnectionsPage } from './ConnectionsPage'

const connection = (id: string, name: string, state: 'connected' | 'disconnected', address: string | null = null) => ({
  id, clientId: 'c1', name, displayName: null, address,
  provider: { id: 'evolution', displayName: 'Evolution' }, channel: { id: 'whatsapp', displayName: 'WhatsApp' },
  status: { state, lifecycle: null, health: state === 'connected' ? 'healthy' : 'unhealthy' },
  client: { id: 'c1', name: 'Chanti SRL' }, lastActivityAt: null,
}) as unknown as Connection

vi.mock('../api/connectionsApi', () => ({
  listConnections: vi.fn(async () => [connection('a', 'Atención', 'connected'), connection('b', 'Ventas', 'disconnected', '5491122334455@s.whatsapp.net')]),
}))

describe('ConnectionsPage', () => {
  it('puts broken connections first and filters by state and phone number', async () => {
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2))
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['Ventas', 'Atención'])

    fireEvent.click(screen.getByRole('button', { name: /Operativas/ }))
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['Atención'])

    fireEvent.click(screen.getByRole('button', { name: /Todas/ }))
    fireEvent.change(screen.getByLabelText('Buscar conexiones'), { target: { value: '+549112233' } })
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['Ventas'])
  })
})
