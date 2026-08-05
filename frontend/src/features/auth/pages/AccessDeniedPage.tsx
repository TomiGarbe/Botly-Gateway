import { ShieldX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'

export function AccessDeniedPage() {
  const { clearAccessDenied } = useAuth()
  return <main className="auth-page"><section className="auth-denied" aria-label="Acceso denegado"><ShieldX size={28} aria-hidden="true" /><h1>Acceso denegado</h1><p>Tu cuenta no tiene acceso a Botly Gateway.</p><Link to="/login" onClick={clearAccessDenied}>Volver</Link></section></main>
}
