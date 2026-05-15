import type { GatewayConfig } from './config'
import type { Instance, InstanceState, QRResponse } from '../types'

const DEFAULT_TIMEOUT_MS = 10000
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const VALID_STATUS = new Set(['open', 'connecting', 'close'])

function normalizeStatus(raw: unknown): Instance['status'] {
  const value = String(raw ?? '').toLowerCase()
  return VALID_STATUS.has(value) ? (value as Instance['status']) : 'close'
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
  return {
    id: idValue,
    name,
    status: normalizeStatus(data.status),
    profileName: typeof data.profileName === 'string' ? data.profileName : undefined,
    phone: typeof data.phone === 'string' ? data.phone : undefined,
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : undefined,
    lastSeen: typeof data.lastSeen === 'string' ? data.lastSeen : undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  }
}

function assertInstanceName(name: string): void {
  if (!isSafeInstanceName(name)) {
    throw new ApiError(400, `Nombre de instancia invalido: "${name}"`)
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
        throw new ApiError(504, 'Timeout del gateway')
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

    create: async (cfg: GatewayConfig, instanceName: string) => {
      assertInstanceName(instanceName)
      const raw = await request<unknown>(cfg, 'POST', '/instances/', {
        instance_name: instanceName,
        qrcode: true,
        auto_configure_webhook: true,
      })
      const parsed = normalizeInstance(raw)
      if (!parsed) throw new ApiError(502, 'Respuesta invalida al crear instancia')
      return parsed
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
  },

  health: (cfg: GatewayConfig) =>
    request<{ status: string }>(cfg, 'GET', '/health', undefined, { retries: 0, timeoutMs: 5000 }),

  ready: (cfg: GatewayConfig) =>
    request<{ status: string; instances: number }>(cfg, 'GET', '/ready', undefined, { retries: 0, timeoutMs: 7000 }),

  webhooks: {
    events: <T = unknown>(cfg: GatewayConfig, instance?: string, limit = 250) =>
      request<{ items: T[] }>(
        cfg,
        'GET',
        `/webhooks/events?limit=${limit}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}`
      ),
  },

  messages: {
    sendText: (
      cfg: GatewayConfig,
      instanceName: string,
      body: { number: string; text: string }
    ) => {
      assertInstanceName(instanceName)
      return request(cfg, 'POST', `/instances/${instanceName}/messages/text`, body)
    },

    sendUploadedMedia: (
      cfg: GatewayConfig,
      instanceName: string,
      body: { number: string; file_id: string; mediatype: 'image' | 'video' | 'audio' | 'document'; caption?: string }
    ) => {
      assertInstanceName(instanceName)
      return request(cfg, 'POST', `/instances/${instanceName}/messages/media/uploaded`, body)
    },
  },
}
