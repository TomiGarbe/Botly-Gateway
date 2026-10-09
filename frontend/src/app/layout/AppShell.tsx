import { BarChart3, Bell, ChevronRight, Link2, LayoutDashboard, LogOut, Settings, Users } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'

const navigation = [
  { to: '/dashboard', label: 'Dashboard', shortLabel: 'Inicio', icon: LayoutDashboard },
  { to: '/analytics', label: 'Analytics', shortLabel: 'Métricas', icon: BarChart3 },
  { to: '/clients', label: 'Clientes', shortLabel: 'Clientes', icon: Users },
  { to: '/connections', label: 'Conexiones', shortLabel: 'Conexiones', icon: Link2 },
  { to: '/alerts', label: 'Alertas', shortLabel: 'Alertas', icon: Bell },
  { to: '/settings', label: 'Configuración', shortLabel: 'Ajustes', icon: Settings },
]

function breadcrumbsFor(pathname: string): string[] {
  if (pathname.includes('/connections/new') || /\/connections\/[^/]+\/new$/.test(pathname)) return ['Conexiones', 'Nueva conexión']
  if (pathname.includes('/message-logs')) return ['Conexiones', 'Registro de mensajes']
  if (pathname.startsWith('/connections/')) return ['Conexiones', 'Conexión']
  if (pathname.startsWith('/connections')) return ['Conexiones']
  if (pathname.startsWith('/webhooks/')) return ['Webhooks', pathname.includes('/deliveries/') ? 'Entrega' : pathname.endsWith('/deliveries') ? 'Entregas' : 'Webhook']
  if (pathname.startsWith('/webhooks')) return ['Webhooks']
  if (pathname.startsWith('/clients/')) return ['Clientes', 'Cliente']
  if (pathname.startsWith('/clients')) return ['Clientes']
  if (pathname.startsWith('/alerts')) return ['Alertas']
  if (pathname.startsWith('/analytics')) return ['Analytics']
  if (pathname.startsWith('/settings')) return ['Configuración']
  return ['Dashboard']
}

export function AppShell() {
  const { pathname } = useLocation()
  const { user, signOut } = useAuth()
  const breadcrumbs = breadcrumbsFor(pathname)
  const isReviewer = user?.role === 'meta_reviewer'
  const userMenu = useRef<HTMLDetailsElement>(null)

  // <details> no se cierra solo: lo cerramos al navegar o al tocar fuera.
  useEffect(() => { userMenu.current?.removeAttribute('open') }, [pathname])
  useEffect(() => {
    const close = (event: PointerEvent) => { if (userMenu.current && !userMenu.current.contains(event.target as Node)) userMenu.current.removeAttribute('open') }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Navegación principal">
        <div className="app-product">
          <img src="/logo-gateway-mark.svg" alt="Botly Gateway" />
          <span>Botly <strong>Gateway</strong></span>
        </div>
        <nav className="app-navigation">
        {navigation.filter((item) => !isReviewer || item.to === '/clients' || item.to === '/connections' || item.to === '/analytics').map(({ to, label, shortLabel, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `app-nav-link${isActive ? ' is-active' : ''}`}>
              <Icon size={17} aria-hidden="true" />
              <span className="app-nav-label">{label}</span>
              <span className="app-nav-short-label" aria-hidden="true">{shortLabel}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="app-content">
        <header className="app-header">
          <div className="app-header-context">
            <div className="app-product app-header-product">
              <img src="/logo-gateway-mark.svg" alt="" />
              <span>{breadcrumbs[0]}</span>
            </div>
            <nav className="app-breadcrumb" aria-label="Ubicación actual">
              {breadcrumbs.map((item, index) => <span key={`${item}-${index}`}>{index > 0 ? <ChevronRight size={14} aria-hidden="true" /> : null}{item}</span>)}
            </nav>
          </div>
          <details ref={userMenu} className="app-user-menu">
            <summary className="app-profile" aria-label="Menú de usuario">
              <div className="app-avatar" aria-hidden="true">{user?.name?.slice(0, 1) || 'B'}</div>
              <div className="app-profile-copy">
                <span>{user?.name || 'Cuenta Botly'}</span>
                <small>{user ? user.email : 'Google OAuth pendiente'}</small>
              </div>
            </summary>
            <div className="app-user-popover">
              <span>{user?.email || 'Sesión no disponible'}</span>
              <button type="button" onClick={() => void signOut()} disabled={!user}><LogOut size={15} aria-hidden="true" /> Cerrar sesión</button>
            </div>
          </details>
        </header>
        <main className="app-main"><Outlet /></main>
      </div>
    </div>
  )
}
