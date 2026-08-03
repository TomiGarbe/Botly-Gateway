import { useState } from 'react'
import { Activity, BellRing, ChevronDown, FlaskConical, Inbox, LayoutDashboard, LayoutGrid, MessageSquare, Settings, ServerCog, Workflow, X } from 'lucide-react'
import Brand from './Brand'

type View = 'dashboard' | 'instances' | 'messages' | 'tests' | 'webhooks' | 'activity' | 'alerts' | 'automations' | 'operations'

interface Props {
  onOpenSettings: () => void
  view: View
  onChangeView: (view: View) => void
  mobileOpen: boolean
  onCloseMobile: () => void
}

// Principal = lo que se usa a diario. Avanzado = funciones operativas que no
// hacen falta para conectar y probar un numero; se esconden para no saturar.
const PRIMARY: { icon: typeof LayoutGrid; label: string; view: View }[] = [
  { icon: LayoutGrid, label: 'Conexiones', view: 'instances' },
  { icon: Activity, label: 'Actividad', view: 'activity' },
  { icon: MessageSquare, label: 'Mensajes', view: 'messages' },
  { icon: Inbox, label: 'Webhooks', view: 'webhooks' },
  { icon: LayoutDashboard, label: 'Dashboard', view: 'dashboard' },
]

const ADVANCED: { icon: typeof LayoutGrid; label: string; view: View }[] = [
  { icon: FlaskConical, label: 'Centro de Pruebas', view: 'tests' },
  { icon: BellRing, label: 'Alertas', view: 'alerts' },
  { icon: Workflow, label: 'Automatizaciones', view: 'automations' },
  { icon: ServerCog, label: 'Operaciones', view: 'operations' },
]

export default function Sidebar({ onOpenSettings, view, onChangeView, mobileOpen, onCloseMobile }: Props) {
  const advancedHasActive = ADVANCED.some(item => item.view === view)
  const [advancedOpen, setAdvancedOpen] = useState(advancedHasActive)

  const handleChangeView = (nextView: View) => {
    onChangeView(nextView)
    onCloseMobile()
  }

  const renderItem = ({ icon: Icon, label, view: itemView }: { icon: typeof LayoutGrid; label: string; view: View }) => (
    <button
      key={label}
      onClick={() => handleChangeView(itemView)}
      className={`
        w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm transition-colors
        ${view === itemView
          ? 'bg-zinc-800 text-zinc-50 font-medium'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'}
      `}
    >
      <Icon size={15} />
      <span className="flex-1 text-left">{label}</span>
    </button>
  )

  const navContent = (
    <>
      <div className="flex items-center justify-between gap-2 px-5 h-14 border-b border-zinc-800">
        <Brand />
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-md hover:bg-zinc-800"
          aria-label="Cerrar menu"
        >
          <X size={16} />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-2 mb-2 text-xs font-medium text-zinc-600 uppercase tracking-wider">Principal</p>
        {PRIMARY.map(renderItem)}

        <div className="pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen(open => !open)}
            className="w-full flex items-center gap-1.5 px-2 mb-1 text-xs font-medium text-zinc-600 hover:text-zinc-400 uppercase tracking-wider transition-colors"
          >
            <ChevronDown size={13} className={`transition-transform ${advancedOpen ? '' : '-rotate-90'}`} />
            <span className="flex-1 text-left">Avanzado</span>
          </button>
          {advancedOpen && <div className="space-y-0.5">{ADVANCED.map(renderItem)}</div>}
        </div>
      </nav>

      <div className="px-3 py-4 border-t border-zinc-800">
        <button
          onClick={() => {
            onCloseMobile()
            onOpenSettings()
          }}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
        >
          <Settings size={15} />
          Ajustes
        </button>
      </div>
    </>
  )

  return (
    <>
      <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:bg-zinc-900 lg:border-r lg:border-zinc-800 lg:h-screen lg:sticky lg:top-0">
        {navContent}
      </aside>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside className={`lg:hidden fixed inset-y-0 left-0 z-50 w-[min(85vw,20rem)] bg-zinc-900 border-r border-zinc-800 flex flex-col transition-transform duration-200 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {navContent}
      </aside>
    </>
  )
}
