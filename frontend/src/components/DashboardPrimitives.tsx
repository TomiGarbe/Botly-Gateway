import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function DashboardCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5 ${className}`}>{children}</section>
}

const stateTone = {
  healthy: 'border-emerald-900/70 bg-emerald-950/25 text-emerald-300',
  attention: 'border-amber-900/70 bg-amber-950/25 text-amber-300',
  error: 'border-red-900/70 bg-red-950/25 text-red-300',
  unknown: 'border-zinc-700 bg-zinc-950/50 text-zinc-400',
}

export type OperationalTone = keyof typeof stateTone

export function StatusCard({ label, value, tone, icon: Icon, onClick }: { label: string; value: number; tone: OperationalTone; icon: LucideIcon; onClick?: () => void }) {
  const content = <><div className={`inline-flex rounded-lg border p-2 ${stateTone[tone]}`}><Icon size={16} /></div><p className="mt-4 text-2xl font-semibold text-zinc-100">{value}</p><p className="mt-1 text-xs text-zinc-500">{label}</p></>
  return onClick ? <button onClick={onClick} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left transition-colors hover:border-zinc-700">{content}</button> : <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">{content}</div>
}

export function KpiCard({ label, value, hint, icon: Icon }: { label: string; value: string | number; hint?: string; icon: LucideIcon }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><div className="flex items-start justify-between gap-2"><p className="text-[11px] text-zinc-500">{label}</p><Icon size={14} className="text-zinc-600" /></div><p className="mt-2 text-lg font-semibold text-zinc-100">{value}</p>{hint ? <p className="mt-1 text-[11px] text-zinc-600">{hint}</p> : null}</div>
}

export function HealthCard({ name, status, incidents, latest, tone, icon: Icon }: { name: string; status: string; incidents: number | null; latest: string; tone: OperationalTone; icon: LucideIcon }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><div className={`rounded-md border p-1.5 ${stateTone[tone]}`}><Icon size={14} /></div><p className="text-sm font-medium text-zinc-200">{name}</p></div><span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${stateTone[tone]}`}>{status}</span></div><div className="mt-3 flex items-end justify-between gap-2"><p className="text-xs text-zinc-500">Incidencias: <span className="text-zinc-300">{incidents === null ? 'No disponible' : incidents}</span></p><p className="max-w-36 truncate text-right text-[11px] text-zinc-600" title={latest}>Último: {latest}</p></div></div>
}

export function QuickAction({ label, description, icon: Icon, primary = false, onClick }: { label: string; description: string; icon: LucideIcon; primary?: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`flex min-h-24 flex-col items-start rounded-lg border p-3 text-left transition-colors ${primary ? 'border-blue-700 bg-blue-950/30 hover:bg-blue-950/50' : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700'}`}><Icon size={16} className={primary ? 'text-blue-300' : 'text-zinc-500'} /><p className="mt-3 text-sm font-medium text-zinc-100">{label}</p><p className="mt-1 text-xs text-zinc-500">{description}</p></button>
}

export function PendingWorkCard({ title, detail, tone, onClick }: { title: string; detail: string; tone: OperationalTone; onClick?: () => void }) {
  const content = <><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === 'error' ? 'bg-red-400' : tone === 'attention' ? 'bg-amber-400' : 'bg-zinc-500'}`} /><div className="min-w-0"><p className="text-sm font-medium text-zinc-200">{title}</p><p className="mt-1 text-xs text-zinc-500">{detail}</p></div></>
  return onClick ? <button onClick={onClick} className="flex w-full gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-left hover:border-zinc-700">{content}</button> : <div className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">{content}</div>
}
