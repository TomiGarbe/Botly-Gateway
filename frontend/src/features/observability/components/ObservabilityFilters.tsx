export type ObservabilityDatePreset = '' | 'today' | '24h' | '7d' | '30d'

export function localDateTimeInput(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 16)
}

export function datePresetRange(preset: ObservabilityDatePreset, now = new Date()): { from: string; to: string } {
  const end = new Date(now)
  const start = new Date(now)
  if (preset === 'today') start.setHours(0, 0, 0, 0)
  if (preset === '24h') start.setTime(now.getTime() - 24 * 60 * 60 * 1000)
  if (preset === '7d') start.setDate(now.getDate() - 7)
  if (preset === '30d') start.setDate(now.getDate() - 30)
  return preset ? { from: localDateTimeInput(start), to: localDateTimeInput(end) } : { from: '', to: '' }
}

export function ObservabilityActiveFilters({ filters, onClear }: { filters: Array<{ label: string; value: string }>; onClear: () => void }) {
  if (!filters.length) return null
  return <div className="observability-active-filters"><span>Filtros:</span>{filters.map((filter) => <span key={filter.label} className="observability-filter-chip">{filter.label}: {filter.value}</span>)}<button type="button" className="client-button-ghost" onClick={onClear}>Limpiar filtros</button></div>
}
