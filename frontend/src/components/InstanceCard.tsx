import { QrCode, LogOut, Trash2, Wifi, WifiOff, Loader2 } from 'lucide-react'
import type { Instance, ConnectionStatus } from '../types'

interface Props {
  instance: Instance
  onQR: (name: string) => void
  onLogout: (name: string) => void
  onDelete: (name: string) => void
}

const statusConfig: Record<ConnectionStatus, { label: string; dot: string; text: string }> = {
  open: { label: 'Conectado', dot: 'bg-emerald-500', text: 'text-emerald-400' },
  connecting: { label: 'Conectando', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400' },
  close: { label: 'Desconectado', dot: 'bg-zinc-600', text: 'text-zinc-500' },
}

export default function InstanceCard({ instance, onQR, onLogout, onDelete }: Props) {
  const { name, id, status } = instance
  const cfg = statusConfig[status] ?? statusConfig.close

  return (
    <div className="group relative bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4 hover:border-zinc-700 transition-colors animate-fade-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{name}</p>
          {id && (
            <p className="text-xs text-zinc-600 font-mono mt-0.5 truncate">
              {id.substring(0, 8)}...
            </p>
          )}
        </div>

        <span className={`flex items-center gap-1.5 text-xs font-medium shrink-0 ${cfg.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-600">
        {status === 'open' && <Wifi size={12} className="text-emerald-600" />}
        {status === 'connecting' && <Loader2 size={12} className="animate-spin text-amber-500" />}
        {status === 'close' && <WifiOff size={12} />}
        <span>WHATSAPP-BAILEYS</span>
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
        {status !== 'open' && (
          <button
            onClick={() => onQR(name)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
          >
            <QrCode size={12} />
            Ver QR
          </button>
        )}
        {status === 'open' && (
          <button
            onClick={() => onLogout(name)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
          >
            <LogOut size={12} />
            Desconectar
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => onDelete(name)}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-950/40 rounded-md transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}
