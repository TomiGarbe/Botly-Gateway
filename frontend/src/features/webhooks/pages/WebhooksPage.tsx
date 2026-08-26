import { Activity, ChevronRight, CircleAlert, Plus, Webhook } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Connection } from '@/domain/connection'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { Toast } from '@/shared/components/Toast'
import { listConnections } from '@/features/connections/api/connectionsApi'
import { createWebhook, listWebhooks, type WebhookInput, type WebhookRecord } from '../api/webhooksApi'
import { WebhookForm } from '../components/WebhookForm'

function dateTime(value: string | null): string { return value ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Sin actividad' }
function eventLabel(filters: Record<string, boolean>): string { const labels = { business: 'Negocio', transport: 'Transporte', operational: 'Operativo' }; const active = Object.entries(filters).filter(([, enabled]) => enabled).map(([key]) => labels[key as keyof typeof labels] || key); return active.length ? active.join(' · ') : 'Sin eventos' }
function lastResult(webhook: WebhookRecord): string { if (!webhook.lastUsedAt) return '— Sin actividad'; const result = webhook.lastStatusCode ? `HTTP ${webhook.lastStatusCode}` : webhook.lastStatus || 'Sin respuesta'; return `${webhook.lastStatusCode && webhook.lastStatusCode >= 200 && webhook.lastStatusCode < 300 ? '✓' : '✕'} ${result} · ${dateTime(webhook.lastUsedAt)}` }

export function WebhooksPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialConnectionId = searchParams.get('connectionId') || undefined
  const [items, setItems] = useState<WebhookRecord[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const connectionNames = useMemo(() => new Map(connections.map((connection) => [connection.id, connection.name])), [connections])
  const load = useCallback(async () => {
    setError(null); setIsLoading(true)
    try { const [webhooks, availableConnections] = await Promise.all([listWebhooks(initialConnectionId), listConnections()]); setItems(webhooks); setConnections(availableConnections) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron cargar los webhooks.') }
    finally { setIsLoading(false) }
  }, [initialConnectionId])
  useEffect(() => { void load() }, [load])

  async function submit(input: Omit<WebhookInput, 'connectionId'> & { connectionId?: string }) {
    if (!input.connectionId) return
    setIsSubmitting(true); setError(null)
    try { const created = await createWebhook(input as WebhookInput); setNotice('Webhook creado.'); navigate(`/webhooks/${created.id}`) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo crear el webhook.') }
    finally { setIsSubmitting(false) }
  }

  return <section className="webhooks-page">
    <div className="webhooks-heading"><div><p>Webhooks</p><h2>Destinos y entregas</h2><span>Administrá cada destino de forma independiente.</span></div><button type="button" className="client-button-primary" onClick={() => setIsCreating(true)}><Plus size={16} /> Crear webhook</button></div>
    <Toast message={error} tone="error" onDismiss={() => setError(null)} /><Toast message={notice} onDismiss={() => setNotice(null)} />
    {isCreating ? <WebhookForm connections={connections} connectionId={initialConnectionId} isSubmitting={isSubmitting} onCancel={() => setIsCreating(false)} onSubmit={submit} /> : null}
    {isLoading ? <LoadingState label="Cargando webhooks…" /> : null}
    {!isLoading && error ? <div className="clients-state clients-state-error" role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>Reintentar</button></div> : null}
    {!isLoading && !error && items.length === 0 ? <EmptyState icon={Webhook} title="No hay webhooks configurados." description="Creá un destino para comenzar a recibir entregas." action={<button type="button" className="client-button-primary" onClick={() => setIsCreating(true)}><Plus size={16} /> Crear webhook</button>} /> : null}
    {!isLoading && !error && items.length > 0 ? <div className="webhooks-list">{items.map((webhook) => <article key={webhook.id} className="webhook-card"><div className="webhook-card-heading"><div><div className="webhook-card-title"><h3>{webhook.name}</h3><span className={webhook.enabled ? 'webhook-enabled is-active' : 'webhook-enabled'}>{webhook.enabled ? '● Activo' : '○ Desactivado'}</span></div><p>{connectionNames.get(webhook.connectionId) || 'Conexión no disponible'}</p></div><button type="button" className="client-button-secondary" onClick={() => navigate(`/webhooks/${webhook.id}`)}>Ver <ChevronRight size={15} /></button></div><code>{webhook.url}</code><div className="webhook-card-meta"><span>Eventos: {eventLabel(webhook.eventFilters)}</span><span>Actualizado: {dateTime(webhook.updatedAt)}</span></div><div className={`webhook-last-result ${webhook.lastStatusCode && webhook.lastStatusCode >= 200 && webhook.lastStatusCode < 300 ? 'is-success' : webhook.lastUsedAt ? 'is-error' : ''}`}><Activity size={15} /><span>Última entrega</span><strong>{lastResult(webhook)}</strong>{webhook.failureCount > 0 ? <small><CircleAlert size={13} /> {webhook.failureCount} error{webhook.failureCount === 1 ? '' : 'es'}</small> : null}</div></article>)}</div> : null}
  </section>
}
