export type ConnectionStatus = 'open' | 'connecting' | 'close'
export type ConnectionType = 'baileys' | 'cloud'
export type ChannelId = 'whatsapp' | 'instagram' | 'messenger' | 'telegram' | 'discord'
export type MethodId = 'official' | 'web' | 'bot_api' | 'bot'
export type DiscoveryType = 'embedded_signup' | 'qr' | 'manual' | 'none'
export type AuthenticationType = 'embedded_signup' | 'qr' | 'bot_token' | 'oauth' | 'none'
export type LifecycleState =
  | 'provisioning'
  | 'configured'
  | 'connected'
  | 'warning'
  | 'disconnected'
  | 'token_expired'
  | 'webhook_invalid'
  | 'needs_attention'
  | 'failed'
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type DiagnosticSeverity = 'error' | 'warning' | 'recommendation' | 'info'
export type CoexistenceState = 'not_available' | 'available' | 'enabled' | 'pending' | 'failed' | 'unknown'

export type CreateConnectionPayload =
  | {
      connectionType: 'baileys'
      instanceName: string
    }
  | {
      connectionType: 'cloud_embedded'
      instanceName: string
      code: string
      phoneNumberId: string
      businessAccountId: string
      sessionInfo: Record<string, unknown>
      coexistenceRequested?: boolean
    }
  | {
      connectionType: 'cloud'
      instanceName: string
      accessToken: string
      phoneNumberId: string
      businessId: string
    }

export interface MetaSignupConfig {
  enabled: boolean
  app_id?: string | null
  config_id?: string | null
  graph_version: string
  supports_coexistence: boolean
  coexistence_feature_type: string
  missing: string[]
}

export interface ChannelMethod {
  id: MethodId
  name: string
  displayName: string
  description: string
  icon: string
  logo?: string | null
  color?: string | null
  platformId?: string | null
  authentication: AuthenticationType
  discovery: DiscoveryType
  capabilities: string[]
  supportsDiscovery: boolean
  supportsOauth: boolean
  supportsRefresh: boolean
  visible: boolean
  enabled: boolean
  sortOrder: number
  currentConnectionType?: ConnectionType | null
}

export interface ChannelCatalogItem {
  id: ChannelId
  name: string
  displayName: string
  description: string
  icon: string
  logo?: string | null
  color?: string | null
  supportsMultiChannel: boolean
  supportsDiscovery: boolean
  visible: boolean
  enabled: boolean
  sortOrder: number
  capabilities: string[]
  methods: ChannelMethod[]
}

export interface Instance {
  id: string
  name: string
  status: ConnectionStatus
  connectionType?: ConnectionType
  integration?: string
  channelId?: ChannelId
  methodId?: MethodId
  channelDisplayName?: string
  methodDisplayName?: string
  methodIcon?: string
  lifecycleState?: LifecycleState
  health?: HealthStatus
  coexistence?: CoexistenceInfo
  healthChecks?: HealthCheck[]
  diagnostics?: ConnectionDiagnostic[]
  profileName?: string
  phone?: string
  avatarUrl?: string
  lastSeen?: string
  createdAt?: string
}

export interface InstanceCreationResult {
  instance: Instance
  apiKey?: string | null
}

export interface CoexistenceInfo {
  state: CoexistenceState
  whatsappBusinessAppAvailable: boolean
  cloudApiActive: boolean
  featureType?: string
  expectedWebhookEvents?: string[]
  reason?: string
}

export interface HealthCheck {
  code: string
  label: string
  status: 'passed' | 'warning' | 'failed' | 'unknown'
  required: boolean
  details?: string
}

export interface ConnectionDiagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  recommendation?: string
  action?: string
}

export interface ConnectionDiagnosticsResponse {
  id: string
  name: string
  connectionType?: ConnectionType
  integration?: string
  status: ConnectionStatus
  lifecycleState?: LifecycleState
  health?: HealthStatus
  healthChecks?: HealthCheck[]
  diagnostics?: ConnectionDiagnostic[]
  supportDiagnostics?: ConnectionDiagnostic[]
}

export interface InstanceApiKey {
  instanceId: string
  createdAt?: string | null
  lastUsedAt?: string | null
  enabled: boolean
  hasApiKey: boolean
  maskedApiKey?: string | null
  apiKey?: string | null
}

export interface InstanceState {
  id: string
  name: string
  status: ConnectionStatus
  stale?: boolean
}

export interface QRResponse {
  base64?: string
  code?: string
  count?: number
  fetchedAt?: number
  nextRecommendedRefreshAt?: number
  qrcode?: {
    base64?: string
    code?: string
    count?: number
  } | null
  instance?: Instance
}

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  message: string
  type: ToastType
}

export interface PipelineEvent {
  id?: string
  layer?: 'business' | 'operational' | 'technical'
  event: string
  instance: string
  timestamp: number
  direction?: 'inbound' | 'outbound' | 'system'
  type?: 'message' | 'delivery' | 'error'
  messageType?: string
  sender?: string
  recipient?: string
  text?: string
  content?: unknown
  status?: string
  fromMe?: boolean
  fromBot?: boolean
  forwarding?: {
    status?: string
    attempt?: number
  } | null
  error?: {
    type?: string
    message?: string
  } | null
  message?: {
    id?: string
    from?: string
    fromMe?: boolean
    kind?: string
    text?: string
  }
  interaction?: {
    interactionType?: 'button' | 'list' | 'template' | 'flow' | 'unknown'
    id?: string | null
    title?: string | null
    description?: string | null
    payload?: Record<string, unknown>
    rawSelection?: Record<string, unknown>
  } | null
  context?: {
    quoted?: {
      messageId?: string | null
      sender?: string | null
      chatJid?: string | null
      type?: string | null
      text?: string | null
      mediaType?: string | null
      preview?: string | null
    } | null
    interactiveOrigin?: {
      messageType?: string
    } | null
    targetMessage?: {
      messageId?: string | null
      sender?: string | null
      chatJid?: string | null
    } | null
    targetPollId?: string | null
  } | null
  media?: {
    id: string
    kind?: string
    mimeType?: string
    fileName?: string
    fileSize?: number
    duration?: number
    caption?: string
    isVoiceNote?: boolean
    url?: string
    directPath?: string
    downloadSource?: 'provider-url' | 'decrypted' | 'cache' | string
  } | null
  meta?: {
    requestId?: string
    conversationId?: string
  }
  pipeline?: {
    stage?: string
    status?: string
    requestId?: string
    conversationId?: string
    messageId?: string
  }
  details?: Record<string, unknown>
  raw?: unknown
  metadata?: {
    hasLocation?: boolean
    hasContacts?: boolean
    hasPoll?: boolean
    removeReaction?: boolean
    liveLocation?: boolean
    pollOptionCount?: number
    ephemeral?: boolean
    edited?: boolean
    revoked?: boolean
    fromBusiness?: boolean
    newsletter?: boolean
    statusMessage?: boolean
  }
}

export type WebhookAuthType = 'NONE' | 'BEARER' | 'API_KEY' | 'BASIC' | 'CUSTOM_HEADERS'

export interface InstanceWebhook {
  id: string
  instanceId: string
  name?: string
  url: string
  enabled: boolean
  authType: WebhookAuthType
  authConfig: Record<string, string | boolean>
  customHeaders: Record<string, string>
  eventFilters?: {
    business?: boolean
    transport?: boolean
    operational?: boolean
  }
  createdAt?: string | null
  updatedAt?: string | null
  lastUsedAt?: string | null
  lastStatus?: string | null
  lastError?: string | null
  lastSuccessAt?: string | null
  lastFailureAt?: string | null
  lastStatusCode?: number | null
  lastLatencyMs?: number | null
  avgLatencyMs?: number | null
  consecutiveFailures?: number
  healthStatus?: 'healthy' | 'degraded' | 'unhealthy'
  unhealthy?: boolean
  successCount?: number
  failureCount?: number
  retryCount?: number
  unhealthyCount?: number
  dispatchHistory?: WebhookDispatchLog[]
}

export interface WebhookDeliveryMetrics {
  instanceName: string
  totalDeliveries: number
  successfulDeliveries: number
  failedDeliveries: number
  retries: number
  averageResponseTimeMs: number
}

export interface WebhookDispatchLog {
  timestamp: number
  webhookId?: string | null
  webhookName?: string | null
  instanceName?: string | null
  destinationUrl?: string | null
  eventType?: string | null
  status: string
  success?: boolean
  failure?: boolean
  dispatchId?: string
  messageId?: string | null
  conversationId?: string | null
  eventSubtype?: string | null
  attemptCount?: number
  retryCount?: number
  statusCode?: number
  responseCode?: number
  durationMs?: number
  error?: string | null
  errorType?: string | null
  request?: {
    method?: string
    headers?: Record<string, string>
    payloadSummary?: Record<string, unknown>
    payloadSizeBytes?: number
    payloadPreview?: string
    payloadTruncated?: boolean
  }
  response?: {
    headers?: Record<string, string>
    bodyPreview?: string
  }
  attempts?: Array<{
    attempt: number
    success?: boolean
    statusCode?: number
    durationMs?: number
    errorType?: string | null
    error?: string | null
    response?: {
      headers?: Record<string, string>
      bodyPreview?: string
    }
  }>
}
