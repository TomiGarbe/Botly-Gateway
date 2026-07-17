import type { ConnectionDiagnostic, HealthCheck, Instance, PipelineEvent } from '../types'

export function isOfficialConnection(instance: Instance): boolean {
  return instance.connectionType === 'cloud' || instance.integration === 'WHATSAPP-BUSINESS'
}

export function connectionTypeLabel(instance: Instance): string {
  return isOfficialConnection(instance) ? 'WhatsApp Oficial' : 'WhatsApp Web'
}

export function connectionIconTone(instance: Instance): string {
  return isOfficialConnection(instance)
    ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
    : 'border-blue-900 bg-blue-950/30 text-blue-300'
}

export function statusLabel(instance: Instance): string {
  if (instance.lifecycleState === 'token_expired') return 'Debes volver a conectar'
  if (instance.lifecycleState === 'webhook_invalid') return 'Necesita revisar recepcion'
  if (instance.lifecycleState === 'needs_attention' || instance.lifecycleState === 'failed') return 'Necesita atencion'
  if (instance.status === 'open') return 'Conectado'
  if (instance.status === 'connecting') return isOfficialConnection(instance) ? 'Configurando' : 'Esperando QR'
  return 'Desconectado'
}

export function statusTone(instance: Instance): { dot: string; text: string; border: string } {
  if (instance.lifecycleState === 'token_expired' || instance.lifecycleState === 'webhook_invalid' || instance.lifecycleState === 'failed') {
    return { dot: 'bg-red-500', text: 'text-red-300', border: 'border-red-900 bg-red-950/30' }
  }
  if (instance.lifecycleState === 'needs_attention' || instance.lifecycleState === 'warning' || instance.health === 'degraded') {
    return { dot: 'bg-amber-400', text: 'text-amber-300', border: 'border-amber-900 bg-amber-950/30' }
  }
  if (instance.status === 'open' || instance.health === 'healthy') {
    return { dot: 'bg-emerald-500', text: 'text-emerald-300', border: 'border-emerald-900 bg-emerald-950/30' }
  }
  if (instance.status === 'connecting') {
    return { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', border: 'border-amber-900 bg-amber-950/30' }
  }
  return { dot: 'bg-zinc-600', text: 'text-zinc-400', border: 'border-zinc-700 bg-zinc-800/50' }
}

export function healthLabel(instance: Instance): string {
  if (instance.health === 'healthy') return 'Todo funciona correctamente'
  if (instance.health === 'degraded') return 'Funciona con advertencias'
  if (instance.health === 'unhealthy') return 'Requiere atencion'
  if (instance.status === 'open') return 'Disponible'
  return 'Sin verificar'
}

export function formatActivity(value?: string | number | null): string {
  if (!value) return 'Sin actividad reciente'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin actividad reciente'
  return date.toLocaleString()
}

export function diagnosticText(item: ConnectionDiagnostic | HealthCheck): { title: string; action: string; tone: string } {
  const code = 'code' in item ? item.code : ''
  const rawMessage = sanitizeUserText('message' in item ? item.message : item.details || item.label)
  const rawRecommendation = sanitizeUserText('recommendation' in item ? item.recommendation : ('details' in item ? item.details : undefined))

  if (code.includes('token')) {
    return {
      title: 'Debes volver a conectar',
      action: 'Reconecta la cuenta desde WhatsApp Oficial.',
      tone: 'text-red-300 border-red-900 bg-red-950/30',
    }
  }
  if (code.includes('webhook')) {
    return {
      title: 'Los mensajes entrantes necesitan revision',
      action: 'Actualiza la URL de recepcion o vuelve a configurar la conexion.',
      tone: 'text-amber-300 border-amber-900 bg-amber-950/30',
    }
  }
  if (code.includes('permission')) {
    return {
      title: 'Faltan permisos para usar WhatsApp',
      action: 'Vuelve a conectar la cuenta y acepta los permisos solicitados.',
      tone: 'text-red-300 border-red-900 bg-red-950/30',
    }
  }
  if (code.includes('coexistence')) {
    return {
      title: 'La aplicacion movil necesita revision',
      action: 'Revisa WhatsApp Business App y vuelve a conectar si el problema continua.',
      tone: 'text-amber-300 border-amber-900 bg-amber-950/30',
    }
  }
  return {
    title: rawMessage || 'Falta completar la configuracion',
    action: rawRecommendation || 'Revisa la configuracion de la conexion.',
    tone: 'text-amber-300 border-amber-900 bg-amber-950/30',
  }
}

export function sanitizeUserText(value?: string | null): string {
  if (!value) return ''
  return value
    .replace(/WHATSAPP-BUSINESS/gi, 'WhatsApp Oficial')
    .replace(/WHATSAPP-BAILEYS/gi, 'WhatsApp Web')
    .replace(/Cloud API/gi, 'WhatsApp Oficial')
    .replace(/Graph API/gi, 'servicio de conexion')
    .replace(/Evolution/gi, 'servicio de conexion')
    .replace(/Baileys/gi, 'WhatsApp Web')
    .replace(/Meta/gi, 'WhatsApp Oficial')
    .replace(/webhook/gi, 'recepcion')
    .replace(/token/gi, 'credencial')
}

export function recommendation(instance: Instance, events: PipelineEvent[] = []): string {
  const diagnostics = instance.diagnostics || []
  if (instance.health === 'healthy' && instance.status === 'open') return 'Tu conexion esta lista.'
  if (diagnostics.some(item => item.code.includes('token')) || instance.lifecycleState === 'token_expired') return 'Conviene volver a conectar la cuenta.'
  if (diagnostics.some(item => item.code.includes('webhook')) || instance.lifecycleState === 'webhook_invalid') return 'La recepcion de mensajes necesita ser actualizada.'
  if (events.length === 0 && instance.status === 'open') return 'No se detecto actividad reciente.'
  if (instance.status === 'connecting') return 'La conexion esta terminando de prepararse.'
  return 'Revisa el diagnostico antes de usar esta conexion.'
}

export function eventTitle(event: PipelineEvent): string {
  const token = String(event.event || event.pipeline?.stage || '').toLowerCase()
  if (token.includes('auth')) return 'Error de autenticacion'
  if (token.includes('webhook') && token.includes('configured')) return 'Recepcion de mensajes actualizada'
  if (token.includes('message')) return event.fromMe ? 'Mensaje enviado' : 'Mensaje recibido'
  if (token.includes('connect')) return 'Conexion actualizada'
  if (token.includes('error') || event.error) return 'Se detecto un problema'
  return 'Actividad registrada'
}

export function eventDescription(event: PipelineEvent): string {
  if (event.error?.message) return sanitizeUserText(event.error.message)
  if (event.text) return sanitizeUserText(event.text)
  if (event.message?.text) return sanitizeUserText(event.message.text)
  if (event.status) return `Estado: ${event.status}`
  return 'Evento procesado por la conexion.'
}
