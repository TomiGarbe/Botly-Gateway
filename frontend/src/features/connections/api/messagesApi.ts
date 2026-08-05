import { environment } from '@/app/config/environment'
import { gatewayRequest } from '@/shared/lib/gatewayClient'

export type MessageKind = 'text' | 'image' | 'audio' | 'document' | 'video'

export interface TimelineMessage {
  id: string
  messageId: string | null
  timestamp: number
  direction: 'inbound' | 'outbound'
  kind: MessageKind | string
  text: string
  status: string | null
  sender: string | null
  recipient: string | null
  media: { id?: string; kind?: string; mimeType?: string; fileName?: string; caption?: string; url?: string } | null
}

interface TimelineEvent {
  id: string
  timestamp: number
  direction?: string
  type?: string
  subtype?: string
  messageType?: string
  status?: string
  text?: string
  content?: { text?: string }
  sender?: string
  recipient?: string
  messageId?: string
  message?: { id?: string; kind?: string; text?: string }
  metadata?: { messageId?: string; status?: string }
  media?: TimelineMessage['media']
}

const messageKinds = new Set<MessageKind>(['text', 'image', 'audio', 'document', 'video'])

function statusFor(event: TimelineEvent): string | null {
  return event.status || event.metadata?.status || null
}

export async function listTimelineMessages(runtimeName: string): Promise<TimelineMessage[]> {
  const payload = await gatewayRequest<{ items: TimelineEvent[] }>(`/webhooks/events?instance=${encodeURIComponent(runtimeName)}&limit=200`)
  const statuses = new Map<string, string>()
  for (const event of payload.items) {
    if (event.subtype !== 'message_status') continue
    const id = event.messageId || event.metadata?.messageId
    const status = statusFor(event)
    if (id && status) statuses.set(id, status)
  }
  return payload.items
    .filter((event) => event.type === 'message')
    .map((event) => {
      const messageId = event.message?.id || event.messageId || null
      const rawKind = event.messageType || event.message?.kind || 'text'
      return {
        id: event.id,
        messageId,
        timestamp: event.timestamp,
        direction: (event.direction === 'inbound' ? 'inbound' : 'outbound') as TimelineMessage['direction'],
        kind: messageKinds.has(rawKind as MessageKind) ? rawKind : rawKind,
        text: event.text || event.content?.text || event.message?.text || event.media?.caption || '',
        status: messageId ? statuses.get(messageId) || statusFor(event) : statusFor(event),
        sender: event.sender || null,
        recipient: event.recipient || null,
        media: event.media || null,
      }
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function sendWorkspaceMessage(
  runtimeName: string,
  input: { number: string; type: MessageKind; text?: string; caption?: string; file?: File },
  onProgress: (progress: number) => void,
): Promise<void> {
  const form = new FormData()
  form.set('number', input.number)
  form.set('type', input.type)
  if (input.type === 'text') form.set('text', input.text || '')
  else {
    form.set('caption', input.caption || '')
    if (input.file) form.set('file', input.file)
  }
  const baseUrl = environment.gatewayUrl || window.location.origin
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', new URL(`/messages/${encodeURIComponent(runtimeName)}`, baseUrl).toString())
    request.withCredentials = true
    request.setRequestHeader('Accept', 'application/json')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onerror = () => reject(new Error('No se pudo conectar con el Gateway. Intentá nuevamente.'))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve()
      if (request.status === 401) return reject(new Error('Tu sesión venció. Volvé a iniciar sesión.'))
      if (request.status === 413) return reject(new Error('El archivo supera el tamaño permitido.'))
      if (request.status === 415) return reject(new Error('Ese tipo de archivo no está permitido.'))
      reject(new Error('No se pudo enviar el mensaje. Verificá la conexión e intentá nuevamente.'))
    }
    request.send(form)
  })
}
