import { AlertCircle, Check, CheckCheck, FileText, Image, LoaderCircle, Mic, RefreshCw, Send, Video, X } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { MessageKind, TimelineMessage } from '../api/messagesApi'
import { listTimelineMessages, sendWorkspaceMessage } from '../api/messagesApi'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const types: Array<{ value: MessageKind; label: string; accept: string }> = [
  { value: 'image', label: 'Imagen', accept: 'image/*' },
  { value: 'audio', label: 'Audio', accept: 'audio/*' },
  { value: 'document', label: 'Documento', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip' },
  { value: 'video', label: 'Video', accept: 'video/*' },
]

function phone(value: string | null): string {
  return String(value || '').replace(/\D/g, '')
}

function time(value: number): string {
  return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function typeIcon(kind: string) {
  if (kind === 'image') return <Image size={16} aria-hidden="true" />
  if (kind === 'audio') return <Mic size={16} aria-hidden="true" />
  if (kind === 'video') return <Video size={16} aria-hidden="true" />
  return <FileText size={16} aria-hidden="true" />
}

function statusLabel(status: string | null): string | null {
  if (!status) return null
  return ({ sent: 'Enviado', accepted: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'No enviado' } as Record<string, string>)[status.toLowerCase()] || null
}

function MessageStatus({ status }: { status: string | null }) {
  const label = statusLabel(status)
  if (!label) return null
  const Icon = status?.toLowerCase() === 'read' || status?.toLowerCase() === 'delivered' ? CheckCheck : Check
  return <span className="workspace-message-status"><Icon size={13} aria-hidden="true" /> {label}</span>
}

export function MessagesWorkspace({ runtimeName }: { runtimeName: string | null }) {
  const [messages, setMessages] = useState<TimelineMessage[]>([])
  const [number, setNumber] = useState('')
  const [text, setText] = useState('')
  const [attachmentType, setAttachmentType] = useState<MessageKind | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [caption, setCaption] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(runtimeName))
  const [isSending, setIsSending] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!runtimeName) return
    if (!quiet) setIsLoading(true)
    try {
      setMessages(await listTimelineMessages(runtimeName))
    } catch {
      if (!quiet) setError('No pudimos actualizar los mensajes. Intentá nuevamente.')
    } finally {
      if (!quiet) setIsLoading(false)
    }
  }, [runtimeName])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!runtimeName) return
    const interval = window.setInterval(() => { void load(true) }, 5000)
    return () => window.clearInterval(interval)
  }, [load, runtimeName])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const visibleMessages = useMemo(() => {
    const target = phone(number)
    if (!target) return messages
    return messages.filter((message) => phone(message.sender) === target || phone(message.recipient) === target)
  }, [messages, number])

  function chooseFile(next: File | null) {
    setError(null)
    if (!next) return setFile(null)
    if (next.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      setError('El archivo supera el límite de 25 MB.')
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(next)
    setPreviewUrl(next.type.startsWith('image/') || next.type.startsWith('audio/') || next.type.startsWith('video/') ? URL.createObjectURL(next) : null)
  }

  function clearAttachment() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setFile(null)
    setAttachmentType(null)
    setCaption('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!runtimeName) return
    const target = phone(number)
    if (target.length < 8) return setError('Ingresá un número de WhatsApp válido, con código de país.')
    if (!attachmentType && !text.trim()) return setError('Escribí un mensaje antes de enviarlo.')
    if (attachmentType && !file) return setError('Seleccioná el archivo que querés enviar.')
    setError(null)
    setNotice(null)
    setIsSending(true)
    setProgress(0)
    try {
      await sendWorkspaceMessage(runtimeName, attachmentType
        ? { number: target, type: attachmentType, file: file || undefined, caption }
        : { number: target, type: 'text', text: text.trim() }, setProgress)
      setText('')
      clearAttachment()
      setNotice('Mensaje enviado.')
      await load(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo enviar el mensaje.')
    } finally {
      setIsSending(false)
      setProgress(0)
    }
  }

  if (!runtimeName) return <section className="connection-section"><h3>Mensajes</h3><p className="connection-section-value">La conexión todavía no está lista para mensajería.</p></section>

  return (
    <section className="connection-section workspace-messages">
      <div className="connection-section-heading"><div><h3>Mensajes</h3><p>Verificá el envío, la recepción y los estados de esta conexión.</p></div><button type="button" className="client-button-secondary" onClick={() => void load()} disabled={isLoading}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></div>
      {error ? <p className="workspace-feedback workspace-feedback-error" role="alert"><AlertCircle size={15} aria-hidden="true" /> {error}</p> : null}
      {notice ? <p className="workspace-feedback workspace-feedback-success" role="status"><Check size={15} aria-hidden="true" /> {notice}</p> : null}
      <div className="workspace-thread" aria-live="polite">
        {isLoading ? <p className="workspace-empty"><LoaderCircle className="animate-spin" size={17} /> Cargando mensajes…</p> : null}
        {!isLoading && visibleMessages.length === 0 ? <p className="workspace-empty">Todavía no hay mensajes para esta conexión.</p> : null}
        {visibleMessages.map((message) => <article className={`workspace-message workspace-message-${message.direction}`} key={`${message.id}-${message.timestamp}`}>
          <div className="workspace-message-body">
            {message.media ? <div className="workspace-media-summary">{typeIcon(message.kind)}<span>{message.media.fileName || (message.kind === 'document' ? 'Documento' : `Archivo ${message.kind}`)}</span></div> : null}
            {message.text ? <p>{message.text}</p> : !message.media ? <p>Mensaje sin contenido legible.</p> : null}
          </div>
          <footer><time dateTime={new Date(message.timestamp).toISOString()}>{time(message.timestamp)}</time>{message.direction === 'outbound' ? <MessageStatus status={message.status} /> : <span className="workspace-message-type">{message.kind}</span>}</footer>
        </article>)}
      </div>
      <form className="workspace-composer" onSubmit={submit}>
        <label><span>Número de destino</span><input inputMode="numeric" value={number} onChange={(event) => setNumber(event.target.value)} placeholder="549…" disabled={isSending} required /></label>
        {attachmentType ? <div className="workspace-attachment">
          <div className="workspace-attachment-heading"><span>{types.find((type) => type.value === attachmentType)?.label}</span><button type="button" onClick={clearAttachment} disabled={isSending} aria-label="Quitar archivo"><X size={16} /></button></div>
          <input type="file" accept={types.find((type) => type.value === attachmentType)?.accept} onChange={(event) => chooseFile(event.target.files?.[0] || null)} disabled={isSending} />
          {file ? <p>{file.name} · {Math.ceil(file.size / 1024)} KB</p> : null}
          {previewUrl && attachmentType === 'image' ? <img src={previewUrl} alt="Vista previa del archivo" /> : null}
          {previewUrl && attachmentType === 'audio' ? <audio controls src={previewUrl} /> : null}
          {previewUrl && attachmentType === 'video' ? <video controls src={previewUrl} /> : null}
          <input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Descripción opcional" maxLength={4096} disabled={isSending} />
        </div> : <label><span>Mensaje</span><textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={4096} placeholder="Escribí un mensaje…" disabled={isSending} /></label>}
        <div className="workspace-composer-actions"><div className="workspace-file-types"><span>Adjuntar</span>{types.map((type) => <button key={type.value} type="button" onClick={() => { setAttachmentType(type.value); setText('') }} disabled={isSending} title={type.label}>{typeIcon(type.value)}<span>{type.label}</span></button>)}</div><button className="client-button-primary" type="submit" disabled={isSending}><Send size={15} aria-hidden="true" /> {isSending ? 'Enviando…' : 'Enviar'}</button></div>
        {isSending && attachmentType ? <div className="workspace-progress"><span style={{ width: `${progress}%` }} /><small>Subiendo archivo: {progress}%</small></div> : null}
      </form>
    </section>
  )
}
