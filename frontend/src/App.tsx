import { useState, useCallback, useEffect } from 'react'
import useSWR from 'swr'
import { Menu, MessageCircle, Plus, RefreshCw } from 'lucide-react'
import Sidebar from './components/Sidebar'
import ConnectionInventory from './components/ConnectionInventory'
import ConnectionDetails from './components/ConnectionDetails'
import QRModal from './components/QRModal'
import CreateModal from './components/CreateModal'
import SettingsModal from './components/SettingsModal'
import MediaLab from './components/MediaLab'
import TestCenter from './components/TestCenter'
import InstanceApiKeyModal from './components/InstanceApiKeyModal'
import WebhooksManager from './components/WebhooksManager'
import ApiKeyRevealModal from './components/ApiKeyRevealModal'
import OperationalDashboard from './components/OperationalDashboard'
import ActivityCenter from './components/ActivityCenter'
import AlertsCenter from './components/AlertsCenter'
import AutomationCenter from './components/AutomationCenter'
import OperationsCenter from './components/OperationsCenter'
import { api, ApiError } from './lib/api'
import { loadConfig, type GatewayConfig } from './lib/config'
import { publicInstances, resolveFeatures } from './lib/features'
import type { CreateConnectionPayload, OperationType, PipelineEvent, Toast } from './types'

function Toasts({ toasts, remove }: { toasts: Toast[]; remove: (id: string) => void }) {
  return (
    <div className="fixed bottom-20 lg:bottom-4 right-4 left-4 sm:left-auto flex flex-col gap-2 z-[200] pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={`
            pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium
            border shadow-xl cursor-pointer animate-slide-up
            ${t.type === 'success' ? 'bg-zinc-900 border-emerald-800 text-emerald-400' :
              t.type === 'error' ? 'bg-zinc-900 border-red-900 text-red-400' :
              'bg-zinc-900 border-zinc-700 text-zinc-300'}
          `}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-5">
      <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center">
        <MessageCircle size={28} className="text-zinc-600" />
      </div>
      <div className="text-center">
        <p className="font-semibold text-zinc-200">Sin conexiones</p>
        <p className="text-sm text-zinc-500 mt-1">Crea una conexion para vincular un numero de WhatsApp</p>
      </div>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
      >
        <Plus size={15} />
        Nueva conexion
      </button>
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState<GatewayConfig>(loadConfig)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [qrTarget, setQrTarget] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [apiKeyTarget, setApiKeyTarget] = useState<string | null>(null)
  const [view, setView] = useState<'dashboard' | 'instances' | 'messages' | 'tests' | 'webhooks' | 'activity' | 'alerts' | 'automations' | 'operations'>('dashboard')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [revealedApiKey, setRevealedApiKey] = useState<{ instanceName: string; apiKey: string; title: string; description: string } | null>(null)
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null)
  const [activityConnection, setActivityConnection] = useState<string | null>(null)
  const [workspaceTab, setWorkspaceTab] = useState<'summary' | 'activity' | 'tests' | 'webhooks' | 'diagnostics' | 'settings'>('summary')

  useEffect(() => {
    if (!config.apiKey) setShowSettings(true)
  }, [config.apiKey])

  useEffect(() => {
    document.body.classList.toggle('overflow-hidden', mobileNavOpen)
    return () => document.body.classList.remove('overflow-hidden')
  }, [mobileNavOpen])

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setToasts(ts => [...ts, { id, message, type }])
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 4000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(ts => ts.filter(t => t.id !== id))
  }, [])

  const { data: instances, isLoading, isValidating, mutate, error: instancesError } = useSWR(
    config.apiKey ? 'instances' : null,
    () => api.instances.list(config),
    {
      refreshInterval: () => (document.hidden ? 30000 : 12000),
      revalidateOnFocus: true,
      dedupingInterval: 4000,
      shouldRetryOnError: true,
      errorRetryInterval: 8000,
    }
  )
  const { data: channelCatalog } = useSWR(
    config.apiKey ? 'channel-catalog' : null,
    () => api.channels.catalog(config),
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  )
  const { data: globalActivity } = useSWR(
    config.apiKey ? ['global-activity', config.url] : null,
    () => api.webhooks.events<PipelineEvent>(config, undefined, 500),
    { refreshInterval: () => (document.hidden ? 30000 : 15000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const { data: alertsData, isLoading: alertsLoading, mutate: mutateAlerts } = useSWR(
    config.apiKey ? ['alerts', config.url] : null,
    () => api.alerts.list(config),
    { refreshInterval: () => (document.hidden ? 30000 : 15000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const alerts = alertsData?.items || []
  const { data: automationsData, isLoading: automationsLoading, mutate: mutateAutomations } = useSWR(
    config.apiKey ? ['automations', config.url] : null,
    () => api.automations.list(config),
    { refreshInterval: () => (document.hidden ? 30000 : 15000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const { data: automationExecutionsData, mutate: mutateAutomationExecutions } = useSWR(
    config.apiKey ? ['automation-executions', config.url] : null,
    () => api.automations.executions(config, { limit: 100 }),
    { refreshInterval: () => (document.hidden ? 30000 : 15000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const automations = automationsData?.items || []
  const automationExecutions = automationExecutionsData?.items || []
  const { data: operationsData, isLoading: operationsLoading, mutate: mutateOperations } = useSWR(
    config.apiKey ? ['operations', config.url] : null,
    () => api.operations.list(config, { limit: 100 }),
    { refreshInterval: () => (document.hidden ? 30000 : 5000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const { data: operationsSummaryData, mutate: mutateOperationsSummary } = useSWR(
    config.apiKey ? ['operations-summary', config.url] : null,
    () => api.operations.summary(config),
    { refreshInterval: () => (document.hidden ? 30000 : 5000), revalidateOnFocus: true, shouldRetryOnError: false }
  )
  const operations = operationsData?.items || []
  const features = resolveFeatures(channelCatalog?.features)
  const qrEnabled = features.qrLogin

  const handleCreate = useCallback(async (payload: CreateConnectionPayload) => {
    if (payload.connectionType === 'cloud_embedded') {
      const created = await api.metaSignup.complete(config, payload)
      addToast(`Conexion "${payload.instanceName}" creada`, 'success')
      await mutate()
      if (qrEnabled && created.connectionType !== 'cloud') {
        setQrTarget(payload.instanceName)
      }
      return created
    }
    const created = await api.instances.create(config, payload)
    addToast(`Conexion "${payload.instanceName}" creada`, 'success')
    await mutate()
    if (created.apiKey) {
      setRevealedApiKey({
        instanceName: payload.instanceName,
        apiKey: created.apiKey,
        title: 'API key creada',
        description: 'Guardala ahora. Esta es la unica vez que el panel muestra la API key completa al crear la conexion.',
      })
    }
    if (qrEnabled && created.instance.connectionType !== 'cloud') {
      setQrTarget(payload.instanceName)
    }
    return created.instance
  }, [config, mutate, addToast, qrEnabled])

  const handleLogout = useCallback(async (name: string) => {
    if (!confirm(`Desconectar "${name}" de WhatsApp?\n\nHabra que re-escanear el QR para volver a conectar.`)) return
    try {
      await api.instances.logout(config, name)
      addToast(`"${name}" desconectado`, 'success')
      mutate()
    } catch (e) {
      addToast(e instanceof ApiError ? e.message : 'Error al desconectar', 'error')
    }
  }, [config, mutate, addToast])

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Eliminar la conexion "${name}"?\n\nEsta accion no se puede deshacer.`)) return
    try {
      await api.instances.delete(config, name)
      addToast(`Conexion "${name}" eliminada`, 'success')
      setSelectedConnection(current => current === name ? null : current)
      mutate()
    } catch (e) {
      addToast(e instanceof ApiError ? e.message : 'Error al eliminar', 'error')
    }
  }, [config, mutate, addToast])

  const handleConnected = useCallback(() => {
    addToast('Numero conectado exitosamente', 'success')
    setQrTarget(null)
    mutate()
  }, [addToast, mutate])

  const handleReconnect = useCallback(async (name: string) => {
    try {
      await api.instances.reconnect(config, name)
      addToast(`"${name}" reconectando`, 'success')
      mutate()
    } catch (e) {
      addToast(e instanceof ApiError ? e.message : 'No se pudo reconectar', 'error')
    }
  }, [config, mutate, addToast])

  const enqueueOperation = useCallback(async (type: OperationType, targets: string[], scope: 'selected' | 'all' = 'selected') => {
    try {
      await api.operations.create(config, { type, targets, scope })
      await Promise.all([mutateOperations(), mutateOperationsSummary()])
      addToast('Operación agregada a la cola', 'success')
    } catch (error) {
      addToast(error instanceof ApiError ? error.message : 'No se pudo encolar la operación', 'error')
    }
  }, [config, mutateOperations, mutateOperationsSummary, addToast])

  const executeAutomation = useCallback(async (id: string) => {
    try {
      await api.automations.execute(config, id)
      await Promise.all([mutateAutomations(), mutateAutomationExecutions(), mutateAlerts()])
      addToast('Automatización ejecutada', 'success')
    } catch (error) {
      addToast(error instanceof ApiError ? error.message : 'No se pudo ejecutar la automatización', 'error')
    }
  }, [config, mutateAutomations, mutateAutomationExecutions, mutateAlerts, addToast])

  const list = publicInstances(Array.isArray(instances) ? instances : [], features)
  const selectedInstance = selectedConnection ? list.find(item => item.name === selectedConnection) || null : null

  return (
    <div className="flex min-h-screen bg-zinc-950">
      <Sidebar
        onOpenSettings={() => setShowSettings(true)}
        view={view}
        onChangeView={next => { if (next === 'activity') setActivityConnection(null); setView(next) }}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 min-h-14 py-3 border-b border-zinc-800 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                aria-label="Abrir menu"
              >
                <Menu size={16} />
              </button>
              <h1 className="font-semibold text-sm">{view === 'dashboard' ? 'Dashboard Operativo' : view === 'instances' ? 'Conexiones' : view === 'messages' ? 'Mensajes' : view === 'tests' ? 'Centro de Pruebas' : view === 'webhooks' ? 'Webhooks' : view === 'alerts' ? 'Centro de Alertas' : view === 'automations' ? 'Centro de Automatizaciones' : view === 'operations' ? 'Centro de Operaciones' : 'Centro de Actividad'}</h1>
            </div>
            {!isLoading && view === 'instances' && (
              <p className="text-xs text-zinc-500 mt-0.5 ml-12 lg:ml-0">
                {list.length} {list.length === 1 ? 'conexion' : 'conexiones'} totales
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {view === 'dashboard' || view === 'instances' ? (
              <>
                <button
                  onClick={() => mutate()}
                  disabled={isValidating}
                  className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors disabled:opacity-40"
                >
                  <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} />
                  <span className="hidden sm:inline">Actualizar</span>
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                >
                  <Plus size={13} />
                  <span className="hidden sm:inline">Nueva conexion</span>
                </button>
              </>
            ) : null}
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 lg:pb-6">
          {view === 'dashboard' ? (
            <OperationalDashboard
              instances={list}
              events={globalActivity?.items || []}
              alerts={alerts}
              automations={automations}
              automationExecutions={automationExecutions}
              operations={operations}
              isLoading={isLoading}
              onNewConnection={() => setShowCreate(true)}
              onOpenTests={() => setView('tests')}
              onOpenActivity={() => { setActivityConnection(null); setView('activity') }}
              onOpenAlerts={() => setView('alerts')}
              onOpenAutomations={() => setView('automations')}
              onOpenOperations={() => setView('operations')}
              onOpenConnections={() => setView('instances')}
              onOpenWorkspace={name => { setWorkspaceTab('summary'); setSelectedConnection(name); setView('instances') }}
            />
          ) : view === 'messages' ? (
            <MediaLab
              config={config}
              instances={list}
              instancesLoading={isLoading}
              instancesError={instancesError instanceof Error ? instancesError.message : undefined}
              onToast={addToast}
            />
          ) : view === 'tests' ? (
            <TestCenter
              config={config}
              instances={list}
              selectedConnection={selectedConnection}
              onToast={addToast}
            />
          ) : view === 'webhooks' ? (
            <WebhooksManager config={config} instances={list} onToast={addToast} />
          ) : view === 'activity' ? (
            <div className="mx-auto max-w-7xl"><ActivityCenter events={(globalActivity?.items || []).filter(event => !activityConnection || event.instance === activityConnection)} /></div>
          ) : view === 'alerts' ? (
            <AlertsCenter
              alerts={alerts}
              loading={alertsLoading}
              onUpdate={async (id, status) => { await api.alerts.update(config, id, status); await mutateAlerts() }}
              onOpenWorkspace={name => { setWorkspaceTab('summary'); setSelectedConnection(name); setView('instances') }}
              onOpenActivity={name => { setActivityConnection(name); setView('activity') }}
              onOpenDiagnostics={name => { setWorkspaceTab('diagnostics'); setSelectedConnection(name); setView('instances') }}
              onOpenTests={name => { setSelectedConnection(name); setView('tests') }}
              onReconnect={handleReconnect}
            />
          ) : view === 'automations' ? (
            <AutomationCenter
              automations={automations}
              executions={automationExecutions}
              instances={list}
              loading={automationsLoading}
              onCreate={async draft => { await api.automations.create(config, { name: draft.name, description: null, provider: null, company: null, connection: draft.connection || null, trigger: draft.trigger === 'interval' ? { type: draft.trigger, intervalMinutes: draft.intervalMinutes } : { type: draft.trigger }, conditions: [], actions: [{ type: draft.action, params: {} }], retryPolicy: { maxAttempts: draft.retries, backoff: draft.retries === 3 } }); await Promise.all([mutateAutomations(), mutateAutomationExecutions()]) }}
              onUpdate={async (id, status) => { await api.automations.update(config, id, { status }); await mutateAutomations() }}
              onExecute={executeAutomation}
              onOpenWorkspace={name => { setWorkspaceTab('summary'); setSelectedConnection(name); setView('instances') }}
            />
          ) : view === 'operations' ? (
            <OperationsCenter
              jobs={operations}
              summary={operationsSummaryData}
              instances={list}
              loading={operationsLoading}
              onCreate={enqueueOperation}
              onCancel={async id => { try { await api.operations.cancel(config, id); await Promise.all([mutateOperations(), mutateOperationsSummary()]); addToast('Operación cancelada', 'success') } catch (error) { addToast(error instanceof ApiError ? error.message : 'No se pudo cancelar la operación', 'error') } }}
              onRetry={async id => { try { await api.operations.retry(config, id); await Promise.all([mutateOperations(), mutateOperationsSummary()]); addToast('Reintento agregado a la cola', 'success') } catch (error) { addToast(error instanceof ApiError ? error.message : 'No se pudo reintentar la operación', 'error') } }}
              onDuplicate={async id => { try { await api.operations.duplicate(config, id); await Promise.all([mutateOperations(), mutateOperationsSummary()]); addToast('Operación duplicada', 'success') } catch (error) { addToast(error instanceof ApiError ? error.message : 'No se pudo duplicar la operación', 'error') } }}
            />
          ) : isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 h-36 animate-pulse" />
              ))}
            </div>
          ) : !config.apiKey ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <p className="text-zinc-500 text-sm">Configura el panel para empezar</p>
              <button
                onClick={() => setShowSettings(true)}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Abrir configuracion
              </button>
            </div>
          ) : selectedInstance ? (
            <ConnectionDetails
              config={config}
              instance={selectedInstance}
              onBack={() => { setWorkspaceTab('summary'); setSelectedConnection(null) }}
              onToast={addToast}
              onRefresh={() => void mutate()}
              onQR={setQrTarget}
              onReconnect={handleReconnect}
              onApiKey={setApiKeyTarget}
              onDelete={handleDelete}
              onOpenMessages={() => setView('messages')}
              onOpenTests={() => setView('tests')}
              onOpenWebhooks={() => setView('webhooks')}
              alerts={alerts}
              onOpenAlerts={() => setView('alerts')}
              automations={automations}
              onOpenAutomations={() => setView('automations')}
              onExecuteAutomation={id => { void executeAutomation(id) }}
              operations={operations}
              onOpenOperations={() => setView('operations')}
              qrEnabled={qrEnabled}
              initialTab={workspaceTab}
            />
          ) : list.length === 0 ? (
            <EmptyState onAdd={() => setShowCreate(true)} />
          ) : (
            <ConnectionInventory
              config={config}
              instances={list}
              events={globalActivity?.items || []}
              alerts={alerts}
              onOpenWorkspace={name => { setWorkspaceTab('summary'); setSelectedConnection(name) }}
              onOpenTests={name => { setSelectedConnection(name); setView('tests') }}
              onReconnect={handleReconnect}
              onLogout={handleLogout}
              onDelete={handleDelete}
              onOpenActivity={name => { setActivityConnection(name); setView('activity') }}
              onOpenDiagnostics={name => { setWorkspaceTab('diagnostics'); setSelectedConnection(name) }}
              onBulkOperation={(type, targets) => { void enqueueOperation(type, targets) }}
              onToast={addToast}
            />
          )}
        </main>
      </div>

      {qrEnabled && qrTarget && (
        <QRModal
          instanceName={qrTarget}
          config={config}
          onClose={() => setQrTarget(null)}
          onConnected={handleConnected}
        />
      )}
      {showCreate && (
        <CreateModal
          config={config}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
          onOpenWorkspace={name => { setShowCreate(false); setWorkspaceTab('summary'); setSelectedConnection(name); setView('instances') }}
          onOpenTests={name => { setShowCreate(false); setSelectedConnection(name); setView('tests') }}
        />
      )}
      {showSettings && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onChange={setConfig}
        />
      )}
      {apiKeyTarget && (
        <InstanceApiKeyModal
          config={config}
          instanceName={apiKeyTarget}
          onClose={() => setApiKeyTarget(null)}
          onToast={addToast}
          onRevealApiKey={apiKey =>
            setRevealedApiKey({
              instanceName: apiKeyTarget,
              apiKey,
              title: 'API key regenerada',
              description: 'La clave anterior ya no sirve. Copia esta nueva API key y actualiza tus integraciones antes de seguir.',
            })
          }
        />
      )}
      {revealedApiKey && (
        <ApiKeyRevealModal
          apiKey={revealedApiKey.apiKey}
          instanceName={revealedApiKey.instanceName}
          title={revealedApiKey.title}
          description={revealedApiKey.description}
          onClose={() => setRevealedApiKey(null)}
          onToast={addToast}
        />
      )}

      <Toasts toasts={toasts} remove={removeToast} />

      <nav className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-2 py-2">
        <div className="mobile-nav">
          <button
            type="button"
            onClick={() => setView('dashboard')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'dashboard' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Inicio
          </button>
          <button
            type="button"
            onClick={() => setView('instances')}
            className={`rounded-lg px-3 py-2 text-xs ${view === 'instances' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Conexiones
          </button>
          <button
            type="button"
            onClick={() => setView('messages')}
            className={`rounded-lg px-3 py-2 text-xs ${view === 'messages' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Mensajes
          </button>
          <button
            type="button"
            onClick={() => setView('tests')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'tests' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Pruebas
          </button>
          <button
            type="button"
            onClick={() => setView('webhooks')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'webhooks' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Webhooks
          </button>
          <button
            type="button"
            onClick={() => setView('activity')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'activity' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Actividad
          </button>
          <button
            type="button"
            onClick={() => setView('alerts')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'alerts' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Alertas
          </button>
          <button
            type="button"
            onClick={() => setView('automations')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'automations' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Flujos
          </button>
          <button
            type="button"
            onClick={() => setView('operations')}
            className={`rounded-lg px-2 py-2 text-xs ${view === 'operations' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500'}`}
          >
            Operaciones
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="rounded-lg px-3 py-2 text-xs text-zinc-500"
          >
            Ajustes
          </button>
        </div>
      </nav>
    </div>
  )
}
