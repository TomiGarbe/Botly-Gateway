import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  tone?: 'default' | 'success'
}

export function EmptyState({ icon: Icon, title, description, action, tone = 'default' }: EmptyStateProps) {
  return <div className={`empty-state empty-state-${tone}`}>
    <span className="empty-state-icon"><Icon size={20} aria-hidden="true" /></span>
    <div><strong>{title}</strong><p>{description}</p>{action ? <div className="empty-state-action">{action}</div> : null}</div>
  </div>
}
