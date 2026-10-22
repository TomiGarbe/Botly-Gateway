import { CircleAlert, RefreshCw, Search, UsersRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/shared/components/EmptyState'
import { LoadingState } from '@/shared/components/LoadingState'
import { StatusBadge, type StatusTone } from '@/shared/components/StatusBadge'
import { listConnectionGroups, type ConnectionGroup, type ConnectionGroups as Overview } from '../api/groupsApi'

const stateLabel: Record<ConnectionGroup['state'], { label: string; tone: StatusTone }> = {
  captured: { label: 'Capturando', tone: 'healthy' },
  excluded: { label: 'Excluido en Botly', tone: 'neutral' },
  not_authorized: { label: 'No autorizado', tone: 'attention' },
}

function dateTime(value: number | null): string {
  if (!value) return 'Sin mensajes desde que se conectó'
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function transportSummary(overview: Overview): { label: string; tone: StatusTone; description: string } {
  if (!overview.configured) return { label: 'Sin vincular', tone: 'pending', description: 'Botly todavía no registró esta cuenta para grupos. Se vincula sola en menos de un minuto si el webhook apunta a Botly.' }
  if (!overview.enabled) return { label: 'Desactivado', tone: 'attention', description: 'El transporte de grupos está apagado para esta cuenta.' }
  return {
    label: 'Activo',
    tone: 'healthy',
    description: overview.admission === 'account'
      ? 'Todos los grupos de la cuenta llegan a Botly, salvo los que se excluyan desde Botly.'
      : 'Solo llegan a Botly los grupos autorizados explícitamente.',
  }
}

export function ConnectionGroups({ connectionId }: { connectionId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    setIsLoading(true)
    try { setOverview(await listConnectionGroups(connectionId)); setError(null) } catch { setError('No se pudieron cargar los grupos de esta conexión.') } finally { setIsLoading(false) }
  }, [connectionId])
  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return (overview?.groups ?? []).filter((group) => !term || group.displayName.toLocaleLowerCase().includes(term) || group.externalId.includes(term))
  }, [overview, query])

  if (isLoading && !overview) return <LoadingState label="Cargando grupos" />
  if (error) return <EmptyState icon={CircleAlert} title="Grupos no disponibles" description={error} action={<button type="button" className="client-button-secondary" onClick={() => void load()}>Reintentar</button>} />
  if (!overview) return null

  const summary = transportSummary(overview)
  const failing = overview.groups.filter((group) => group.failed > 0).length
  return <section className="connection-section connection-groups">
    <div className="connection-section-heading">
      <div><h3>Grupos de WhatsApp</h3><p>{summary.description}</p></div>
      <button type="button" className="client-button-secondary" onClick={() => void load()} disabled={isLoading}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button>
    </div>
    <dl className="connection-information-list">
      <div><dt>Transporte</dt><dd><StatusBadge tone={summary.tone}>{summary.label}</StatusBadge></dd></div>
      <div><dt>Grupos</dt><dd>{overview.groups.length}{overview.directoryLoaded ? '' : ' · cargando el directorio completo de la cuenta'}</dd></div>
      <div><dt>Con entregas fallidas</dt><dd>{failing ? <StatusBadge tone="critical">{failing}</StatusBadge> : 'Ninguno'}</dd></div>
      <div><dt>Identidades del bot</dt><dd>{overview.botIdentities.length ? overview.botIdentities.join(' · ') : 'Sin identificar'}</dd></div>
    </dl>
    <p className="connection-endpoint-note">Qué grupos se capturan y si el bot responde se configura desde Botly. Esta vista es de solo lectura.</p>
    {overview.groups.length ? <>
      <div className="webhook-activity-toolbar"><label className="webhook-activity-search"><Search size={15} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar grupo" aria-label="Buscar grupo" /></label></div>
      <ul className="connection-groups-list">{groups.map((group) => {
        const state = stateLabel[group.state]
        return <li key={group.externalId} className="connection-group-row">
          <div className="connection-group-main"><strong title={group.externalId}>{group.displayName}</strong><span>{dateTime(group.lastEventAt)}</span></div>
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          <div className="delivery-meta"><span>{group.participants} participantes</span><span>{group.delivered} entregados</span>{group.failed ? <span className="is-error">{group.failed} fallidos</span> : null}</div>
          {group.failed && group.lastError ? <p className="connection-group-error">Último error: {group.lastError}</p> : null}
        </li>
      })}</ul>
      {!groups.length ? <p className="connection-endpoint-note">Ningún grupo coincide con la búsqueda.</p> : null}
    </> : <EmptyState icon={UsersRound} title="Sin grupos todavía" description="Los grupos aparecen cuando Botly carga el directorio de la cuenta o cuando llega el primer mensaje de un grupo." />}
  </section>
}
