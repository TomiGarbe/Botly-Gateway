export interface DeliveryFailure {
  title: string
  advice: string
}

/** Human-readable reading of a failed delivery, shown before the raw request/response data. */
export function describeDeliveryFailure(semanticStatus: string, statusCode: number | null | undefined): DeliveryFailure {
  if (semanticStatus === 'timeout') return { title: 'El destino tardó demasiado en responder.', advice: 'Revisá que el servicio esté arriba y no esté saturado; después reenviá la entrega.' }
  if (semanticStatus === 'network_error' || !statusCode) return { title: 'No se pudo conectar con el destino.', advice: 'Verificá la URL del webhook y que el servidor acepte conexiones desde el Gateway.' }
  if (semanticStatus === 'configuration_error') return { title: 'El webhook está mal configurado.', advice: 'Revisá la URL y la seguridad configuradas en el webhook.' }
  if (statusCode === 401 || statusCode === 403) return { title: `El destino rechazó la autenticación (HTTP ${statusCode}).`, advice: 'La credencial configurada no coincide con la que espera el destino. Actualizala en la seguridad del webhook.' }
  if (statusCode === 404) return { title: 'La URL del destino no existe (HTTP 404).', advice: 'Revisá la ruta configurada en el webhook.' }
  if (statusCode === 409 || statusCode === 422 || statusCode === 400) return { title: `El destino rechazó el contenido (HTTP ${statusCode}).`, advice: 'Reenviar no lo va a resolver: revisá la respuesta del destino para ver qué campo rechazó.' }
  if (statusCode === 429) return { title: 'El destino limitó la cantidad de envíos (HTTP 429).', advice: 'Esperá unos minutos y reenviá.' }
  if (statusCode >= 500) return { title: `El destino falló al procesar la entrega (HTTP ${statusCode}).`, advice: 'Es un error del servicio receptor. Cuando se recupere, reenviá la entrega.' }
  return { title: `El destino respondió HTTP ${statusCode}.`, advice: 'Revisá la respuesta del destino más abajo.' }
}
