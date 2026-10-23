// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getCoexistence: vi.fn(), requestCoexistenceSync: vi.fn() }))
vi.mock('../api/coexistenceApi', () => api)

import { CoexistenceSync } from './CoexistenceSync'

describe('CoexistenceSync', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('requests the one-time sync and then shows its state', async () => {
    api.getCoexistence.mockResolvedValueOnce({}).mockResolvedValueOnce({ requestedAt: '2026-10-23T10:00:00Z', history: 'requested' })
    api.requestCoexistenceSync.mockResolvedValue(undefined)
    render(<CoexistenceSync connectionId="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Solicitar contactos e historial/ }))
    expect(await screen.findByText('Historial solicitado')).toBeTruthy()
    expect(api.requestCoexistenceSync).toHaveBeenCalledWith('c1')
    expect(screen.queryByRole('button', { name: /Solicitar contactos/ })).toBeNull()
  })

  it('explains when the business declined to share history', async () => {
    api.getCoexistence.mockResolvedValue({ requestedAt: '2026-10-23T10:00:00Z', history: 'declined' })
    render(<CoexistenceSync connectionId="c1" />)
    expect(await screen.findByText('El negocio no compartió el historial')).toBeTruthy()
  })
})
