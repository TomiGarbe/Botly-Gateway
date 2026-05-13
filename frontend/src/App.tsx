import { useState, useCallback, useEffect } from 'react'
import useSWR from 'swr'
import { Plus, RefreshCw, Server } from 'lucide-react'
import Sidebar from './components/Sidebar'
import InstanceCard from './components/InstanceCard'
import QRModal from './components/QRModal'
import CreateModal from './components/CreateModal'
import SettingsModal from './components/SettingsModal'
import { api, ApiError } from './lib/api'
import { loadConfig, type GatewayConfig } from './lib/config'
import type { Toast } from './types'

// ── Toast component ───────────────────────────────────────────────────────────
function Toasts({ toasts, remove }: { toasts: Toast[]; remove: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-[200] pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={`
            pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium
            border shadow-xl cursor-pointer animate-slide-up
            ${t.type === 'success' ? 'bg-zinc-900 border-emerald-800 text-emerald-400' :
              t.type === 'error'   ? 'bg-zinc-900 border-red-900 text-red-400' :
              'bg-zinc-900 border-zinc-700 text-zinc-300'}
          `}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-5">
      <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center">
        <Server size={28} className="text-zinc-600" />
      </div>
      <div className="text-center">
        <p className="font-semibold text-zinc-200">Sin instancias</p>
        <p className="text-sm text-zinc-500 mt-1">Creá una instancia para vincular un número de WhatsApp</p>
      </div>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
      >
        <Plus size={15} />
        Nueva instancia
      </button>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [config,    setConfig]    = useState<GatewayConfig>(loadConfig)
  const [toasts,    setToasts]    = useState<Toast[]>([])
  const [qrTarget,  setQrTarget]  = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Auto-open settings if no API key
  useEffect(() => {
    if (!config.apiKey) setShowSettings(true)
  }, [config.apiKey])

  // ── Toast helpers ──
  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setToasts(ts => [...ts, { id, message, type }])
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 4000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(ts => ts.filter(t => t.id !== id))
  }, [])

  // ── Instances data ──
  const { data: instances, isLoading, isValidating, mutate } = useSWR(
    config.apiKey ? 'instances' : null,
    () => api.instances.list(config),
    { refreshInterval: 12000, revalidateOnFocus: true }
  )

  // ── Actions ──
  const handleCreate = useCallback(async (name: string) => {
    await api.instances.create(config, name)
    addToast(`Instancia "${name}" creada`, 'success')
    await mutate()
    setShowCreate(false)
    setQrTarget(name)
  }, [config, mutate, addToast])

  const handleLogout = useCallback(async (name: string) => {
    if (!confirm(`¿Desconectar "${name}" de WhatsApp?\n\nHabrá que re-escanear el QR para volver a conectar.`)) return
    try {
      await api.instances.logout(config, name)
      addToast(`"${name}" desconectado`, 'success')
      mutate()
    } catch (e) {
      addToast(e instanceof ApiError ? e.message : 'Error al desconectar', 'error')
    }
  }, [config, mutate, addToast])

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`¿Eliminar la instancia "${name}"?\n\nEsta acción no se puede deshacer.`)) return
    try {
      await api.instances.delete(config, name)
      addToast(`Instancia "${name}" eliminada`, 'success')
      mutate()
    } catch (e) {
      addToast(e instanceof ApiError ? e.message : 'Error al eliminar', 'error')
    }
  }, [config, mutate, addToast])

  const handleConnected = useCallback(() => {
    addToast('¡Número conectado exitosamente!', 'success')
    setQrTarget(null)
    mutate()
  }, [addToast, mutate])

  const list = Array.isArray(instances) ? instances : []

  return (
    <div className="flex min-h-screen">
      <Sidebar onOpenSettings={() => setShowSettings(true)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Page header */}
        <header className="flex items-center justify-between px-8 h-14 border-b border-zinc-800 shrink-0">
          <div>
            <h1 className="font-semibold text-sm">Instancias</h1>
            {!isLoading && (
              <p className="text-xs text-zinc-500 mt-0.5">
                {list.length} {list.length === 1 ? 'instancia' : 'instancias'} totales
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => mutate()}
              disabled={isValidating}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors disabled:opacity-40"
            >
              <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} />
              Actualizar
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              <Plus size={13} />
              Nueva instancia
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-8 py-6">
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 h-36 animate-pulse" />
              ))}
            </div>
          ) : !config.apiKey ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <p className="text-zinc-500 text-sm">Configurá el gateway para empezar</p>
              <button
                onClick={() => setShowSettings(true)}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Abrir configuración
              </button>
            </div>
          ) : list.length === 0 ? (
            <EmptyState onAdd={() => setShowCreate(true)} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {list.map(inst => (
                <InstanceCard
                  key={inst.instanceName ?? inst.instance?.instanceName}
                  instance={inst}
                  onQR={setQrTarget}
                  onLogout={handleLogout}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      {qrTarget && (
        <QRModal
          instanceName={qrTarget}
          config={config}
          onClose={() => setQrTarget(null)}
          onConnected={handleConnected}
        />
      )}
      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
      {showSettings && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onChange={setConfig}
        />
      )}

      <Toasts toasts={toasts} remove={removeToast} />
    </div>
  )
}
