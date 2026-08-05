import { Bell, LayoutDashboard, LogOut, Settings, Users } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'

const navigation = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/clients', label: 'Clientes', icon: Users },
  { to: '/alerts', label: 'Alertas', icon: Bell },
  { to: '/settings', label: 'Configuración', icon: Settings },
]

function titleFor(pathname: string): string {
  if (pathname.startsWith('/clients/')) return 'Cliente'
  if (pathname.startsWith('/clients')) return 'Clientes'
  if (pathname.startsWith('/connections/')) return 'Conexión'
  if (pathname.startsWith('/alerts')) return 'Alertas'
  if (pathname.startsWith('/settings')) return 'Configuración'
  return 'Dashboard'
}

export function AppShell() {
  const { pathname } = useLocation()
  const { user, signOut } = useAuth()

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Navegación principal">
        <div className="app-brand">Botly <span>Gateway</span></div>
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
          <h1>{titleFor(pathname)}</h1>
          <div className="app-profile">
            <div className="app-avatar" aria-hidden="true">{user?.name?.slice(0, 1) || 'B'}</div>
            <div className="app-profile-copy">
              <span>{user?.name || 'Cuenta Botly'}</span>
              <small>{user ? user.email : 'Google OAuth pendiente'}</small>
            </div>
            <button type="button" className="app-sign-out" onClick={() => void signOut()} disabled={!user} aria-label="Cerrar sesión">
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="app-main"><Outlet /></main>
      </div>
    </div>
  )
}
