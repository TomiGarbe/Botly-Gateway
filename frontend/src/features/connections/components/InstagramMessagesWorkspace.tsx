import { Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Connection } from '@/domain/connection'
import { Input, Textarea } from '@/shared/components/FormControls'
import { Toast } from '@/shared/components/Toast'
import { gatewayRequest } from '@/shared/lib/gatewayClient'

export function InstagramMessagesWorkspace({ connection }: { connection: Connection }) {
  const [externalId, setExternalId] = useState(''); const [text, setText] = useState(''); const [error, setError] = useState<string | null>(null); const [sending, setSending] = useState(false)
  const ready = Boolean(connection.readiness?.ready)
  const send = useCallback(async () => {
    if (!connection.runtimeName) throw new Error('La conexión no tiene una URL de envío disponible.')
    await gatewayRequest(`/messages/${encodeURIComponent(connection.runtimeName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ external_id: externalId, text }),
    })
  }, [connection.runtimeName, externalId, text])
  useEffect(() => { setError(null) }, [connection.id])
  return <section className="connection-section workspace-messages"><h3>Mensajes</h3><p className="connection-section-value">El destinatario es un External ID opaco de Instagram, nunca un teléfono.</p><Toast message={error} tone="error" onDismiss={() => setError(null)} />{!ready ? <p className="connection-section-value">La conexión no está lista para enviar. Revisá Seguridad.</p> : null}<form className="workspace-composer" onSubmit={async event => { event.preventDefault(); if (!externalId.trim() || !text.trim()) return setError('Ingresá el External ID y el mensaje.'); setSending(true); try { await send(); setText('') } catch { setError('No se pudo enviar el mensaje de Instagram.') } finally { setSending(false) } }}><label><span>Recipient External ID</span><Input value={externalId} onChange={event => setExternalId(event.target.value)} placeholder="Instagram scoped user ID" disabled={!ready || sending} required /></label><label><span>Mensaje</span><Textarea value={text} onChange={event => setText(event.target.value)} rows={3} disabled={!ready || sending} required /></label><button className="client-button-primary" type="submit" disabled={!ready || sending}><Send size={15} />{sending ? 'Enviando…' : 'Enviar texto'}</button></form></section>
}
