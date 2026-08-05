import { environment } from '@/app/config/environment'

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'GatewayRequestError'
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== 'object' || payload === null || !('detail' in payload)) return fallback
  const { detail } = payload as { detail: unknown }
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((item) => {
    if (typeof item === 'object' && item !== null && 'msg' in item && typeof item.msg === 'string') return item.msg
    return 'Solicitud inválida'
  }).join('. ')
  return fallback
}

/**
 * Punto único para futuras integraciones con el Gateway.
 * La UI no conoce URLs, claves ni detalles del proveedor.
 */
export async function gatewayRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const baseUrl = environment.gatewayUrl || window.location.origin
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new GatewayRequestError(
      errorMessage(payload, `Gateway request failed with status ${response.status}`),
      response.status,
    )
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
