import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  isOpen: boolean
  isSubmitting?: boolean
  onCancel: () => void
  onConfirm: () => void
  tone?: 'danger' | 'default'
}

export function ConfirmDialog({ title, description, confirmLabel, isOpen, isSubmitting = false, onCancel, onConfirm, tone = 'danger' }: ConfirmDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return undefined
    cancelButton.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isOpen, isSubmitting, onCancel])

  if (!isOpen) return null

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => { if (!isSubmitting) onCancel() }}>
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" onMouseDown={(event) => event.stopPropagation()}>
      <div className={`confirm-dialog-icon confirm-dialog-icon-${tone}`}><AlertTriangle size={19} aria-hidden="true" /></div>
      <button type="button" className="confirm-dialog-close" aria-label="Cerrar confirmación" onClick={onCancel} disabled={isSubmitting}><X size={18} aria-hidden="true" /></button>
      <h2 id="confirm-dialog-title">{title}</h2>
      <p id="confirm-dialog-description">{description}</p>
      <div className="confirm-dialog-actions">
        <button ref={cancelButton} type="button" className="client-button-secondary" onClick={onCancel} disabled={isSubmitting}>Cancelar</button>
        <button type="button" className={tone === 'danger' ? 'client-button-danger' : 'client-button-primary'} onClick={onConfirm} disabled={isSubmitting}>{isSubmitting ? 'Procesando…' : confirmLabel}</button>
      </div>
    </section>
  </div>
}
