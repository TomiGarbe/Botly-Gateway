import { CheckCircle2, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeProviderSession, getConnectionStatusSummary } from '../api/connectionOperationsApi'
import { getConnectionQr } from '../api/connectionsApi'
import { qrSource } from '../lib/metaEmbeddedSignup'

// WhatsApp invalida el QR a los ~20s; lo renovamos antes de que el usuario escanee uno vencido.
const QR_REFRESH_MS = 20000
const STATUS_POLL_MS = 3000

/** Revincula una sesión de Evolution que perdió el login (p. ej. se cerró desde el teléfono). */
export function EvolutionQrRelink({ connectionId, onClose, onLinked }: { connectionId: string; onClose: () => void; onLinked: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLinked, setIsLinked] = useState(false)
  const [session, setSession] = useState<string | null>(null)
  const onLinkedRef = useRef(onLinked)
  onLinkedRef.current = onLinked

  const loadQr = useCallback(async () => {
    setIsLoading(true)
    try {
      const next = qrSource(await getConnectionQr(connectionId))
      setQr(next)
      setError(next ? null : 'El proveedor no devolvió un código QR. Si la sesión sigue abierta, actualizá el estado.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo generar el código QR.')
    } finally { setIsLoading(false) }
  }, [connectionId])

  useEffect(() => {
    if (isLinked) return undefined
    void loadQr()
    const interval = window.setInterval(() => { void loadQr() }, QR_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [isLinked, loadQr])

  useEffect(() => {
    if (isLinked) return undefined
    const interval = window.setInterval(() => {
      void getConnectionStatusSummary(connectionId).then((status) => { if (status.connected) setIsLinked(true); else setSession(describeProviderSession(status.providerSession)) }).catch(() => undefined)
    }, STATUS_POLL_MS)
    return () => window.clearInterval(interval)
  }, [connectionId, isLinked])

  useEffect(() => { if (isLinked) onLinkedRef.current() }, [isLinked])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="activity-panel-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="activity-panel qr-relink-panel" role="dialog" aria-modal="true" aria-label="Vincular WhatsApp con QR" onMouseDown={(event) => event.stopPropagation()}>
      <div className="activity-panel-heading"><div><h3>Vincular WhatsApp</h3><p>En el teléfono: WhatsApp › Dispositivos vinculados › Vincular un dispositivo.</p></div><button type="button" onClick={onClose} aria-label="Cerrar"><X size={18} aria-hidden="true" /></button></div>
      {isLinked ? <div className="qr-relink-state is-success" role="status"><CheckCircle2 size={22} aria-hidden="true" /><strong>Sesión vinculada</strong><span>La conexión volvió a estar operativa.</span></div> : <>
        <div className="qr-relink-frame">{qr ? <img src={qr} alt="Código QR para vincular WhatsApp" /> : <LoaderCircle className="animate-spin" size={28} aria-label="Generando código QR" />}</div>
        {error ? <p className="client-form-error" role="alert">{error}</p> : <p className="qr-relink-hint">El código se renueva solo. Esta ventana se cierra cuando el teléfono confirma la vinculación.</p>}
        {session ? <p className="qr-relink-hint" aria-live="polite">Estado del proveedor: {session}</p> : null}
        <button type="button" className="client-button-secondary" onClick={() => void loadQr()} disabled={isLoading}><RefreshCw size={15} className={isLoading ? 'animate-spin' : undefined} aria-hidden="true" /> Generar otro código</button>
      </>}
    </aside>
  </div>
}
