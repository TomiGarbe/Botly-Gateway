import { ArrowDown, ArrowUp } from 'lucide-react'
import { ObservabilityStatusBadge, formatObservabilityTimestamp, observabilityStatusLabel } from '@/features/observability/components/ObservabilityPresentation'
import type { ProviderDeliveryDirection, ProviderDeliveryStatus } from '../api/providerDeliveriesApi'

export const DeliveryStatus = ObservabilityStatusBadge
export const formatTimestamp = formatObservabilityTimestamp
export const statusLabel = observabilityStatusLabel

export function deliveryStateLabel(state: string | null): string {
  return ({ pending: 'Pendiente', accepted: 'Aceptado por provider', unknown: 'Desconocido', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', played: 'Reproducido', failed: 'Fallido' } as Record<string, string>)[state || ''] || 'No disponible'
}

export function reconciliationStateLabel(state: string | null): string {
  return ({ pending: 'Pendiente', not_required: 'No requerida' } as Record<string, string>)[state || ''] || 'No disponible'
}

export function formatProvider(provider: string | null, connectionProvider?: { id: string; displayName: string }): string {
  if (!provider) return 'Provider no disponible'
  return connectionProvider?.id === provider ? connectionProvider.displayName : provider
}

/** Kept as a domain-specific label while sharing the flow visual elsewhere. */
export function DeliveryDirection({ direction }: { direction: ProviderDeliveryDirection | null }) {
  const outbound = direction === 'outbound'
  return <span className="provider-delivery-direction">{outbound ? <ArrowDown size={15} aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />}{outbound ? 'Gateway → Provider' : direction === 'inbound' ? 'Provider → Gateway' : 'Dirección no disponible'}</span>
}

export type { ProviderDeliveryStatus }
