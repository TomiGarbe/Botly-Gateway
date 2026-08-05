import { gatewayRequest } from '@/shared/lib/gatewayClient'

interface ApiUser {
  id: string
  name: string
  email: string
  avatar_url: string | null
}

export interface AuthUser {
  id: string
  name: string
  email: string
  avatarUrl?: string
}

function toUser(payload: ApiUser): AuthUser {
  return { id: payload.id, name: payload.name, email: payload.email, avatarUrl: payload.avatar_url || undefined }
}

export async function getCurrentUser(): Promise<AuthUser> {
  const payload = await gatewayRequest<{ user: ApiUser }>('/auth/session')
  return toUser(payload.user)
}

export async function signInWithGoogleCredential(credential: string): Promise<AuthUser> {
  const payload = await gatewayRequest<{ user: ApiUser }>('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  return toUser(payload.user)
}

export async function signOutCurrentUser(): Promise<void> {
  await gatewayRequest<void>('/auth/logout', { method: 'POST' })
}
