import { ArrowDown, ArrowDownLeft, ArrowUpRight, Check, CheckCheck, CircleAlert, FileText, Image, MessageCircle, Mic, RefreshCw, Search, SendHorizontal, SlidersHorizontal, UserRound, Video, X } from 'lucide-react'
import { FormEvent, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TimelineMessage } from '../api/messagesApi'
import { listConnectionTimelineMessages, sendConnectionText } from '../api/messagesApi'
import { SafeJsonViewer } from '@/features/observability/components/SafeJsonViewer'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
import { Input, Select, Textarea } from '@/shared/components/FormControls'

type DateRange = 'all' | 'today' | '24h' | '7d' | '30d'
function normalized(value: unknown): string { return String(value || '').trim().toLocaleLowerCase() }
function time(value: number): string { return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
function dateTime(value: number): string { return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function typeIcon(kind: string) { if (kind === 'image') return <Image size={16} aria-hidden="true" />; if (kind === 'audio') return <Mic size={16} aria-hidden="true" />; if (kind === 'video') return <Video size={16} aria-hidden="true" />; return <FileText size={16} aria-hidden="true" /> }
function contentPreview(message: TimelineMessage): string { return message.text || message.media?.fileName || (message.media ? `Archivo ${message.kind}` : 'Mensaje sin contenido legible.') }
function statusLabel(status: string | null): string | null { if (!status) return null; return ({ sent: 'Enviado', accepted: 'Aceptado', delivered: 'Entregado', read: 'Leído', failed: 'No enviado', received: 'Recibido' }[status.toLowerCase()] || status) }
function rangeStart(range: DateRange): number | null { const now = Date.now(); if (range === 'today') { const today = new Date(); today.setHours(0, 0, 0, 0); return today.getTime() }; if (range === '24h') return now - 86400000; if (range === '7d') return now - 604800000; if (range === '30d') return now - 2592000000; return null }
/** Del lado del Gateway, la contraparte de un entrante es quien lo envía y la de un saliente quien lo recibe. */
function counterpart(message: TimelineMessage): string | null { return message.direction === 'inbound' ? message.sender : message.recipient }
function dayKey(value: number): string { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` }
function dayLabel(value: number): string {
  const date = new Date(value); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
  if (dayKey(value) === dayKey(today.getTime())) return 'Hoy'
  if (dayKey(value) === dayKey(yesterday.getTime())) return 'Ayer'
  return new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }).format(date)
}

function MessageStatus({ status }: { status: string | null }) {
  const label = statusLabel(status)
  if (!label) return <span className="workspace-message-status">Sin estado</span>
  const normalizedStatus = status?.toLowerCase()
  const Icon = normalizedStatus === 'read' || normalizedStatus === 'delivered' ? CheckCheck : Check
  return <span className={`workspace-message-status ${normalizedStatus === 'failed' ? 'is-error' : 'is-success'}`}><Icon size={13} aria-hidden="true" /> {label}</span>
}
/** Indicador compacto estilo chat: solo ícono, con el estado como etiqueta accesible. */
function BubbleStatus({ status }: { status: string | null }) {
  const normalizedStatus = status?.toLowerCase()
  const label = statusLabel(status) || 'Sin estado'
  if (normalizedStatus === 'failed') return <CircleAlert size={14} className="chat-status is-error" aria-label={label} />
  if (normalizedStatus === 'read') return <CheckCheck size={14} className="chat-status is-read" aria-label={label} />
  if (normalizedStatus === 'delivered') return <CheckCheck size={14} className="chat-status" aria-label={label} />
  return <Check size={14} className="chat-status" aria-label={label} />
}
function IdentifierList({ message }: { message: TimelineMessage }) {
  const identifiers = [['Message ID', message.messageId], ['Provider message ID', message.providerMessageId], ['Conversation ID', message.conversationId], ['Channel ID', message.channelId], ['Connection ID', message.connectionId], ['Correlation ID', message.correlationId], ['Request ID', message.requestId], ['Event ID', message.eventId], ['Delivery ID', message.deliveryId], ['Outbound attempt ID', message.outboundAttemptId]].filter(([, value]) => Boolean(value)) as Array<[string, string]>
  if (!identifiers.length) return null
  return <section className="workspace-message-detail-section"><h4>Identificadores</h4><dl className="workspace-message-identifiers">{identifiers.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl></section>
}

export function MessagesWorkspace({ connectionId, messageId }: { connectionId: string; messageId?: string | null }) {
  const [messages, setMessages] = useState<TimelineMessage[]>([]); const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [search, setSearch] = useState(''); const [filtersOpen, setFiltersOpen] = useState(false); const [direction, setDirection] = useState<'all' | TimelineMessage['direction']>('all'); const [status, setStatus] = useState('all'); const [kind, setKind] = useState('all'); const [dateRange, setDateRange] = useState<DateRange>('all'); const [contact, setContact] = useState('all')
  const [recipient, setRecipient] = useState(''); const [text, setText] = useState(''); const [isLoading, setIsLoading] = useState(true); const [isSending, setIsSending] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null); const stickToBottom = useRef(true); const [hasNewBelow, setHasNewBelow] = useState(false)
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true)
    try { const next = await listConnectionTimelineMessages(connectionId); setMessages(next); setSelectedMessageId((current) => current && next.some((message) => message.id === current) ? current : (messageId ? next.find((message) => message.messageId === messageId)?.id || null : null)) } catch { if (!quiet) setError('No pudimos actualizar los mensajes. Intentá nuevamente.') } finally { if (!quiet) setIsLoading(false) }
  }, [connectionId, messageId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const interval = window.setInterval(() => { void load(true) }, 5000); return () => window.clearInterval(interval) }, [load])
  const availableStatuses = useMemo(() => [...new Set(messages.map((message) => message.status).filter((value): value is string => Boolean(value)))].sort(), [messages])
  // Contactos ordenados por actividad reciente, para el filtro.
  const availableContacts = useMemo(() => [...new Set([...messages].sort((left, right) => right.timestamp - left.timestamp).map(counterpart).filter((value): value is string => Boolean(value)))], [messages])
  const availableKinds = useMemo(() => [...new Set(messages.map((message) => message.kind).filter(Boolean))].sort(), [messages])
  const visibleMessages = useMemo(() => {
    const query = normalized(search); const start = rangeStart(dateRange)
    return messages.filter((message) => {
      if (messageId && message.messageId !== messageId) return false
      if (direction !== 'all' && message.direction !== direction) return false
      if (status !== 'all' && normalized(message.status) !== normalized(status)) return false
      if (kind !== 'all' && normalized(message.kind) !== normalized(kind)) return false
      if (start !== null && message.timestamp < start) return false
      if (contact !== 'all' && counterpart(message) !== contact) return false
      return !query || [message.text, message.messageId, message.providerMessageId, message.conversationId, message.channelId, message.correlationId, message.requestId, message.eventId, message.deliveryId, message.outboundAttemptId, message.sender, message.recipient, message.provider].some((value) => normalized(value).includes(query))
    }).sort((left, right) => left.timestamp - right.timestamp)
  }, [contact, dateRange, direction, kind, messageId, messages, search, status])
  const selectedMessage = visibleMessages.find((message) => message.id === selectedMessageId) || null
  const activeFilterCount = [direction !== 'all', status !== 'all', kind !== 'all', dateRange !== 'all', contact !== 'all'].filter(Boolean).length
  const lastMessageId = visibleMessages[visibleMessages.length - 1]?.id

  // Por defecto se responde a la última persona que escribió; el operador puede cambiarlo.
  useEffect(() => {
    if (recipient) return
    const lastInbound = [...messages].sort((left, right) => right.timestamp - left.timestamp).find((message) => message.direction === 'inbound' && message.sender)
    if (lastInbound?.sender) setRecipient(lastInbound.sender)
  }, [messages, recipient])

  function scrollToBottom(behavior: ScrollBehavior = 'auto') { const thread = threadRef.current; if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior }); setHasNewBelow(false) }
  // Como en cualquier chat: si el operador está leyendo historial no lo movemos, solo avisamos que hay mensajes nuevos.
  useLayoutEffect(() => {
    if (!lastMessageId) return
    if (stickToBottom.current) scrollToBottom()
    else setHasNewBelow(true)
  }, [lastMessageId])
  function handleScroll() { const thread = threadRef.current; if (!thread) return; stickToBottom.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; if (stickToBottom.current) setHasNewBelow(false) }

  function selectMessage(message: TimelineMessage) { setSelectedMessageId(message.id); const contact = counterpart(message); if (contact) setRecipient(contact) }
  function clearFilters() { setSearch(''); setDirection('all'); setStatus('all'); setKind('all'); setDateRange('all'); setContact('all') }
  function focusContact(value: string | null) { setContact(value || 'all'); if (value) setRecipient(value); setSelectedMessageId(null); stickToBottom.current = true }
  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); const target = recipient.trim()
    if (!target) return setError('Ingresá el identificador del destinatario.')
    if (!text.trim()) return setError('Escribí un mensaje antes de enviarlo.')
    setError(null); setNotice(null); setIsSending(true)
    try { await sendConnectionText(connectionId, target, text.trim()); setText(''); stickToBottom.current = true; await load(true) } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo enviar el mensaje.') } finally { setIsSending(false) }
  }
  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envía y Shift+Enter agrega una línea; en pantallas táctiles Enter siempre es salto de línea.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) { event.preventDefault(); void submit() }
  }

  let previousDay = ''; let previousContact: string | null = null
  return <section className="connection-section workspace-messages">
    <div className="connection-section-heading"><div><h3>Mensajes</h3><p>Conversación de esta conexión. Tocá un mensaje para ver su evidencia técnica.</p></div><div className="connection-inline-actions workspace-message-actions"><button type="button" className="client-button-secondary" onClick={() => void load()} disabled={isLoading}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></div></div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} /><Toast message={notice} tone="success" onDismiss={() => setNotice(null)} />
    <div className="workspace-message-controls"><div className="workspace-message-toolbar"><label className="workspace-message-search"><Search size={17} aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar mensaje, ID o correlación…" aria-label="Buscar mensajes" /></label><button type="button" className={`client-button-secondary workspace-message-filter-toggle ${filtersOpen ? 'is-active' : ''}`} onClick={() => setFiltersOpen((value) => !value)} aria-expanded={filtersOpen}><SlidersHorizontal size={15} aria-hidden="true" /> Filtros{activeFilterCount ? ` · ${activeFilterCount}` : ''}</button></div>{contact !== 'all' ? <div className="workspace-message-active-filters"><span>Conversación con</span><button type="button" onClick={() => focusContact(null)} aria-label={`Quitar filtro de contacto ${contact}`}><UserRound size={12} aria-hidden="true" /> {contact} <X size={12} aria-hidden="true" /></button></div> : null}{filtersOpen ? <section className="workspace-message-filter-panel" aria-label="Filtros de mensajes"><div className="workspace-message-filter-fields"><label><span>Contacto</span><Select value={contact} onChange={(event) => focusContact(event.target.value === 'all' ? null : event.target.value)}><option value="all">Todos</option>{availableContacts.map((value) => <option key={value} value={value}>{value}</option>)}</Select></label><label><span>Dirección</span><Select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="all">Todas</option><option value="inbound">Entrantes</option><option value="outbound">Salientes</option></Select></label><label><span>Estado</span><Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option>{availableStatuses.map((value) => <option key={value} value={value}>{statusLabel(value) || value}</option>)}</Select></label><label><span>Tipo</span><Select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">Todos</option>{availableKinds.map((value) => <option key={value} value={value}>{value}</option>)}</Select></label><label><span>Fecha</span><Select value={dateRange} onChange={(event) => setDateRange(event.target.value as DateRange)}><option value="all">Todas</option><option value="today">Hoy</option><option value="24h">Últimas 24 horas</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option></Select></label></div><button type="button" className="workspace-message-clear-filters" onClick={clearFilters}>Limpiar filtros</button></section> : null}</div>
    <div className={`workspace-message-layout chat-layout${selectedMessage ? ' has-selection' : ''}`}>
      <section className="chat-panel" aria-label="Conversación">
        <div ref={threadRef} className="chat-thread" onScroll={handleScroll} aria-live="polite">
          {isLoading ? <LoadingState label="Cargando mensajes…" lines={4} /> : null}
          {!isLoading && visibleMessages.length === 0 ? <EmptyState icon={MessageCircle} title="No encontramos mensajes." description={activeFilterCount || search ? 'Probá ajustar o limpiar los filtros.' : 'Enviá un mensaje de prueba para verificar esta conexión.'} /> : null}
          {!isLoading ? visibleMessages.map((message) => {
            const day = dayKey(message.timestamp); const showDay = day !== previousDay; previousDay = day
            const messageContact = counterpart(message); const showContact = contact === 'all' && (showDay || messageContact !== previousContact); previousContact = messageContact
            const isFailed = message.status?.toLowerCase() === 'failed'
            return <div key={message.id} className="chat-item">
              {showDay ? <div className="chat-day"><span>{dayLabel(message.timestamp)}</span></div> : null}
              <button type="button" className={`chat-bubble is-${message.direction}${isFailed ? ' is-failed' : ''}${selectedMessage?.id === message.id ? ' is-selected' : ''}`} onClick={() => selectMessage(message)} aria-pressed={selectedMessage?.id === message.id}>
                {showContact && messageContact ? <span className="chat-contact">{message.direction === 'outbound' ? `Para ${messageContact}` : messageContact}</span> : null}
                {message.media ? <span className="chat-media">{typeIcon(message.kind)}<span>{message.media.fileName || `Archivo ${message.kind}`}</span></span> : null}
                {message.text || !message.media ? <span className="chat-text">{message.text || contentPreview(message)}</span> : null}
                <span className="chat-meta"><time dateTime={new Date(message.timestamp).toISOString()}>{time(message.timestamp)}</time>{message.direction === 'outbound' ? <BubbleStatus status={message.status} /> : null}</span>
              </button>
              {isFailed ? <span className="chat-failed-note">No enviado · tocá para ver el detalle</span> : null}
            </div>
          }) : null}
        </div>
        {hasNewBelow ? <button type="button" className="chat-new-below" onClick={() => scrollToBottom('smooth')}><ArrowDown size={14} aria-hidden="true" /> Mensajes nuevos</button> : null}
        <form className="chat-composer" onSubmit={(event) => void submit(event)}>
          <label className="chat-recipient"><span>Para</span><Input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Número o ID del destinatario" disabled={isSending} aria-label="Destinatario" inputMode="tel" autoComplete="off" /></label>
          <div className="chat-input-row">
            <Textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={handleComposerKey} rows={1} maxLength={4096} placeholder="Escribí un mensaje…" disabled={isSending} aria-label="Mensaje" />
            <button className="chat-send" type="submit" disabled={isSending || !text.trim() || !recipient.trim()} aria-label={isSending ? 'Enviando…' : 'Enviar mensaje'}><SendHorizontal size={18} aria-hidden="true" /></button>
          </div>
        </form>
      </section>
      {selectedMessage ? <div className="detail-sheet-backdrop" aria-hidden="true" onClick={() => setSelectedMessageId(null)} /> : null}
      <section className="workspace-message-detail" aria-label="Detalle de mensaje">{!selectedMessage ? <EmptyState icon={MessageCircle} title="Seleccioná un mensaje" description="Vas a ver su contenido, estado, identificadores y payload estructurado." /> : <><button type="button" className="detail-sheet-close" onClick={() => setSelectedMessageId(null)} aria-label="Cerrar detalle"><X size={18} aria-hidden="true" /></button><div className="workspace-message-detail-heading"><div><span className={`workspace-message-direction workspace-message-direction-${selectedMessage.direction}`}>{selectedMessage.direction === 'inbound' ? <ArrowDownLeft size={16} aria-hidden="true" /> : <ArrowUpRight size={16} aria-hidden="true" />}{selectedMessage.direction === 'inbound' ? 'Entrante' : 'Saliente'}</span><h4>{selectedMessage.kind}</h4><time dateTime={new Date(selectedMessage.timestamp).toISOString()}>{dateTime(selectedMessage.timestamp)}</time></div><MessageStatus status={selectedMessage.status} /></div>{counterpart(selectedMessage) ? <button type="button" className="client-button-secondary chat-focus-contact" onClick={() => focusContact(contact === 'all' ? counterpart(selectedMessage) : null)}><UserRound size={15} aria-hidden="true" /> {contact === 'all' ? `Ver solo la conversación con ${counterpart(selectedMessage)}` : 'Ver mensajes de todos los contactos'}</button> : null}<section className="workspace-message-detail-section"><h4>Contenido</h4>{selectedMessage.media ? <div className="workspace-media-summary">{typeIcon(selectedMessage.kind)}<span>{selectedMessage.media.fileName || `Archivo ${selectedMessage.kind}`}</span></div> : null}<p>{contentPreview(selectedMessage)}</p></section><section className="workspace-message-detail-section"><h4>Datos del mensaje</h4><dl className="workspace-message-identifiers"><div><dt>Dirección</dt><dd>{selectedMessage.direction === 'inbound' ? 'Entrante' : 'Saliente'}</dd></div><div><dt>Tipo</dt><dd>{selectedMessage.kind}</dd></div>{selectedMessage.sender ? <div><dt>Remitente</dt><dd>{selectedMessage.sender}</dd></div> : null}{selectedMessage.recipient ? <div><dt>Destinatario</dt><dd>{selectedMessage.recipient}</dd></div> : null}</dl></section><IdentifierList message={selectedMessage} /><section className="workspace-message-detail-section"><h4>Payload</h4><SafeJsonViewer value={selectedMessage.payload} emptyLabel="No hay payload disponible para este mensaje." /></section></>}</section>
    </div>
  </section>
}
