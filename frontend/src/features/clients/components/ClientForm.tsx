import { FormEvent, useState } from 'react'
import type { ClientInput } from '@/domain/client'

interface ClientFormProps {
  initialValue?: ClientInput
  submitLabel: string
  onCancel: () => void
  onSubmit: (input: ClientInput) => Promise<void>
}

export function ClientForm({ initialValue, submitLabel, onCancel, onSubmit }: ClientFormProps) {
  const [name, setName] = useState(initialValue?.name || '')
  const [description, setDescription] = useState(initialValue?.description || '')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      await onSubmit({ name, description: description || null })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar el cliente.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="client-form" onSubmit={handleSubmit}>
      <label>
        <span>Nombre</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required autoFocus />
      </label>
      <label>
        <span>Descripción <em>Opcional</em></span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} />
      </label>
      {error ? <p className="client-form-error" role="alert">{error}</p> : null}
      <div className="client-form-actions">
        <button type="button" className="client-button-secondary" onClick={onCancel} disabled={isSubmitting}>Cancelar</button>
        <button type="submit" className="client-button-primary" disabled={isSubmitting}>{isSubmitting ? 'Guardando…' : submitLabel}</button>
      </div>
    </form>
  )
}
