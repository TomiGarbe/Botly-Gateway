import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect } from 'react'

interface ToastProps {
  message: string | null
  tone?: 'success' | 'error' | 'warning' | 'info'
  onDismiss: () => void
}

export function Toast({ message, tone = 'success', onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return undefined
    const timeout = window.setTimeout(onDismiss, 5000)
    return () => window.clearTimeout(timeout)
  }, [message, onDismiss])

  if (!message) return null
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? TriangleAlert : tone === 'info' ? Info : CheckCircle2
  return <div className={`toast toast-${tone}`} role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}>
    <Icon size={17} aria-hidden="true" /><span>{message}</span><button type="button" aria-label="Cerrar notificación" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div>
}
