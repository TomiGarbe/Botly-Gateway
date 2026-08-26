import { FormEvent, useState } from 'react'
import type { Connection } from '@/domain/connection'
import type { WebhookAuthType, WebhookInput, WebhookRecord } from '../api/webhooksApi'

const authOptions: Array<{ id: WebhookAuthType; label: string }> = [
  { id: 'NONE', label: 'Sin autenticación' }, { id: 'BEARER', label: 'Bearer token' }, { id: 'API_KEY', label: 'API key por header' },
  { id: 'BASIC', label: 'Basic auth' }, { id: 'CUSTOM_HEADERS', label: 'Header personalizado' }, { id: 'QUERY_PARAM', label: 'Query param' },
]
const filters = [['business', 'Eventos de negocio'], ['transport', 'Eventos de transporte'], ['operational', 'Eventos operativos']] as const

type FormInput = Omit<WebhookInput, 'connectionId'> & { connectionId?: string }

export function WebhookForm({ webhook, connections, connectionId, isSubmitting, onCancel, onSubmit }: {
  webhook?: WebhookRecord
  connections: Connection[]
  connectionId?: string
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (input: FormInput) => Promise<void>
}) {
  const [name, setName] = useState(webhook?.name || '')
  const [selectedConnection, setSelectedConnection] = useState(connectionId || webhook?.connectionId || '')
  const [url, setUrl] = useState(webhook?.url || '')
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true)
  const [authType, setAuthType] = useState<WebhookAuthType>(webhook?.authType || 'NONE')
  const [authName, setAuthName] = useState(String(webhook?.authConfig.headerName || webhook?.authConfig.queryParamName || Object.keys(webhook?.customHeaders || {})[0] || ''))
  const [username, setUsername] = useState(String(webhook?.authConfig.username || ''))
  const [secret, setSecret] = useState('')
  const [eventFilters, setEventFilters] = useState<Record<string, boolean>>(webhook?.eventFilters || { business: true, transport: false, operational: false })
  const [validationError, setValidationError] = useState<string | null>(null)

  const hasExistingSecret = Boolean(webhook && Object.entries(webhook.authConfig).some(([key, value]) => key.startsWith('has') && value === true) || webhook?.hasCustomHeaders)
  const nameLabel = authType === 'QUERY_PARAM' ? 'Nombre del parámetro' : authType === 'CUSTOM_HEADERS' ? 'Nombre del header' : 'Nombre del header'
  const needsName = authType === 'API_KEY' || authType === 'CUSTOM_HEADERS' || authType === 'QUERY_PARAM'
  const needsSecret = authType !== 'NONE'

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    if (!trimmedName || trimmedName.length > 120) return setValidationError('Ingresá un nombre de hasta 120 caracteres.')
    try { const parsed = new URL(trimmedUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error() } catch { return setValidationError('Ingresá una URL HTTP(S) válida.') }
    if (!Object.values(eventFilters).some(Boolean)) return setValidationError('Seleccioná al menos un tipo de evento.')
    if (!webhook && !selectedConnection) return setValidationError('Seleccioná la conexión asociada.')
    if (needsName && !authName.trim()) return setValidationError(`Ingresá ${nameLabel.toLowerCase()}.`)
    if (needsSecret && !secret && !hasExistingSecret) return setValidationError('Ingresá el secreto de autenticación.')
    if (authType === 'BASIC' && !username.trim()) return setValidationError('Ingresá el usuario para Basic auth.')

    setValidationError(null)
    const authConfig: Record<string, string> = {}
    let customHeaders: Record<string, string> | undefined
    if (authType === 'BEARER' && secret) authConfig.token = secret
    if (authType === 'API_KEY') { authConfig.headerName = authName || 'x-api-key'; if (secret) authConfig.apiKey = secret }
    if (authType === 'BASIC') { authConfig.username = username; if (secret) authConfig.password = secret }
    if (authType === 'QUERY_PARAM') { authConfig.queryParamName = authName; if (secret) authConfig.queryParamValue = secret }
    if (authType === 'CUSTOM_HEADERS' && secret) customHeaders = { [authName]: secret }
    const shouldSendAuth = !webhook || authType !== webhook.authType || Boolean(secret) || authName !== String(webhook.authConfig.headerName || webhook.authConfig.queryParamName || Object.keys(webhook.customHeaders || {})[0] || '') || username !== String(webhook.authConfig.username || '')
    await onSubmit({ connectionId: webhook ? undefined : selectedConnection, name: trimmedName, url: trimmedUrl, enabled, authType, eventFilters, ...(shouldSendAuth ? { authConfig, customHeaders } : {}) })
  }

  return <form className="client-form webhook-form" onSubmit={(event) => void submit(event)}>
    {validationError ? <p className="client-form-error" role="alert">{validationError}</p> : null}
    {!webhook ? <label><span>Conexión</span><select value={selectedConnection} onChange={(event) => setSelectedConnection(event.target.value)} required><option value="">Seleccionar conexión…</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}{connection.client ? ` · ${connection.client.name}` : ''}</option>)}</select></label> : null}
    <label><span>Nombre</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Ej. CRM Integration" required /></label>
    <label><span>URL de destino</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" required /></label>
    <label className="webhook-enabled-control"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Dejar webhook activo al guardar</span></label>
    <fieldset className="webhook-form-fieldset"><legend>Eventos y filtros</legend>{filters.map(([id, label]) => <label key={id} className="webhook-enabled-control"><input type="checkbox" checked={Boolean(eventFilters[id])} onChange={(event) => setEventFilters((current) => ({ ...current, [id]: event.target.checked }))} /><span>{label}</span></label>)}</fieldset>
    <label><span>Autenticación</span><select value={authType} onChange={(event) => { setAuthType(event.target.value as WebhookAuthType); setSecret('') }}>{authOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    {needsName ? <label><span>{nameLabel}</span><input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder={authType === 'QUERY_PARAM' ? 'token' : 'x-api-key'} required /></label> : null}
    {authType === 'BASIC' ? <label><span>Usuario</span><input value={username} onChange={(event) => setUsername(event.target.value)} required /></label> : null}
    {needsSecret ? <label><span>{webhook && hasExistingSecret ? 'Nuevo secreto' : 'Secreto'}</span><input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={webhook && hasExistingSecret ? 'Configurado · dejá vacío para conservarlo' : 'Ingresá el valor'} required={!webhook || !hasExistingSecret} /><em>{webhook && hasExistingSecret ? 'El valor actual nunca se muestra.' : 'Se guarda de forma segura.'}</em></label> : null}
    <div className="client-form-actions"><button type="button" className="client-button-secondary" onClick={onCancel} disabled={isSubmitting}>Cancelar</button><button type="submit" className="client-button-primary" disabled={isSubmitting}>{isSubmitting ? 'Guardando…' : webhook ? 'Guardar cambios' : 'Crear webhook'}</button></div>
  </form>
}
