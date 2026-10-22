// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getConnectionQr: vi.fn(), getConnectionStatusSummary: vi.fn(), describeProviderSession: vi.fn(() => null) }))
vi.mock('../api/connectionsApi', () => ({ getConnectionQr: api.getConnectionQr }))
vi.mock('../api/connectionOperationsApi', () => ({ getConnectionStatusSummary: api.getConnectionStatusSummary, describeProviderSession: api.describeProviderSession }))

import { EvolutionQrRelink } from './EvolutionQrRelink'

describe('EvolutionQrRelink', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('closes as linked when the session is already open', async () => {
    api.getConnectionQr.mockResolvedValue({ connected: true })
    const onLinked = vi.fn()
    render(<EvolutionQrRelink connectionId="c1" onClose={vi.fn()} onLinked={onLinked} />)
    expect(await screen.findByText('Sesión vinculada')).toBeTruthy()
    expect(onLinked).toHaveBeenCalled()
  })

  it('shows the reason instead of spinning when no QR can be generated', async () => {
    api.getConnectionQr.mockRejectedValue(new Error('Esta conexión la administra otro Gateway; vinculala desde ese panel.'))
    render(<EvolutionQrRelink connectionId="c1" onClose={vi.fn()} onLinked={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/otro Gateway/)
    expect(screen.queryByLabelText('Generando código QR')).toBeNull()
  })
})
