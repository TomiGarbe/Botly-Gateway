import { History, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'
import { getCoexistence, requestCoexistenceSync, type CoexistenceState } from '../api/coexistenceApi'

function describe(state: CoexistenceState): { label: string; tone: StatusTone; detail: string } {
  if (state.history === 'complete') return { label: 'Historial recibido', tone: 'healthy', detail: `${state.historyMessages ?? 0} mensajes listos para importar desde Botly (Canales › Historial).` }
  if (state.history === 'receiving') return { label: `Recibiendo historial (${state.historyProgress ?? 0}%)`, tone: 'configuring', detail: `${state.historyMessages ?? 0} mensajes recibidos hasta ahora.` }
  if (state.history === 'requested') return { label: 'Historial solicitado', tone: 'pending', detail: 'Meta lo envía en los próximos minutos si el negocio aceptó compartirlo.' }
  if (state.history === 'declined') return { label: 'El negocio no compartió el historial', tone: 'attention', detail: 'Se rechazó compartir el historial al vincular la app. Para recuperarlo hay que volver a hacer el alta.' }
  if (state.history === 'failed') return { label: 'No se pudo solicitar', tone: 'critical', detail: state.historyRequest?.error || 'Meta rechazó el pedido.' }
  return { label: 'Sin solicitar', tone: 'neutral', detail: 'Se puede pedir una sola vez y dentro de las 24 h posteriores al alta.' }
}

/** WhatsApp Business app + Cloud API on one number: one-time import of contacts and up to 6 months of 1:1 chats. */
export function CoexistenceSync({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<CoexistenceState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRequesting, setIsRequesting] = useState(false)

  const load = useCallback(async () => {
    try { setState(await getCoexistence(connectionId)); setError(null) } catch { setError('No se pudo consultar el estado de la sincronización.') }
  }, [connectionId])
  useEffect(() => { void load() }, [load])

  async function request() {
    setIsRequesting(true)
    try { await requestCoexistenceSync(connectionId); await load() } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo solicitar la sincronización.') } finally { setIsRequesting(false) }
  }

  if (!state) return error ? <p className="client-form-error" role="alert">{error}</p> : null
  const summary = describe(state)
  const canRequest = !state.requestedAt || state.history === 'failed'
  return <section className="connection-section">
    <div className="connection-section-heading">
      <div><h3>App de WhatsApp Business</h3><p>Si el número sigue usando la app (coexistencia), Meta comparte una vez los contactos y hasta 6 meses de chats individuales. Los grupos no se incluyen.</p></div>
      <button type="button" className="client-button-secondary" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button>
    </div>
    <dl className="connection-information-list">
      <div><dt>Historial</dt><dd><StatusBadge tone={summary.tone}>{summary.label}</StatusBadge></dd></div>
      {state.requestedAt ? <div><dt>Solicitado</dt><dd>{new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.requestedAt))}</dd></div> : null}
    </dl>
    <p className="connection-endpoint-note">{summary.detail}</p>
    {error ? <p className="client-form-error" role="alert">{error}</p> : null}
    {canRequest ? <div className="connection-inline-actions"><button type="button" className="client-button-primary" onClick={() => void request()} disabled={isRequesting}><History size={15} aria-hidden="true" /> {isRequesting ? 'Solicitando…' : 'Solicitar contactos e historial'}</button></div> : null}
  </section>
}
