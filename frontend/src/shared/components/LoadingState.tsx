interface LoadingStateProps {
  label?: string
  lines?: number
}

export function LoadingState({ label = 'Cargando…', lines = 3 }: LoadingStateProps) {
  return <div className="loading-state" role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    {Array.from({ length: lines }, (_, index) => <span key={index} className={`loading-state-line loading-state-line-${index + 1}`} aria-hidden="true" />)}
  </div>
}
