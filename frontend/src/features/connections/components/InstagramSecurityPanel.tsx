import { ShieldCheck } from 'lucide-react'
import type { Connection } from '@/domain/connection'

export function InstagramSecurityPanel({ connection }: { connection: Connection }) {
  const readiness = connection.readiness
  return <section className="connection-section workspace-security"><div className="connection-section-heading"><div><h3><ShieldCheck size={18} /> Seguridad de Instagram</h3><p>Tokens y secretos permanecen cifrados en Gateway; no se exponen al navegador.</p></div></div><dl className="connection-information-list"><div><dt>Cuenta profesional</dt><dd>{connection.providerAccount ? 'Configurada' : 'No configurada'}</dd></div><div><dt>Credencial OAuth</dt><dd>{readiness?.credentialValid ? 'Activa' : 'No disponible o requiere reconexión'}</dd></div><div><dt>Scopes requeridos</dt><dd>{readiness?.requiredScopesPresent ? 'Presentes' : 'Pendientes'}</dd></div><div><dt>Webhook Meta</dt><dd>Firmado y validado por Gateway</dd></div></dl></section>
}
