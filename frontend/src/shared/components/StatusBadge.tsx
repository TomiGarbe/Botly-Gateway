import type { ReactNode } from 'react'

export type StatusTone = 'healthy' | 'attention' | 'critical' | 'configuring' | 'pending' | 'resolved' | 'new' | 'acknowledged' | 'neutral'

interface StatusBadgeProps {
  children: ReactNode
  tone: StatusTone
}

export function StatusBadge({ children, tone }: StatusBadgeProps) {
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>
}
