import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, BadgeCheck, CheckCircle2, Clipboard, Copy, Eye, EyeOff, KeyRound, ListChecks, Loader2, QrCode, RefreshCcw, ShieldCheck, Smartphone, TerminalSquare, Trash2, Wifi } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { GatewayConfig } from '../lib/config'
import type { ConnectionDiagnostic, Instance, PipelineEvent, Toast } from '../types'
import { connectionIconTone, connectionTypeLabel, diagnosticText, eventDescription, eventTitle, formatActivity, healthLabel, isOfficialConnection, recommendation, statusLabel, statusTone } from '../lib/connectionUx'

interface Props {
  config: GatewayConfig
  instance: Instance
  onBack: () => void
  onToast: (message: string, type?: Toast['type']) => void
  onRefresh: () => void
  onQR: (name: string) => void
  onReconnect: (name: string) => void
  onApiKey: (name: string) => void
  onDelete: (name: string) => void
  qrEnabled: boolean
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
      <CheckCircle2 size={15} className={ok ? 'mt-0.5 shrink-0 text-emerald-400' : 'mt-0.5 shrink-0 text-zinc-600'} />
      <div className="min-w-0">
        <p className={ok ? 'text-sm text-zinc-100' : 'text-sm text-zinc-400'}>{label}</p>
        {detail ? <p className="mt-0.5 text-xs text-zinc-500">{detail}</p> : null}
      </div>
    </div>
  )
}

function ProblemRow({ item }: { item: ConnectionDiagnostic }) {
  const text = diagnosticText(item)
  return (
    <div className={`rounded-md border px-3 py-2.5 text-sm ${text.tone}`}>
      <p className="font-medium">{text.title}</p>
      <p className="mt-1 text-xs text-zinc-300">{text.action}</p>
    </div>
  )
}

function ActivityRow({ event }: { event: PipelineEvent }) {
  return (
    <div className="flex gap-3 border-b border-zinc-800 py-3 last:border-b-0">
      <div className="mt-1 h-2 w-2 rounded-full bg-zinc-600" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-zinc-200">{eventTitle(event)}</p>
          <span className="text-xs text-zinc-600">{formatActivity(event.timestamp)}</span>
        </div>
        <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{eventDescription(event)}</p>
      </div>
    </div>
  )
}

export default function ConnectionDetails({ config, instance, onBack, onToast, onRefresh, onQR, onReconnect, onApiKey, onDelete, qrEnabled }: Props) {
  const [adminMode, setAdminMode] = useState(false)
  const [copyKey, setCopyKey] = useState('')
  const activityRef = useRef<HTMLDivElement>(null)
  const official = isOfficialConnection(instance)
  const tone = statusTone(instance)
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl || config.url)
  const receiveUrl = `${publicBaseUrl}/webhooks/evolution`
  const sendUrl = `${publicBaseUrl}/messages/${instance.name}`

  const { data: diagnosticsData, isLoading: diagnosticsLoading } = useSWR(
    config.apiKey ? ['connection-diagnostics', config.url, instance.name] : null,
    () => api.instances.diagnostics(config, instance.name),
    { refreshInterval: 20000, revalidateOnFocus: true }
  )
  const { data: activityData, isLoading: activityLoading } = useSWR(
    config.apiKey ? ['connection-activity', config.url, instance.name] : null,
    () => api.webhooks.events<PipelineEvent>(config, instance.name, 80),
    { refreshInterval: 20000, revalidateOnFocus: true }
  )
  const { data: apiKeyInfo } = useSWR(
    config.apiKey ? ['connection-key', config.url, instance.name] : null,
    () => api.instances.getApiKey(config, instance.name),
    { refreshInterval: 30000, revalidateOnFocus: false }
  )

  const activity = useMemo(() => {
    const items = Array.isArray(activityData?.items) ? activityData.items : []
    return [...items].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, 20)
  }, [activityData])

  const supportDiagnostics = diagnosticsData?.supportDiagnostics || []
  const visibleDiagnostics = [
    ...(diagnosticsData?.diagnostics || instance.diagnostics || []),
    ...supportDiagnostics,
  ].filter(item => item.severity !== 'info')
  const healthChecks = diagnosticsData?.healthChecks || instance.healthChecks || []
  const webhookOk = healthChecks.some(item => item.code === 'webhook_configured' && item.status === 'passed')
  const configOk = healthChecks.every(item => !item.required || item.status === 'passed') && visibleDiagnostics.length === 0
  const botlyOk = apiKeyInfo?.enabled === true || apiKeyInfo?.hasApiKey === true
  const mobileOk = official ? instance.coexistence?.whatsappBusinessAppAvailable === true : false

  const copyText = async (value: string, key: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyKey(key)
      onToast(label, 'success')
      window.setTimeout(() => setCopyKey(current => current === key ? '' : current), 1400)
    } catch {
      onToast('No se pudo copiar', 'error')
    }
  }

  const runReconnect = async () => {
    try {
      onReconnect(instance.name)
      onRefresh()
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : 'No se pudo reconectar', 'error')
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="rounded-md border border-zinc-800 p-2 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200" title="Volver">
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-zinc-100">{instance.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${connectionIconTone(instance)}`}>
                {official ? <BadgeCheck size={13} /> : <QrCode size={13} />}
                {connectionTypeLabel(instance)}
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone.text} ${tone.border}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                {statusLabel(instance)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600">
            <RefreshCcw size={13} />
            Actualizar
          </button>
          <button onClick={() => void runReconnect()} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600">
            <RefreshCcw size={13} />
            Reconectar
          </button>
          {qrEnabled && !official && instance.status !== 'open' ? (
            <button onClick={() => onQR(instance.name)} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500">
              <QrCode size={13} />
              Escanear QR
            </button>
          ) : null}
        </div>
      </div>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">Estado</p>
          <p className={`mt-2 text-sm font-semibold ${tone.text}`}>{statusLabel(instance)}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">Salud</p>
          <p className="mt-2 text-sm font-semibold text-zinc-100">{healthLabel(instance)}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">Ultima actividad</p>
          <p className="mt-2 text-sm font-semibold text-zinc-100">{formatActivity(activity[0]?.timestamp || instance.lastSeen)}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs text-zinc-500">Recomendacion</p>
          <p className="mt-2 text-sm font-semibold text-zinc-100">{recommendation(instance, activity)}</p>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center gap-2">
              <ListChecks size={16} className="text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Informacion</h3>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <CheckRow ok={instance.status === 'open'} label="Conectado" detail={instance.status === 'open' ? 'La conexion puede enviar y recibir mensajes.' : 'La conexion no esta disponible ahora.'} />
              <CheckRow ok={official ? mobileOk : true} label="Aplicacion movil disponible" detail={official ? 'Disponible cuando el numero conserva la aplicacion movil.' : 'No aplica para WhatsApp Web.'} />
              <CheckRow ok={webhookOk} label="Recepcion de mensajes configurada" detail={webhookOk ? 'Los mensajes entrantes llegan al sistema.' : 'Conviene actualizar la conexion.'} />
              <CheckRow ok={configOk} label="Configuracion completa" detail={configOk ? 'No hay pasos pendientes.' : 'Hay advertencias para revisar.'} />
              <CheckRow ok={botlyOk} label="Botly conectado" detail={botlyOk ? 'La conexion esta lista para operar con Botly.' : 'Revisa el acceso interno desde modo administrador.'} />
              <CheckRow ok label="Acciones disponibles" detail="Puedes reconectar, actualizar, ver actividad o eliminar la conexion." />
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck size={16} className="text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Diagnostico</h3>
              {diagnosticsLoading ? <Loader2 size={13} className="animate-spin text-zinc-500" /> : null}
            </div>
            {visibleDiagnostics.length === 0 ? (
              <div className="rounded-md border border-emerald-900/60 bg-emerald-950/20 px-3 py-3 text-sm text-emerald-300">
                Todo funciona correctamente.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {visibleDiagnostics.map(item => <ProblemRow key={`${item.code}-${item.message}`} item={item} />)}
              </div>
            )}
          </section>

          <section ref={activityRef} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-zinc-100">Actividad reciente</h3>
              {activityLoading ? <Loader2 size={13} className="animate-spin text-zinc-500" /> : null}
            </div>
            {activity.length === 0 ? (
              <p className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-500">No se detecto actividad reciente.</p>
            ) : (
              <div>{activity.map(event => <ActivityRow key={`${event.id || event.timestamp}-${event.event}`} event={event} />)}</div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-5">
          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-sm font-semibold text-zinc-100">Acciones rapidas</h3>
            <div className="mt-3 grid grid-cols-1 gap-2">
              <button onClick={() => void runReconnect()} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-700">
                <RefreshCcw size={14} />
                Reconectar
              </button>
              <button onClick={onRefresh} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-700">
                <RefreshCcw size={14} />
                Actualizar
              </button>
              <button onClick={() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-700">
                <TerminalSquare size={14} />
                Ver actividad
              </button>
              {qrEnabled && !official && instance.status !== 'open' ? (
                <button onClick={() => onQR(instance.name)} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-700">
                  <QrCode size={14} />
                  Escanear QR
                </button>
              ) : null}
              <button onClick={() => onDelete(instance.name)} className="flex items-center gap-2 rounded-md border border-red-900/70 px-3 py-2 text-left text-sm text-red-300 hover:border-red-800">
                <Trash2 size={14} />
                Eliminar conexion
              </button>
            </div>
          </section>

          {official && instance.coexistence?.state === 'enabled' ? (
            <section className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-4 text-sm text-emerald-300">
              <p className="flex items-center gap-2 font-medium"><Smartphone size={15} /> Aplicacion movil disponible</p>
              <p className="mt-2 text-xs text-zinc-300">Puedes seguir usando la aplicacion movil mientras Botly opera con WhatsApp Oficial.</p>
            </section>
          ) : null}

          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <button onClick={() => setAdminMode(v => !v)} className="flex w-full items-center justify-between text-sm font-semibold text-zinc-100">
              <span className="flex items-center gap-2">{adminMode ? <EyeOff size={14} /> : <Eye size={14} />} Modo administrador</span>
            </button>
            {adminMode ? (
              <div className="mt-3 space-y-2 text-xs text-zinc-500">
                <p>Nombre interno: <span className="font-mono text-zinc-300">{instance.name}</span></p>
                <p>ID interno: <span className="font-mono text-zinc-300">{instance.id}</span></p>
                <p>Tipo interno: <span className="font-mono text-zinc-300">{instance.connectionType || '-'}</span></p>
                <p>Estado interno: <span className="font-mono text-zinc-300">{instance.lifecycleState || '-'}</span></p>
                <p>Credenciales: <span className="font-mono text-zinc-300">{apiKeyInfo?.hasApiKey ? apiKeyInfo.maskedApiKey || 'generadas' : 'sin generar'}</span></p>
                <div className="grid grid-cols-1 gap-2 pt-2">
                  <button onClick={() => copyText(receiveUrl, 'receive', 'URL de recepcion copiada')} className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700">
                    <span className="flex items-center gap-2"><Clipboard size={13} /> Copiar URL de recepcion</span>
                    {copyKey === 'receive' ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  </button>
                  <button onClick={() => copyText(sendUrl, 'send', 'URL para enviar mensajes copiada')} className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700">
                    <span className="flex items-center gap-2"><Wifi size={13} /> Copiar URL de envio</span>
                    {copyKey === 'send' ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  </button>
                  <button onClick={() => onApiKey(instance.name)} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700">
                    <KeyRound size={13} />
                    Administrar acceso interno
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">Los identificadores internos estan ocultos para evitar errores operativos.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
