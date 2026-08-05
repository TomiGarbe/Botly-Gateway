import { Bell, ChevronRight, LayoutDashboard, LogOut, Settings, Users } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'

const navigation = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/clients', label: 'Clientes', icon: Users },
  { to: '/alerts', label: 'Alertas', icon: Bell },
  { to: '/settings', label: 'Configuración', icon: Settings },
]

function breadcrumbsFor(pathname: string): string[] {
  if (pathname.startsWith('/connections/')) return ['Clientes', 'Conexión']
  if (pathname.includes('/connections/new')) return ['Clientes', 'Nueva conexión']
  if (pathname.startsWith('/clients/')) return ['Clientes', 'Cliente']
  if (pathname.startsWith('/clients')) return ['Clientes']
  if (pathname.startsWith('/alerts')) return ['Alertas']
  if (pathname.startsWith('/settings')) return ['Configuración']
  return ['Dashboard']
}

export function AppShell() {
  const { pathname } = useLocation()
  const { user, signOut } = useAuth()
  const breadcrumbs = breadcrumbsFor(pathname)

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Navegación principal">
        <nav className="app-navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `app-nav-link${isActive ? ' is-active' : ''}`}>
              <Icon size={17} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="app-content">
        <header className="app-header">
          <div className="app-header-context">
            <div className="app-product">
              <img src="/logo-gateway-mark.svg" alt="Botly Gateway" />
              <span>Botly <strong>Gateway</strong></span>
            </div>
            <nav className="app-breadcrumb" aria-label="Ubicación actual">
              {breadcrumbs.map((item, index) => <span key={`${item}-${index}`}>{index > 0 ? <ChevronRight size={14} aria-hidden="true" /> : null}{item}</span>)}
            </nav>
          </div>
          <details className="app-user-menu">
            <summary className="app-profile">
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
