import { useEffect, useCallback } from 'react'
import useSWR from 'swr'
import { X, RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import type { GatewayConfig } from '../lib/config'

interface Props {
  instanceName: string
  config:       GatewayConfig
  onClose:      () => void
  onConnected:  () => void
}

export default function QRModal({ instanceName, config, onClose, onConnected }: Props) {
  // Poll state every 3s
  const { data: stateData } = useSWR(
    ['state', instanceName],
    () => api.instances.state(config, instanceName),
    { refreshInterval: 3000, revalidateOnFocus: false }
  )

  const state = stateData?.instance?.state

  // Poll QR every 5s while not connected
  const { data: qrData, mutate: refreshQR, isValidating } = useSWR(
    state !== 'open' ? ['qr', instanceName] : null,
    () => api.instances.qr(config, instanceName),
    { refreshInterval: 5000, revalidateOnFocus: false }
  )

  const base64 = qrData?.base64 ?? qrData?.qrcode?.base64

  useEffect(() => {
    if (state === 'open') onConnected()
  }, [state, onConnected])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleRefresh = useCallback(() => refreshQR(), [refreshQR])

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm flex flex-col gap-0 overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="font-semibold text-sm">Vincular número</h2>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{instanceName}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-md hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        {/* QR area */}
        <div className="px-5 py-5">
          {state === 'open' ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 size={48} className="text-emerald-400" />
              <p className="font-semibold text-emerald-400">¡Número conectado!</p>
              <p className="text-xs text-zinc-500 text-center">
                La instancia está activa y lista para recibir mensajes.
              </p>
            </div>
          ) : base64 ? (
            <div className="bg-white rounded-xl p-3 flex items-center justify-center">
              <img
                src={base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`}
                alt="QR Code"
                className="w-full max-w-[260px] rounded-lg"
              />
            </div>
          ) : (
            <div className="bg-zinc-800/50 rounded-xl h-72 flex flex-col items-center justify-center gap-3">
              <Loader2 size={24} className="animate-spin text-zinc-600" />
              <p className="text-xs text-zinc-500">Generando QR…</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {state !== 'open' && (
          <div className="px-5 pb-5 flex flex-col gap-4">
            <div className="bg-zinc-800/50 rounded-lg px-4 py-3 text-xs text-zinc-400 leading-relaxed">
              Abrí <strong className="text-zinc-200">WhatsApp</strong> en tu celular →{' '}
              <strong className="text-zinc-200">Dispositivos vinculados</strong> →{' '}
              <strong className="text-zinc-200">Vincular un dispositivo</strong> → escaneá este QR.
            </div>
            <button
              onClick={handleRefresh}
              disabled={isValidating}
              className="flex items-center justify-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors py-1 disabled:opacity-40"
            >
              <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} />
              Refrescar QR manualmente
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
