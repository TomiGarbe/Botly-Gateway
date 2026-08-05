export interface Client {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
  connectionCount: number
  lastActivityAt: string | null
}

export interface ClientInput {
  name: string
  description?: string | null
}
