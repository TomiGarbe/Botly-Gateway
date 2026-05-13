import type { GatewayConfig } from './config'
import type { Instance, InstanceState, QRResponse } from '../types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(cfg: GatewayConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-API-Key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? `HTTP ${res.status}`)
  return data as T
}

export const api = {
  instances: {
    list: (cfg: GatewayConfig) =>
      request<Instance[]>(cfg, 'GET', '/instances/'),

    create: (cfg: GatewayConfig, instanceName: string) =>
      request<{ instance: Instance }>(cfg, 'POST', '/instances/', {
        instance_name: instanceName,
        qrcode: true,
        auto_configure_webhook: true,
      }),

    state: (cfg: GatewayConfig, name: string) =>
      request<InstanceState>(cfg, 'GET', `/instances/${name}/state`),

    qr: (cfg: GatewayConfig, name: string) =>
      request<QRResponse>(cfg, 'GET', `/instances/${name}/qr`),

    logout: (cfg: GatewayConfig, name: string) =>
      request<unknown>(cfg, 'DELETE', `/instances/${name}/logout`),

    delete: (cfg: GatewayConfig, name: string) =>
      request<unknown>(cfg, 'DELETE', `/instances/${name}`),
  },

  health: (cfg: GatewayConfig) =>
    request<{ status: string }>(cfg, 'GET', '/health'),
}
