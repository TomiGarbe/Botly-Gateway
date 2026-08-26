import { gatewayRequest } from '@/shared/lib/gatewayClient'

interface ApiUser {
  id: string
  name: string
  email: string
  avatar_url: string | null
  role: string
  business_id: string | null
}

export interface AuthUser {
  id: string
  name: string
  email: string
  avatarUrl?: string
  role: string
  businessId?: string
}

function toUser(payload: ApiUser): AuthUser {
  return { id: payload.id, name: payload.name, email: payload.email, avatarUrl: payload.avatar_url || undefined, role: payload.role || 'operator', businessId: payload.business_id || undefined }
}

export async function getCurrentUser(): Promise<AuthUser> {
  const payload = await gatewayRequest<{ user: ApiUser }>('/auth/session')
  return toUser(payload.user)
}

export async function getGoogleClientId(): Promise<string> {
  const payload = await gatewayRequest<{ google_client_id: string }>('/auth/config')
  return payload.google_client_id.trim()
}

export async function signInWithGoogleCredential(credential: string): Promise<AuthUser> {
  const payload = await gatewayRequest<{ user: ApiUser }>('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  return toUser(payload.user)
}

export async function signInWithPassword(email: string, password: string): Promise<AuthUser> {
  const payload = await gatewayRequest<{ user: ApiUser }>('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  return toUser(payload.user)
}

export async function signOutCurrentUser(): Promise<void> {
  await gatewayRequest<void>('/auth/logout', { method: 'POST' })
}
