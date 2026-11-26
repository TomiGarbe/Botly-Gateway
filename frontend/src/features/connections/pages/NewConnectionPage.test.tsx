// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConnectionStatusSummary } from '../api/connectionOperationsApi'
import { getConnectionSetupQr } from '../api/connectionSetupsApi'
import { NewConnectionPage } from './NewConnectionPage'

const setup = { id: 's1', clientId: 'c1', name: 'Ventas', provider: 'evolution', channel: 'whatsapp', state: 'ready', connectionId: 'conn1', expiresAt: null, cleanupRequired: false, diagnostic: null }

vi.mock('@/app/providers/AuthProvider', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }))
vi.mock('@/features/clients/api/clientsApi', () => ({ getClient: vi.fn(async () => ({ id: 'c1', name: 'Chanti SRL' })) }))
vi.mock('@/features/settings/api/gatewaySettingsApi', () => ({
  getGatewayChannels: vi.fn(async () => ({ whatsapp: { name: 'WhatsApp', description: '', icon: '', implemented: true, enabled: true } })),
  getGatewayProviders: vi.fn(async () => ({ evolution: { name: 'Evolution', description: '', icon: '', implemented: true, enabled: true } })),
}))
vi.mock('../api/connectionSetupsApi', () => ({
  createConnectionSetup: vi.fn(async () => setup),
  getConnectionSetup: vi.fn(),
  cancelConnectionSetup: vi.fn(),
  getConnectionSetupQr: vi.fn(),
}))
vi.mock('../api/connectionOperationsApi', () => ({ getConnectionStatusSummary: vi.fn(async () => ({ connected: false })) }))
vi.mock('../api/connectionsApi', () => ({ getConnection: vi.fn() }))
vi.mock('../api/metaSignupApi', () => ({ completeMetaSignup: vi.fn(), getMetaSignupConfig: vi.fn() }))

function renderPage() {
  render(<MemoryRouter initialEntries={['/clients/c1/connections/new/whatsapp']}><Routes>
    <Route path="/clients/:clientId/connections/new/:channel" element={<NewConnectionPage />} />
    <Route path="/connections/:connectionId" element={<p>Detalle de conexión</p>} />
  </Routes></MemoryRouter>)
}

async function startEvolutionSetup() {
  renderPage()
  fireEvent.change(await screen.findByLabelText(/Nombre de la conexión/), { target: { value: 'Ventas' } })
  fireEvent.click(screen.getByRole('button', { name: /WhatsApp con Evolution/ }))
}

describe('NewConnectionPage — Evolution QR', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); sessionStorage.clear() })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('renews the QR on its own so the phone never scans an expired code', async () => {
    vi.mocked(getConnectionSetupQr).mockResolvedValueOnce({ base64: 'data:image/png;base64,FIRST' }).mockResolvedValue({ base64: 'data:image/png;base64,SECOND' })
    await startEvolutionSetup()
    const image = await screen.findByAltText('Código QR para conectar WhatsApp con Evolution')
    expect(image.getAttribute('src')).toBe('data:image/png;base64,FIRST')

    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    await waitFor(() => expect(screen.getByAltText('Código QR para conectar WhatsApp con Evolution').getAttribute('src')).toBe('data:image/png;base64,SECOND'))
  })

  it('opens the connection once the phone confirms the link', async () => {
    vi.mocked(getConnectionSetupQr).mockResolvedValue({ base64: 'data:image/png;base64,QR' })
    await startEvolutionSetup()
    await screen.findByAltText('Código QR para conectar WhatsApp con Evolution')

    vi.mocked(getConnectionStatusSummary).mockResolvedValue({ connected: true } as Awaited<ReturnType<typeof getConnectionStatusSummary>>)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000 + 750) })
    expect(await screen.findByText('Detalle de conexión')).toBeTruthy()
  })
})
