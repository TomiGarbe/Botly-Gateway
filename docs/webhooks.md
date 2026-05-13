# Evolution API v2 — Webhooks

## Flujo general

```
WhatsApp → Evolution API → HTTP POST → Gateway → Bot
```

Evolution envía un `POST` al endpoint configurado cada vez que ocurre un evento. El payload siempre tiene la misma estructura base:

```json
{
  "event": "NOMBRE_DEL_EVENTO",
  "instance": "tenantA_support",
  "data": { ... },
  "destination": "http://gateway:9000/webhooks/evolution",
  "date_time": "2024-01-15T10:30:00.000Z",
  "sender": "5491112345678@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "tu_api_key"
}
```

---

## Eventos principales

### MESSAGES_UPSERT — Mensaje entrante nuevo

```json
{
  "event": "MESSAGES_UPSERT",
  "instance": "tenantA_support",
  "data": {
    "key": {
      "remoteJid": "5491112345678@s.whatsapp.net",
      "fromMe": false,
      "id": "MSG_ID_UNICO"
    },
    "pushName": "Nombre del contacto",
    "status": "DELIVERY_ACK",
    "message": {
      "conversation": "Texto del mensaje"
      // o "imageMessage", "audioMessage", "documentMessage", etc.
    },
    "messageType": "conversation",
    "messageTimestamp": 1705318200,
    "instanceId": "uuid-instancia",
    "source": "android"
  }
}
```

**Tipos de `message` frecuentes:**

| Campo en `message` | Tipo |
|---|---|
| `conversation` | Texto plano |
| `extendedTextMessage.text` | Texto con formato / respuesta a mensaje |
| `imageMessage` | Imagen (incluye `caption`, `url`, `mimetype`) |
| `audioMessage` | Audio / voice note |
| `documentMessage` | Archivo adjunto |
| `buttonsResponseMessage` | Respuesta a botones — el `selectedButtonId` está en `selectedButtonId` |
| `listResponseMessage` | Respuesta a lista — el item elegido en `singleSelectReply.selectedRowId` |

Para grupos, `remoteJid` termina en `@g.us` y el sender real viene en `participant`.

---

### MESSAGES_UPDATE — Cambio de estado de mensaje

```json
{
  "event": "MESSAGES_UPDATE",
  "instance": "tenantA_support",
  "data": [
    {
      "key": {
        "remoteJid": "5491112345678@s.whatsapp.net",
        "fromMe": true,
        "id": "MSG_ID"
      },
      "update": {
        "status": "READ"
      }
    }
  ]
}
```

`status` puede ser: `PENDING` → `SERVER_ACK` → `DELIVERY_ACK` → `READ`

---

### CONNECTION_UPDATE — Cambio de estado de conexión

```json
{
  "event": "CONNECTION_UPDATE",
  "instance": "tenantA_support",
  "data": {
    "instance": "tenantA_support",
    "state": "open",
    "statusReason": 200
  }
}
```

`state`: `open` | `close` | `connecting`

Este evento se debe usar para detectar desconexiones inesperadas y notificar al tenant correspondiente.

---

### QRCODE_UPDATED — QR actualizado

```json
{
  "event": "QRCODE_UPDATED",
  "instance": "tenantA_support",
  "data": {
    "qrcode": {
      "instance": "tenantA_support",
      "pairingCode": null,
      "code": "2@xxx...",
      "base64": "data:image/png;base64,..."
    }
  }
}
```

Se dispara cada vez que se genera un QR nuevo (al crear instancia, al reconectar, o al expirar el anterior). El gateway debería forwarded este evento al bot para que pueda mostrárselo al usuario.

---

### SEND_MESSAGE — Confirmación de envío

```json
{
  "event": "SEND_MESSAGE",
  "instance": "tenantA_support",
  "data": {
    "key": { "remoteJid": "...", "fromMe": true, "id": "MSG_ID" },
    "status": "PENDING",
    "message": { "conversation": "Mensaje enviado" },
    "messageTimestamp": 1705318200
  }
}
```

---

## Configuración recomendada por instancia

```json
{
  "webhook": {
    "enabled": true,
    "url": "http://gateway:9000/webhooks/evolution",
    "webhookByEvents": false,
    "webhookBase64": false,
    "events": [
      "MESSAGES_UPSERT",
      "MESSAGES_UPDATE",
      "CONNECTION_UPDATE",
      "QRCODE_UPDATED",
      "SEND_MESSAGE"
    ]
  }
}
```

`webhookByEvents: false` → un solo endpoint recibe todos los eventos (recomendado para el gateway).  
`webhookBase64: false` → los medios vienen como URL, no como base64 embebido (más liviano).

---

## Notas de implementación

**Idempotencia:** Evolution puede re-enviar el mismo evento si no recibe 200. El gateway debe manejar duplicados usando el `id` del mensaje como clave de deduplicación.

**Timeouts:** Evolution espera respuesta en < 30s. Si el bot tarda más, el gateway debe responder 200 de inmediato y procesar el evento de forma asíncrona.

**Verificar origen:** El payload incluye `apikey`. El gateway puede validar que coincida con `EVOLUTION_API_KEY` para descartar requests externos.
