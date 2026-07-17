import { BadgeCheck, Clock3, Eye, LogOut, QrCode, RefreshCcw, Trash2 } from 'lucide-react'
import type { Instance } from '../types'
import { connectionIconTone, connectionTypeLabel, formatActivity, isOfficialConnection, statusLabel, statusTone } from '../lib/connectionUx'

interface Props {
  instance: Instance
  onOpenDetails: (name: string) => void
  onQR: (name: string) => void
  onLogout: (name: string) => void
  onDelete: (name: string) => void
  onReconnect: (name: string) => void
  onRefresh: () => void
}

export default function InstanceCard({ instance, onOpenDetails, onQR, onLogout, onDelete, onReconnect, onRefresh }: Props) {
  const official = isOfficialConnection(instance)
  const tone = statusTone(instance)

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/80 hover:border-zinc-700 transition-colors">
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{instance.name}</h3>
            <div className={`mt-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${connectionIconTone(instance)}`}>
              {official ? <BadgeCheck size={13} /> : <QrCode size={13} />}
              {connectionTypeLabel(instance)}
            </div>
          </div>
          <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone.text} ${tone.border}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
            {statusLabel(instance)}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-950/60 border border-zinc-800 px-3 py-2 text-xs">
          <span className="flex items-center gap-2 text-zinc-500"><Clock3 size={13} /> Ultima actividad</span>
          <span className="text-zinc-300 truncate">{formatActivity(instance.lastSeen)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-4 py-3">
        <button
          onClick={() => onOpenDetails(instance.name)}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
        >
          <Eye size={13} />
          Ver detalle
        </button>
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
        >
          <RefreshCcw size={13} />
          Actualizar
        </button>
        {!official && instance.status !== 'open' ? (
          <button
            onClick={() => onQR(instance.name)}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            <QrCode size={13} />
            Escanear QR
          </button>
        ) : null}
        {instance.status !== 'open' ? (
          <button
            onClick={() => onReconnect(instance.name)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          >
            <RefreshCcw size={13} />
            Reconectar
          </button>
        ) : null}
        <div className="flex-1" />
        {instance.status === 'open' && !official ? (
          <button
            onClick={() => onLogout(instance.name)}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="Desconectar"
          >
            <LogOut size={14} />
          </button>
        ) : null}
        <button
          onClick={() => onDelete(instance.name)}
          className="rounded-md p-1.5 text-zinc-600 hover:bg-red-950/50 hover:text-red-300"
          title="Eliminar conexion"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </article>
  )
}
