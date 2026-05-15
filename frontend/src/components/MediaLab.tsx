import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { api, ApiError } from '../lib/api'
import type { GatewayConfig } from '../lib/config'
import type { PipelineEvent } from '../types'

function cleanNumber(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

export default function MediaLab({
  config,
  onToast,
}: {
  config: GatewayConfig
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}) {
  const [instance, setInstance] = useState('')
  const [number, setNumber] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const { data: eventsData, mutate: mutateEvents, isLoading } = useSWR(
    config.apiKey ? ['events', instance] : null,
    () => api.webhooks.events<PipelineEvent>(config, instance || undefined, 300),
    { refreshInterval: 2500, dedupingInterval: 1000 }
  )

  const events = useMemo(() => {
    const all = eventsData?.items ?? []
    return all.filter(item => {
      if (item.layer === 'technical') return false
      if (item.layer === 'business') {
        return item.type === 'message' && item.messageType === 'text'
      }
      if (item.layer === 'operational') {
        const stage = String(item.pipeline?.stage ?? '')
        const status = String(item.pipeline?.status ?? '')
        if (status.includes('failed') || status.includes('retry') || status.includes('throttled') || status.includes('dropped')) {
          return true
        }
        return stage === 'forward_to_bot' || stage === 'send_whatsapp'
      }
      return false
    })
  }, [eventsData?.items])

  const sendText = async () => {
    const trimmed = text.trim()
    const clean = cleanNumber(number)
    if (!instance || !clean || !trimmed) {
      onToast('Completa instancia, numero y mensaje', 'error')
      return
    }

    setSending(true)
    try {
      await api.messages.sendText(config, instance, { number: clean, text: trimmed })
      setText('')
      onToast('Mensaje enviado', 'success')
      await mutateEvents()
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : 'Error al enviar mensaje', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-1 bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-zinc-200">Enviar texto</p>
        <input
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
          placeholder="Instancia"
          value={instance}
          onChange={e => setInstance(e.target.value.trim())}
        />
        <input
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
          placeholder="Numero (549...)"
          value={number}
          onChange={e => setNumber(cleanNumber(e.target.value))}
        />
        <textarea
          className="w-full h-36 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm resize-none"
          placeholder="Escribe un mensaje..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!sending) sendText()
            }
          }}
        />
        <button
          onClick={sendText}
          disabled={sending}
          className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm"
        >
          {sending ? 'Enviando...' : 'Enviar texto'}
        </button>
      </div>

      <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-sm font-semibold text-zinc-200 mb-3">Timeline texto</p>
        {isLoading ? <p className="text-xs text-zinc-500">Cargando...</p> : null}
        <div className="space-y-2 max-h-[620px] overflow-auto pr-1">
          {events.map((item, i) => {
            const isBusinessText = item.layer === 'business' && item.type === 'message' && item.messageType === 'text'
            const isIncoming = item.direction === 'inbound'
            const bubbleClass = isBusinessText
              ? isIncoming
                ? 'bg-zinc-950 border-zinc-800'
                : 'bg-blue-950/50 border-blue-900/60'
              : 'bg-zinc-950/70 border-zinc-800'

            return (
              <div key={`${item.id ?? item.timestamp}-${i}`} className={`border rounded p-2.5 ${bubbleClass}`}>
                <div className="flex items-center justify-between text-[11px] text-zinc-400 gap-2">
                  <span>{item.instance || 'unknown'}</span>
                  <span>{new Date(item.timestamp).toLocaleString()}</span>
                </div>
                {isBusinessText ? (
                  <>
                    <p className="text-[11px] text-zinc-500 mt-1">
                      {isIncoming ? `IN ${item.sender ?? '-'}` : `OUT ${item.recipient ?? '-'}`} · {item.status ?? 'received'}
                    </p>
                    <p className="text-sm text-zinc-200 mt-1 whitespace-pre-wrap">{item.text ?? item.content ?? ''}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-zinc-500 mt-1">
                      {item.pipeline?.stage ?? item.event} · {item.pipeline?.status ?? item.status ?? 'ok'}
                    </p>
                    <p className="text-[11px] text-zinc-400 mt-1 break-all">
                      request: {item.pipeline?.requestId ?? item.meta?.requestId ?? '-'}
                    </p>
                  </>
                )}
              </div>
            )
          })}
          {events.length === 0 ? <p className="text-xs text-zinc-500">No hay actividad de texto aun.</p> : null}
        </div>
      </div>
    </div>
  )
}
