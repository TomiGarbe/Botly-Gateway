import { Check, Clipboard } from 'lucide-react'
import { useMemo, useState } from 'react'

const sensitive = /token|secret|password|authorization|credential|api.?key|cookie|signature/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}

function printable(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(redact(JSON.parse(value)), null, 2) } catch { return value }
  }
  return JSON.stringify(redact(value), null, 2)
}

/** The single defensive renderer used for all observability payloads. */
export function SafeJsonViewer({ value, emptyLabel = 'Sin datos disponibles.' }: { value: unknown; emptyLabel?: string }) {
  const [copied, setCopied] = useState(false)
  const content = useMemo(() => printable(value), [value])
  if (!content || content === '{}') return <p className="webhook-json-empty">{emptyLabel}</p>
  async function copy() {
    await navigator.clipboard?.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return <div className="webhook-json-viewer"><button type="button" className="client-button-ghost" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Clipboard size={15} />} {copied ? 'Copiado' : 'Copiar JSON'}</button><pre>{content}</pre></div>
}
