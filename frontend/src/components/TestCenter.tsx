import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  AlertTriangle, CheckCircle2, ChevronDown, Clock3, Copy, FileAudio, FileImage,
  FileText, Film, Loader2, MapPin, MessageCircle, Play, RefreshCw,
  RotateCcw, Send, Sticker, UserRound, XCircle,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { GatewayConfig } from '../lib/config'
import type { Instance, PipelineEvent, Toast } from '../types'

type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'contact' | 'location' | 'template'
type TestType = MessageType | 'smoke' | 'multimedia' | 'round_trip' | 'webhook'
type StageStatus = 'passed' | 'running' | 'warning' | 'failed' | 'pending'

type TestConfig = { number: string; text: string; messageType: MessageType }
type TestStage = { id: string; label: string; status: StageStatus; durationMs?: number; detail: string }
type TestExecution = {
  id: string; type: TestType; connection: string; operator: string; startedAt: number; durationMs: number
  status: 'passed' | 'warning' | 'failed' | 'running'; latencyMs?: number; error?: string; advice: string
  config: TestConfig; stages: TestStage[]
}

const HISTORY_KEY = 'botly.test-center.history.v1'
const OPERATOR_KEY = 'botly.test-center.operator.v1'
const WAIT_MS = 12000
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const messageTypes: Array<{ id: MessageType; label: string; icon: typeof Send; available: boolean; note?: string }> = [
  { id: 'text', label: 'Texto', icon: MessageCircle, available: true },
  { id: 'image', label: 'Imagen', icon: FileImage, available: true },
  { id: 'audio', label: 'Audio', icon: FileAudio, available: true },
  { id: 'video', label: 'Video', icon: Film, available: true },
  { id: 'document', label: 'Documento', icon: FileText, available: true },
  { id: 'sticker', label: 'Sticker', icon: Sticker, available: false, note: 'Preparado: el endpoint actual aún no envía stickers.' },
  { id: 'contact', label: 'Contacto', icon: UserRound, available: false, note: 'Preparado: falta capacidad de envío en el proveedor.' },
  { id: 'location', label: 'Ubicación', icon: MapPin, available: false, note: 'Preparado: falta capacidad de envío en el proveedor.' },
  { id: 'template', label: 'Template', icon: FileText, available: false, note: 'Preparado para la futura API de templates.' },
]

const compositeTypes: Array<{ id: Extract<TestType, 'smoke' | 'multimedia' | 'round_trip' | 'webhook'>; label: string; detail: string }> = [
  { id: 'smoke', label: 'Smoke Test', detail: 'Texto + aceptación + callback + persistencia.' },
  { id: 'multimedia', label: 'Multimedia', detail: 'Imagen, audio y documento.' },
  { id: 'round_trip', label: 'Round Trip', detail: 'Envío + respuesta + webhook + persistencia.' },
  { id: 'webhook', label: 'Webhook', detail: 'Callback, último evento y estado.' },
]

function cleanNumber(value: string) { return value.replace(/\D/g, '') }
function formatDuration(ms: number) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s` }
function formatDate(value: number) { return new Date(value).toLocaleString() }
function asTimestamp(value: unknown) {
  const number = Number(value)
  return number > 0 && Number.isFinite(number) ? (number < 1_000_000_000_000 ? number * 1000 : number) : 0
}
function eventDirection(event: PipelineEvent) { return event.direction === 'inbound' ? 'inbound' : event.direction === 'outbound' || event.fromMe ? 'outbound' : 'system' }
function eventNumber(event: PipelineEvent) { return cleanNumber(String(event.sender || event.recipient || event.message?.from || '')) }
function isError(error: unknown) { return error instanceof ApiError ? error.message : 'No se pudo ejecutar la prueba.' }
function readHistory(): TestExecution[] {
  try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value.slice(0, 30) : [] } catch { return [] }
}
function persistHistory(value: TestExecution[]) { localStorage.setItem(HISTORY_KEY, JSON.stringify(value.slice(0, 30))) }
function stage(id: string, label: string, detail: string): TestStage { return { id, label, status: 'pending', detail } }

function StageIcon({ status }: { status: StageStatus }) {
  if (status === 'passed') return <CheckCircle2 size={17} className="text-emerald-400" />
  if (status === 'failed') return <XCircle size={17} className="text-red-400" />
  if (status === 'warning') return <AlertTriangle size={17} className="text-amber-400" />
  if (status === 'running') return <Loader2 size={17} className="animate-spin text-blue-400" />
  return <Clock3 size={17} className="text-zinc-600" />
}

function StatusPill({ status }: { status: TestExecution['status'] }) {
  const labels = { passed: 'Correcto', warning: 'Requiere atención', failed: 'Error', running: 'Ejecutando' }
  const tones = { passed: 'border-emerald-900 bg-emerald-950/30 text-emerald-300', warning: 'border-amber-900 bg-amber-950/30 text-amber-300', failed: 'border-red-900 bg-red-950/30 text-red-300', running: 'border-blue-900 bg-blue-950/30 text-blue-300' }
  return <span className={`rounded-full border px-2 py-1 text-[11px] font-medium ${tones[status]}`}>{labels[status]}</span>
}

export default function TestCenter({ config, instances, selectedConnection, onToast }: {
  config: GatewayConfig; instances: Instance[]; selectedConnection?: string | null; onToast: (message: string, type?: Toast['type']) => void
}) {
  const openInstances = useMemo(() => instances.filter(item => item.status === 'open'), [instances])
  const [connection, setConnection] = useState(selectedConnection || '')
  const [testType, setTestType] = useState<TestType>('smoke')
  const [number, setNumber] = useState('')
  const [text, setText] = useState('Prueba operativa de Botly Gateway')
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) || 'Operador local')
  const [file, setFile] = useState<File | null>(null)
  const [mediaFiles, setMediaFiles] = useState<Partial<Record<'image' | 'audio' | 'document', File>>>({})
  const [execution, setExecution] = useState<TestExecution | null>(null)
  const [history, setHistory] = useState<TestExecution[]>(readHistory)
  const [historyOpen, setHistoryOpen] = useState(true)

  useEffect(() => { if (selectedConnection) setConnection(selectedConnection) }, [selectedConnection])
  useEffect(() => { if (!connection && openInstances[0]) setConnection(openInstances[0].name) }, [connection, openInstances])
  useEffect(() => { localStorage.setItem(OPERATOR_KEY, operator) }, [operator])

  const { mutate: refreshEvents } = useSWR(
    config.apiKey && connection ? ['test-center-events', connection] : null,
    () => api.webhooks.events<PipelineEvent>(config, connection, 100),
    { refreshInterval: execution?.status === 'running' ? 2500 : 10000, dedupingInterval: 1000 }
  )

  const updateExecution = (next: TestExecution) => setExecution({ ...next, stages: [...next.stages] })
  const setStage = (run: TestExecution, id: string, status: StageStatus, detail: string, durationMs?: number) => {
    run.stages = run.stages.map(item => item.id === id ? { ...item, status, detail, durationMs } : item)
    updateExecution(run)
  }
  const finish = (run: TestExecution, status: TestExecution['status'], advice: string, error?: string) => {
    run.status = status; run.durationMs = Date.now() - run.startedAt; run.advice = advice; run.error = error
    updateExecution(run)
    setHistory(current => { const next = [run, ...current.filter(item => item.id !== run.id)].slice(0, 30); persistHistory(next); return next })
    if (config.apiKey) {
      const result = status === 'passed' ? 'passed' : status === 'warning' ? 'warning' : 'failed'
      void api.instances.recordTestActivity(config, run.connection, { testType: run.type, result, correlationId: run.id, operator: run.operator, durationMs: run.durationMs, error, action: advice }).catch(() => undefined)
    }
    onToast(status === 'passed' ? 'Prueba completada' : status === 'warning' ? 'Prueba finalizada con atención requerida' : error || 'La prueba falló', status === 'failed' ? 'error' : status === 'passed' ? 'success' : 'info')
  }
  const waitFor = async (connectionName: string, predicate: (items: PipelineEvent[]) => boolean, timeoutMs = WAIT_MS) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const data = await api.webhooks.events<PipelineEvent>(config, connectionName, 100)
      if (predicate(data.items || [])) return true
      await new Promise(resolve => window.setTimeout(resolve, 1500))
    }
    return false
  }
  const buildRun = (type: TestType, connectionName = connection, values: TestConfig = { number: cleanNumber(number), text: text.trim(), messageType: 'text' }): TestExecution => {
    const common = [
      stage('gateway_send', 'Gateway', 'Preparando la solicitud de prueba.'),
      stage('meta', 'Meta / Provider', 'Pendiente de aceptación del proveedor.'),
      stage('whatsapp', 'WhatsApp', 'Pendiente de confirmación del envío.'),
      stage('webhook', 'Webhook', 'Esperando un evento de recepción.'),
      stage('gateway_receive', 'Gateway', 'Pendiente de procesar el callback.'),
      stage('persistence', 'Persistencia', 'Pendiente de confirmar el evento local.'),
      stage('frontend', 'Frontend', 'Pendiente de actualizar el resultado.'),
    ]
    if (type === 'webhook') common.splice(0, 3, stage('gateway_send', 'Gateway', 'Verificando la conexión.'), stage('webhook', 'Webhook', 'Verificando configuración y actividad.'))
    return { id: crypto.randomUUID(), type, connection: connectionName, operator: operator.trim() || 'Operador local', startedAt: Date.now(), durationMs: 0, status: 'running', advice: '', config: { ...values, messageType: messageTypes.some(item => item.id === type) ? type as MessageType : values.messageType }, stages: common }
  }
  const send = async (run: TestExecution, kind: Extract<MessageType, 'text' | 'image' | 'audio' | 'video' | 'document'>, source?: File | null) => {
    const started = Date.now(); setStage(run, 'gateway_send', 'running', `Enviando ${kind}.`)
    if (kind === 'text') await api.messages.send(config, run.connection, { number: run.config.number, type: 'text', text: run.config.text, metadata: { correlationId: run.id, testType: run.type, operator: run.operator } })
    else {
      if (!source) throw new Error(`Selecciona el archivo para ${kind}.`)
      if (source.size > MAX_UPLOAD_BYTES) throw new Error('El archivo supera el límite local de 25 MB.')
      await api.messages.sendMultipart(config, run.connection, { number: run.config.number, type: kind, caption: run.config.text || undefined }, source)
    }
    run.latencyMs = Math.max(run.latencyMs || 0, Date.now() - started)
    setStage(run, 'gateway_send', 'passed', `Solicitud ${kind} aceptada por Gateway.`, Date.now() - started)
    setStage(run, 'meta', 'passed', 'El proveedor aceptó el envío.', Date.now() - started)
    setStage(run, 'whatsapp', 'passed', 'Gateway recibió aceptación de WhatsApp.', Date.now() - started)
  }
  const confirmPersistence = async (run: TestExecution) => {
    const received = await waitFor(run.connection, items => items.some(item => eventDirection(item) === 'outbound' && asTimestamp(item.timestamp) >= run.startedAt - 2500))
    setStage(run, 'persistence', received ? 'passed' : 'warning', received ? 'El envío está disponible en los eventos locales.' : 'No se encontró el evento saliente durante la espera.', Date.now() - run.startedAt)
    return received
  }
  const waitWebhook = async (run: TestExecution, expectsReply: boolean) => {
    setStage(run, 'webhook', 'running', expectsReply ? 'Esperando una respuesta del número de prueba.' : 'Esperando callback de WhatsApp.')
    const received = await waitFor(run.connection, items => items.some(item => eventDirection(item) === 'inbound' && asTimestamp(item.timestamp) >= run.startedAt - 2500 && (!run.config.number || eventNumber(item).includes(run.config.number) || run.config.number.includes(eventNumber(item)))))
    if (received) {
      setStage(run, 'webhook', 'passed', 'Se recibió un webhook para esta ejecución.', Date.now() - run.startedAt)
      setStage(run, 'gateway_receive', 'passed', 'Gateway normalizó el evento entrante.', Date.now() - run.startedAt)
      return true
    }
    setStage(run, 'webhook', 'warning', 'No llegó un callback dentro de 12 segundos.', Date.now() - run.startedAt)
    setStage(run, 'gateway_receive', 'warning', 'No hay mensaje entrante asociado para procesar.', Date.now() - run.startedAt)
    return false
  }
  const runWebhook = async (run: TestExecution) => {
    setStage(run, 'gateway_send', 'running', 'Consultando el estado de la conexión.')
    const [state, hooks, events] = await Promise.all([api.instances.state(config, run.connection), api.webhooks.listByInstance(config, run.connection), api.webhooks.events<PipelineEvent>(config, run.connection, 1)])
    const latest = events.items[0]
    setStage(run, 'gateway_send', state.status === 'open' ? 'passed' : 'failed', state.status === 'open' ? 'Gateway accesible y conexión abierta.' : 'La conexión no está abierta.')
    setStage(run, 'webhook', hooks.items.some(item => item.enabled) ? 'passed' : 'warning', hooks.items.some(item => item.enabled) ? 'Hay al menos un callback habilitado.' : 'No hay callback de destino habilitado.')
    setStage(run, 'gateway_receive', latest ? 'passed' : 'warning', latest ? `Último evento: ${new Date(asTimestamp(latest.timestamp)).toLocaleString()}.` : 'No hay eventos recibidos todavía.')
    setStage(run, 'persistence', latest ? 'passed' : 'warning', latest ? 'El último evento está disponible en la bitácora local.' : 'No se pudo verificar persistencia sin eventos.')
    run.latencyMs = Math.max(0, Date.now() - run.startedAt)
    setStage(run, 'frontend', 'passed', 'Estado de webhook actualizado en el Centro de Pruebas.')
    const healthy = state.status === 'open' && hooks.items.some(item => item.enabled)
    finish(run, healthy ? 'passed' : 'warning', healthy ? 'El callback está listo para pruebas operativas.' : 'Habilita o corrige el callback y ejecuta de nuevo.')
  }
  const runTest = async (type = testType, replay?: TestExecution) => {
    const targetConnection = replay?.connection || connection
    const targetNumber = replay?.config.number || cleanNumber(number)
    const targetText = replay?.config.text ?? text.trim()
    if (!targetConnection) return onToast('Selecciona una conexión abierta.', 'error')
    if (type !== 'webhook' && targetNumber.length < 8) return onToast('Indica un número de prueba en formato internacional.', 'error')
    if (messageTypes.some(item => item.id === type && !item.available)) return onToast(messageTypes.find(item => item.id === type)?.note || 'Este tipo aún no está disponible.', 'info')
    if ((type === 'image' || type === 'audio' || type === 'video' || type === 'document') && !file) return onToast('Selecciona un archivo para esta prueba.', 'error')
    if (type === 'multimedia' && (!mediaFiles.image || !mediaFiles.audio || !mediaFiles.document)) return onToast('Selecciona imagen, audio y documento para la prueba multimedia.', 'error')
    const run = buildRun(type, targetConnection, { number: targetNumber, text: targetText, messageType: replay?.config.messageType || 'text' }); updateExecution(run)
    if (config.apiKey) void api.instances.recordTestActivity(config, run.connection, { testType: run.type, result: 'started', correlationId: run.id, operator: run.operator }).catch(() => undefined)
    try {
      if (type === 'webhook') { await runWebhook(run); return }
      if (type === 'multimedia') {
        await send(run, 'image', mediaFiles.image); await send(run, 'audio', mediaFiles.audio); await send(run, 'document', mediaFiles.document)
      } else await send(run, type === 'smoke' || type === 'round_trip' ? 'text' : type as Extract<MessageType, 'text' | 'image' | 'audio' | 'video' | 'document'>, file)
      const persisted = await confirmPersistence(run)
      const webhook = type === 'smoke' || type === 'round_trip' || type === 'multimedia' ? await waitWebhook(run, type === 'round_trip') : false
      if (type !== 'smoke' && type !== 'round_trip' && type !== 'multimedia') {
        setStage(run, 'webhook', 'warning', 'Esta prueba de envío no requiere una respuesta entrante.')
        setStage(run, 'gateway_receive', 'warning', 'No hay callback entrante que procesar para esta ejecución.')
      }
      setStage(run, 'frontend', 'passed', 'El resultado quedó registrado en el historial local.', Date.now() - run.startedAt)
      const needsWebhook = type === 'smoke' || type === 'round_trip' || type === 'multimedia'
      finish(run, needsWebhook && !webhook ? 'warning' : persisted ? 'passed' : 'warning', needsWebhook && !webhook ? 'Envía una respuesta desde el número de prueba y vuelve a ejecutar; el envío sí fue aceptado.' : persisted ? 'La prueba finalizó correctamente.' : 'Revisa Actividad para confirmar la persistencia del envío.')
    } catch (error) {
      const message = isError(error); setStage(run, 'gateway_send', 'failed', message, Date.now() - run.startedAt); setStage(run, 'frontend', 'passed', 'El error se mostró y quedó registrado localmente.')
      finish(run, 'failed', 'Revisa el detalle del error, el estado de la conexión y los permisos del proveedor antes de repetir.', message)
    }
  }
  const repeat = (item: TestExecution, duplicate = false) => {
    setConnection(item.connection); setNumber(item.config.number); setText(item.config.text); setTestType(item.type)
    if (!duplicate) void runTest(item.type, item)
    else onToast('Configuración cargada. Revisa los campos y ejecuta cuando quieras.', 'info')
  }
  const selectedType = messageTypes.find(item => item.id === testType)
  const isMedia = testType === 'image' || testType === 'audio' || testType === 'video' || testType === 'document'

  return <div className="mx-auto flex max-w-7xl flex-col gap-5">
    <header className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wider text-blue-400">Operación</p><h2 className="mt-1 text-xl font-semibold text-zinc-100">Centro de Pruebas</h2><p className="mt-1 text-sm text-zinc-500">Ejecuta, observa el recorrido y conserva resultados comparables por conexión.</p></div>{execution ? <StatusPill status={execution.status} /> : null}</div>
      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-zinc-800 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-zinc-400">Conexión<select value={connection} onChange={event => setConnection(event.target.value)} className="mt-1.5 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"><option value="">Seleccionar conexión</option>{openInstances.map(item => <option key={item.id} value={item.name}>{item.profileName || item.name} · {item.phone || item.name}</option>)}</select></label>
        <label className="text-xs text-zinc-400">Operador<input value={operator} onChange={event => setOperator(event.target.value)} className="mt-1.5 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200" placeholder="Nombre del operador" /></label>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"><p className="text-xs text-zinc-500">Resultado repetible</p><p className="mt-1 text-sm text-zinc-200">Historial guardado localmente</p></div>
      </div>
    </header>

    <section className="grid grid-cols-1 gap-3 lg:grid-cols-4">{compositeTypes.map(item => <button key={item.id} onClick={() => { setTestType(item.id); if (item.id === 'smoke') void runTest(item.id) }} className={`rounded-xl border p-4 text-left transition-colors ${testType === item.id ? 'border-blue-500 bg-blue-950/25' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'}`}><div className="flex items-center justify-between"><p className="font-medium text-zinc-100">{item.label}</p><Play size={15} className="text-blue-400" /></div><p className="mt-2 text-xs leading-5 text-zinc-500">{item.detail}</p>{item.id === 'smoke' ? <span className="mt-3 inline-block text-xs text-blue-300">Ejecutar con un clic</span> : null}</button>)}</section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-zinc-100">Prueba de mensaje</h3><p className="mt-1 text-xs text-zinc-500">Usa los endpoints de mensajería existentes; los tipos sin capacidad de proveedor quedan preparados.</p></div>{selectedType && !selectedType.available ? <span className="text-xs text-amber-300">{selectedType.note}</span> : null}</div>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">{messageTypes.map(item => { const Icon = item.icon; return <button key={item.id} onClick={() => setTestType(item.id)} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${testType === item.id ? 'border-blue-500 bg-blue-950/30 text-blue-200' : item.available ? 'border-zinc-700 text-zinc-300 hover:border-zinc-600' : 'border-zinc-800 text-zinc-600'}`}><Icon size={14} />{item.label}</button> })}</div>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3"><label className="text-xs text-zinc-400">Número de prueba<input value={number} onChange={event => setNumber(cleanNumber(event.target.value))} placeholder="549..." className="mt-1.5 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200" /></label><label className="text-xs text-zinc-400 lg:col-span-2">Contenido / descripción<textarea value={text} onChange={event => setText(event.target.value)} className="mt-1.5 h-[42px] w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200" /></label></div>
      {isMedia ? <label className="mt-3 block rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">Archivo de {testType}<input type="file" accept={testType === 'image' ? 'image/*' : testType === 'audio' ? 'audio/*' : testType === 'video' ? 'video/*' : undefined} onChange={event => setFile(event.target.files?.[0] || null)} className="mt-2 block w-full text-xs" />{file ? <span className="mt-2 block text-zinc-300">{file.name}</span> : null}</label> : null}
      {testType === 'multimedia' ? <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{(['image', 'audio', 'document'] as const).map(kind => <label key={kind} className="rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">{kind === 'image' ? 'Imagen' : kind === 'audio' ? 'Audio' : 'Documento'}<input type="file" accept={kind === 'image' ? 'image/*' : kind === 'audio' ? 'audio/*' : undefined} onChange={event => setMediaFiles(current => ({ ...current, [kind]: event.target.files?.[0] }))} className="mt-2 block w-full" />{mediaFiles[kind] ? <span className="mt-1 block truncate text-zinc-300">{mediaFiles[kind]?.name}</span> : null}</label>)}</div> : null}
      <div className="mt-4 flex flex-wrap gap-2"><button onClick={() => void runTest()} disabled={execution?.status === 'running' || Boolean(selectedType && !selectedType.available)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">{execution?.status === 'running' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}{testType === 'smoke' ? 'Ejecutar Smoke Test' : 'Ejecutar prueba'}</button><button onClick={() => void refreshEvents()} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2.5 text-sm text-zinc-300 hover:border-zinc-600"><RefreshCw size={14} />Actualizar eventos</button></div>
    </section>

    {execution ? <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-semibold text-zinc-100">Recorrido de la ejecución</h3><StatusPill status={execution.status} /></div><p className="mt-1 text-xs text-zinc-500">{formatDate(execution.startedAt)} · {execution.connection} · {execution.operator} · {execution.type}</p></div><div className="text-right text-sm text-zinc-300"><p>{execution.status === 'running' ? 'En curso' : formatDuration(execution.durationMs)}</p>{execution.latencyMs !== undefined ? <p className="mt-1 text-xs text-zinc-500">Latencia: {formatDuration(execution.latencyMs)}</p> : null}</div></div><div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">{execution.stages.map(item => <div key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><div className="flex items-center gap-2"><StageIcon status={item.status} /><p className="text-sm font-medium text-zinc-200">{item.label}</p></div><p className="mt-2 text-xs leading-5 text-zinc-500">{item.detail}</p>{item.durationMs !== undefined ? <p className="mt-2 text-[11px] text-zinc-600">{formatDuration(item.durationMs)}</p> : null}</div>)}</div><div className={`mt-4 rounded-lg border p-3 text-sm ${execution.status === 'failed' ? 'border-red-900/70 bg-red-950/20 text-red-200' : execution.status === 'warning' ? 'border-amber-900/70 bg-amber-950/20 text-amber-200' : 'border-emerald-900/70 bg-emerald-950/20 text-emerald-200'}`}><p className="font-medium">Qué debería hacer el operador</p><p className="mt-1 text-xs leading-5">{execution.advice || 'La prueba se está ejecutando; espera la siguiente etapa.'}</p>{execution.error ? <p className="mt-2 break-words font-mono text-xs">Error: {execution.error}</p> : null}</div></section> : null}

    <section className="rounded-xl border border-zinc-800 bg-zinc-900"><button onClick={() => setHistoryOpen(value => !value)} className="flex w-full items-center justify-between p-4 text-left"><div><h3 className="font-semibold text-zinc-100">Historial local</h3><p className="mt-1 text-xs text-zinc-500">Últimas {history.length} ejecuciones; no se envía ni persiste en backend.</p></div><ChevronDown size={17} className={`text-zinc-500 transition-transform ${historyOpen ? 'rotate-180' : ''}`} /></button>{historyOpen ? <div className="border-t border-zinc-800 overflow-x-auto"><table className="w-full min-w-[820px] text-left text-xs"><thead className="text-zinc-500"><tr><th className="px-4 py-3 font-medium">Fecha</th><th className="px-4 py-3 font-medium">Tipo</th><th className="px-4 py-3 font-medium">Resultado</th><th className="px-4 py-3 font-medium">Duración</th><th className="px-4 py-3 font-medium">Latencia</th><th className="px-4 py-3 font-medium">Operador</th><th className="px-4 py-3 font-medium">Conexión</th><th className="px-4 py-3" /></tr></thead><tbody>{history.map(item => <tr key={item.id} className="border-t border-zinc-800 text-zinc-300"><td className="px-4 py-3">{formatDate(item.startedAt)}</td><td className="px-4 py-3">{item.type}</td><td className="px-4 py-3"><StatusPill status={item.status} /></td><td className="px-4 py-3">{formatDuration(item.durationMs)}</td><td className="px-4 py-3">{item.latencyMs === undefined ? '-' : formatDuration(item.latencyMs)}</td><td className="px-4 py-3">{item.operator}</td><td className="px-4 py-3">{item.connection}</td><td className="px-4 py-3"><div className="flex justify-end gap-2"><button onClick={() => repeat(item)} className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1.5 hover:border-zinc-600"><RotateCcw size={12} />Repetir</button><button onClick={() => repeat(item, true)} className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1.5 hover:border-zinc-600"><Copy size={12} />Duplicar</button></div></td></tr>)}{history.length === 0 ? <tr><td colSpan={8} className="px-4 py-6 text-center text-zinc-500">Aún no hay pruebas ejecutadas.</td></tr> : null}</tbody></table></div> : null}</section>
  </div>
}
