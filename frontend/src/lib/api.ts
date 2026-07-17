import type { GatewayConfig } from './config'
import type { CoexistenceState, ConnectionDiagnosticsResponse, CreateConnectionPayload, Instance, InstanceApiKey, InstanceCreationResult, InstanceState, MetaSignupConfig, QRResponse, InstanceWebhook, WebhookAuthType, WebhookDeliveryMetrics, WebhookDispatchLog } from '../types'

const DEFAULT_TIMEOUT_MS = 10000
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const VALID_STATUS = new Set(['open', 'connecting', 'close'])
const VALID_LIFECYCLE = new Set(['provisioning', 'configured', 'connected', 'warning', 'disconnected', 'token_expired', 'webhook_invalid', 'needs_attention', 'failed'])
const VALID_HEALTH = new Set(['healthy', 'degraded', 'unhealthy', 'unknown'])
const VALID_COEXISTENCE = new Set(['not_available', 'available', 'enabled', 'pending', 'failed', 'unknown'])
const VALID_CHECK = new Set(['passed', 'warning', 'failed', 'unknown'])
const VALID_DIAGNOSTIC = new Set(['error', 'warning', 'recommendation', 'info'])

function normalizeStatus(raw: unknown): Instance['status'] {
  const value = String(raw ?? '').toLowerCase()
  return VALID_STATUS.has(value) ? (value as Instance['status']) : 'close'
}

function normalizeConnectionType(rawType: unknown, rawIntegration: unknown): Instance['connectionType'] {
  const type = typeof rawType === 'string' ? rawType.toLowerCase() : ''
  if (type === 'cloud' || type === 'baileys') return type
  const integration = typeof rawIntegration === 'string' ? rawIntegration.toUpperCase() : ''
  return integration === 'WHATSAPP-BUSINESS' ? 'cloud' : 'baileys'
}

function normalizeLifecycle(raw: unknown): Instance['lifecycleState'] {
  const value = String(raw ?? '').toLowerCase()
  return VALID_LIFECYCLE.has(value) ? (value as Instance['lifecycleState']) : undefined
}

function normalizeHealth(raw: unknown): Instance['health'] {
  const value = String(raw ?? '').toLowerCase()
  return VALID_HEALTH.has(value) ? (value as Instance['health']) : undefined
}

function normalizeHealthChecks(raw: unknown): Instance['healthChecks'] {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => {
      const status = String(item.status ?? '').toLowerCase()
      return {
        code: String(item.code ?? ''),
        label: String(item.label ?? item.code ?? ''),
        status: VALID_CHECK.has(status) ? (status as 'passed' | 'warning' | 'failed' | 'unknown') : 'unknown',
        required: item.required !== false,
        details: typeof item.details === 'string' ? item.details : undefined,
      }
    })
    .filter(item => item.code && item.label)
}

function normalizeDiagnostics(raw: unknown): Instance['diagnostics'] {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => {
      const severity = String(item.severity ?? '').toLowerCase()
      return {
        code: String(item.code ?? ''),
        severity: VALID_DIAGNOSTIC.has(severity) ? (severity as 'error' | 'warning' | 'recommendation' | 'info') : 'info',
        message: String(item.message ?? ''),
        recommendation: typeof item.recommendation === 'string' ? item.recommendation : undefined,
      }
    })
    .filter(item => item.code && item.message)
}

function normalizeCoexistence(raw: unknown): Instance['coexistence'] {
  if (!raw || typeof raw !== 'object') return undefined
  const data = raw as Record<string, unknown>
  const state = String(data.state ?? '').toLowerCase()
  return {
    state: VALID_COEXISTENCE.has(state) ? (state as CoexistenceState) : 'unknown',
    whatsappBusinessAppAvailable: data.whatsappBusinessAppAvailable === true,
    cloudApiActive: data.cloudApiActive === true,
    featureType: typeof data.featureType === 'string' ? data.featureType : undefined,
    expectedWebhookEvents: Array.isArray(data.expectedWebhookEvents) ? data.expectedWebhookEvents.map(String) : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  }
}

function isSafeInstanceName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value)
}

function normalizeInstance(raw: unknown): Instance | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const name = data.name
  if (!isSafeInstanceName(name)) {
    console.warn('Dropping invalid instance payload from backend', raw)
    return null
  }

  const idValue = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : name
  const integration = typeof data.integration === 'string' ? data.integration : undefined
  return {
    id: idValue,
    name,
    status: normalizeStatus(data.status),
    connectionType: normalizeConnectionType(data.connectionType, integration),
    integration,
    lifecycleState: normalizeLifecycle(data.lifecycleState),
    health: normalizeHealth(data.health),
    coexistence: normalizeCoexistence(data.coexistence),
    healthChecks: normalizeHealthChecks(data.healthChecks),
    diagnostics: normalizeDiagnostics(data.diagnostics),
    profileName: typeof data.profileName === 'string' ? data.profileName : undefined,
    phone: typeof data.phone === 'string' ? data.phone : undefined,
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : undefined,
    lastSeen: typeof data.lastSeen === 'string' ? data.lastSeen : undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  }
}

function assertInstanceName(name: string): void {
  if (!isSafeInstanceName(name)) {
    throw new ApiError(400, `Nombre de conexion invalido: "${name}"`)
  }
}

async function request<T>(
  cfg: GatewayConfig,
  method: string,
  path: string,
  body?: unknown,
  options?: { retries?: number; timeoutMs?: number }
): Promise<T> {
  const retries = options?.retries ?? (method === 'GET' ? 1 : 0)
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'X-API-Key': cfg.apiKey,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new ApiError(res.status, data?.detail ?? `HTTP ${res.status}`)
        if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
          await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)))
          continue
        }
        throw err
      }

      return data as T
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError'
      if (attempt < retries && (isAbort || !(error instanceof ApiError))) {
        await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)))
        continue
      }

      if (isAbort) {
        throw new ApiError(504, 'El Provider no respondio a tiempo')
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

  throw new ApiError(500, 'Request failed')
}

export const api = {
  instances: {
    list: async (cfg: GatewayConfig) => {
      const raw = await request<unknown[]>(cfg, 'GET', '/instances/')
      return (Array.isArray(raw) ? raw : [])
        .map(normalizeInstance)
        .filter((item): item is Instance => item !== null)
    },

    create: async (cfg: GatewayConfig, payload: CreateConnectionPayload) => {
      assertInstanceName(payload.instanceName)
      if (payload.connectionType === 'cloud_embedded') {
        throw new ApiError(400, 'La conexion guiada debe completarse desde el asistente oficial')
      }
      const body = payload.connectionType === 'cloud'
        ? {
            instance_name: payload.instanceName,
            connection_type: 'cloud',
            qrcode: false,
            token: payload.accessToken,
            phone_number_id: payload.phoneNumberId,
            business_id: payload.businessId,
            auto_configure_webhook: true,
          }
        : {
            instance_name: payload.instanceName,
            connection_type: 'baileys',
            qrcode: true,
            auto_configure_webhook: true,
          }
      const raw = await request<unknown>(cfg, 'POST', '/instances/', {
        ...body,
      })
      if (raw && typeof raw === 'object' && 'instance' in raw) {
        const payload = raw as { instance?: unknown; apiKey?: unknown }
        const parsed = normalizeInstance(payload.instance)
        if (!parsed) throw new ApiError(502, 'Respuesta invalida al crear instancia')
        return {
          instance: parsed,
          apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : null,
        } satisfies InstanceCreationResult
      }

      const parsed = normalizeInstance(raw)
      if (!parsed) throw new ApiError(502, 'Respuesta invalida al crear conexion')
      return { instance: parsed, apiKey: null } satisfies InstanceCreationResult
    },

    state: async (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      const raw = await request<InstanceState>(cfg, 'GET', `/instances/${name}/state`)
      return { ...raw, status: normalizeStatus(raw.status) }
    },

    qr: (cfg: GatewayConfig, name: string, refresh = false) => {
      assertInstanceName(name)
      return request<QRResponse>(cfg, 'GET', `/instances/${name}/qr${refresh ? '?refresh=1' : ''}`)
    },

    reconnect: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<unknown>(cfg, 'POST', `/instances/${name}/reconnect`)
    },

    logout: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<unknown>(cfg, 'DELETE', `/instances/${name}/logout`)
    },

    delete: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<unknown>(cfg, 'DELETE', `/instances/${name}`)
    },
    getApiKey: (cfg: GatewayConfig, name: string, reveal = false) => {
      assertInstanceName(name)
      return request<InstanceApiKey>(cfg, 'GET', `/instances/${name}/api-key${reveal ? '?reveal=1' : ''}`)
    },
    regenerateApiKey: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<InstanceApiKey>(cfg, 'POST', `/instances/${name}/api-key/regenerate`)
    },
    revokeApiKey: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<InstanceApiKey>(cfg, 'DELETE', `/instances/${name}/api-key`)
    },
    enableApiKey: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<InstanceApiKey>(cfg, 'POST', `/instances/${name}/api-key/enable`)
    },
    diagnostics: (cfg: GatewayConfig, name: string) => {
      assertInstanceName(name)
      return request<ConnectionDiagnosticsResponse>(cfg, 'GET', `/instances/${name}/diagnostics`)
    },
  },

  health: (cfg: GatewayConfig) =>
    request<{ status: string }>(cfg, 'GET', '/health', undefined, { retries: 0, timeoutMs: 5000 }),

  ready: (cfg: GatewayConfig) =>
    request<{ status: string; instances: number }>(cfg, 'GET', '/ready', undefined, { retries: 0, timeoutMs: 7000 }),

  metaSignup: {
    config: (cfg: GatewayConfig) =>
      request<MetaSignupConfig>(cfg, 'GET', '/meta/signup/config', undefined, { retries: 0, timeoutMs: 5000 }),
    complete: async (
      cfg: GatewayConfig,
      payload: Extract<CreateConnectionPayload, { connectionType: 'cloud_embedded' }>
    ) => {
      assertInstanceName(payload.instanceName)
      const raw = await request<unknown>(cfg, 'POST', '/meta/signup/complete', {
        instance_name: payload.instanceName,
        code: payload.code,
        phone_number_id: payload.phoneNumberId,
        business_account_id: payload.businessAccountId,
        session_info: {
          ...payload.sessionInfo,
          coexistenceRequested: payload.coexistenceRequested === true,
        },
      }, { retries: 0, timeoutMs: 30000 })
      const parsed = normalizeInstance(raw)
      if (!parsed) throw new ApiError(502, 'Respuesta invalida al completar la conexion oficial')
      return parsed
    },
  },

  webhooks: {
    events: <T = unknown>(cfg: GatewayConfig, instance?: string, limit = 250) =>
      request<{ items: T[] }>(
        cfg,
        'GET',
        `/webhooks/events?limit=${limit}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}`
      ),
    listByInstance: (cfg: GatewayConfig, instanceName: string) => {
      assertInstanceName(instanceName)
      return request<{ items: InstanceWebhook[] }>(cfg, 'GET', `/instances/${instanceName}/webhooks`)
    },
    create: (
      cfg: GatewayConfig,
      instanceName: string,
      body: { name?: string; url: string; enabled: boolean; authType: WebhookAuthType; authConfig: Record<string, string>; customHeaders: Record<string, string> }
    ) => {
      assertInstanceName(instanceName)
      return request<InstanceWebhook>(cfg, 'POST', `/instances/${instanceName}/webhooks`, body)
    },
    update: (
      cfg: GatewayConfig,
      instanceName: string,
      webhookId: string,
      body: { name?: string; url: string; enabled: boolean; authType: WebhookAuthType; authConfig: Record<string, string>; customHeaders: Record<string, string> }
    ) => {
      assertInstanceName(instanceName)
      return request<InstanceWebhook>(cfg, 'PUT', `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}`, body)
    },
    toggleEnabled: (cfg: GatewayConfig, instanceName: string, webhookId: string, enabled: boolean) => {
      assertInstanceName(instanceName)
      return request<InstanceWebhook>(cfg, 'PATCH', `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}/enabled`, { enabled })
    },
    remove: (cfg: GatewayConfig, instanceName: string, webhookId: string) => {
      assertInstanceName(instanceName)
      return request<{ ok: boolean }>(cfg, 'DELETE', `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}`)
    },
    test: (cfg: GatewayConfig, instanceName: string, webhookId: string) => {
      assertInstanceName(instanceName)
      return request<{ ok: boolean; status: number; error?: string }>(cfg, 'POST', `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}/test`)
    },
    dispatches: (cfg: GatewayConfig, instanceName: string, webhookId: string, limit = 20) => {
      assertInstanceName(instanceName)
      return request<{ items: WebhookDispatchLog[] }>(
        cfg,
        'GET',
        `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}/dispatches?limit=${Math.max(1, Math.min(limit, 100))}`
      )
    },
    deliveries: (cfg: GatewayConfig, instanceName: string, limit = 50, outcome: 'all' | 'success' | 'failed' = 'all') => {
      assertInstanceName(instanceName)
      return request<{ items: WebhookDispatchLog[]; metrics: WebhookDeliveryMetrics }>(
        cfg,
        'GET',
        `/instances/${instanceName}/webhooks/deliveries?limit=${Math.max(1, Math.min(limit, 200))}&outcome=${encodeURIComponent(outcome)}`
      )
    },
    diagnose: (cfg: GatewayConfig, instanceName: string, webhookId: string) => {
      assertInstanceName(instanceName)
      return request<Record<string, unknown>>(cfg, 'POST', `/instances/${instanceName}/webhooks/${encodeURIComponent(webhookId)}/diagnose`)
    },
  },

  messages: {
    send: (
      cfg: GatewayConfig,
      instanceName: string,
      body: { number: string; type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'file' | 'pdf'; text?: string; caption?: string; mediaUrl?: string; base64?: string; metadata?: Record<string, unknown> }
    ) => {
      assertInstanceName(instanceName)
      return request(cfg, 'POST', `/messages/${instanceName}`, body)
    },

    sendMultipart: (
      cfg: GatewayConfig,
      instanceName: string,
      body: { number: string; type: 'image' | 'video' | 'audio' | 'document' | 'pdf' | 'file'; caption?: string; text?: string },
      file: File,
      options?: { onProgress?: (percent: number) => void; signal?: AbortSignal }
    ) => {
      assertInstanceName(instanceName)
      return new Promise<unknown>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const form = new FormData()
        form.append('number', body.number)
        form.append('type', body.type)
        if (body.caption) form.append('caption', body.caption)
        if (body.text) form.append('text', body.text)
        form.append('file', file)

        xhr.open('POST', `${cfg.url.replace(/\/$/, '')}/messages/${instanceName}`)
        xhr.setRequestHeader('X-API-Key', cfg.apiKey)

        xhr.upload.onprogress = event => {
          if (!event.lengthComputable || !options?.onProgress) return
          const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
          options.onProgress(percent)
        }

        xhr.onload = () => {
          let payload: unknown = null
          try {
            payload = JSON.parse(xhr.responseText || '{}')
          } catch {
            payload = {}
          }

          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(payload)
            return
          }

          const data = (payload && typeof payload === 'object' ? payload : {}) as { detail?: string }
          reject(new ApiError(xhr.status || 500, data.detail ?? `HTTP ${xhr.status || 500}`))
        }

        xhr.onerror = () => reject(new ApiError(502, 'Error enviando archivo'))
        xhr.onabort = () => reject(new ApiError(499, 'Carga cancelada'))

        if (options?.signal) {
          const onAbort = () => xhr.abort()
          if (options.signal.aborted) {
            onAbort()
            return
          }
          options.signal.addEventListener('abort', onAbort, { once: true })
        }

        xhr.send(form)
      })
    },
  },
}
