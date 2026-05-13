# Evolution API v2 — Referencia de endpoints

Base URL: `http://localhost:8080`  
Auth header en todos los requests: `apikey: <EVOLUTION_API_KEY>`

---

## Instancias

### Crear instancia

```http
POST /instance/create
Content-Type: application/json
apikey: <key>
```

```json
{
  "instanceName": "tenantA_support",
  "integration": "WHATSAPP-BAILEYS",
  "qrcode": true,
  "number": "",
  "token": "opcional-token-fijo"
}
```

**Respuesta exitosa (201)**
```json
{
  "instance": {
    "instanceName": "tenantA_support",
    "instanceId": "uuid",
    "status": "created"
  },
  "hash": "token-de-la-instancia",
  "qrcode": {
    "code": "2@xxx...",
    "base64": "data:image/png;base64,..."
  }
}
```

---

### Obtener QR (si expiró o no se pidió al crear)

```http
GET /instance/connect/{instanceName}
apikey: <key>
```

**Respuesta**
```json
{
  "code": "2@xxx...",
  "base64": "data:image/png;base64,..."
}
```

El QR expira en ~60 segundos. Si la instancia ya está conectada, devuelve `{ "instance": { "state": "open" } }`.

---

### Estado de conexión

```http
GET /instance/connectionState/{instanceName}
apikey: <key>
```

```json
{
  "instance": {
    "instanceName": "tenantA_support",
    "state": "open"   // open | close | connecting
  }
}
```

---

### Listar todas las instancias

```http
GET /instance/fetchInstances
apikey: <key>
```

Devuelve array con todas las instancias y su estado actual.

---

### Desconectar (logout de WhatsApp, no elimina instancia)

```http
DELETE /instance/logout/{instanceName}
apikey: <key>
```

Cierra la sesión de WhatsApp pero mantiene la instancia en Evolution. Al reconectar hay que escanear QR de nuevo.

---

### Eliminar instancia

```http
DELETE /instance/delete/{instanceName}
apikey: <key>
```

Elimina la instancia de Evolution y de la base de datos. Irreversible.

---

## Mensajes

### Enviar texto

```http
POST /message/sendText/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{
  "number": "5491112345678",
  "text": "Hola, este es un mensaje de prueba"
}
```

El campo `number` acepta formato E.164 sin `+` (`549...` para Argentina).

---

### Enviar imagen

```http
POST /message/sendMedia/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{
  "number": "5491112345678",
  "mediatype": "image",
  "media": "https://url-de-la-imagen.jpg",
  "caption": "Texto opcional debajo de la imagen"
}
```

`mediatype` acepta: `image` | `video` | `audio` | `document`

---

### Enviar botones

```http
POST /message/sendButtons/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{
  "number": "5491112345678",
  "title": "Título del mensaje",
  "description": "Descripción",
  "footer": "Footer opcional",
  "buttons": [
    { "type": "reply", "displayText": "Opción 1", "id": "btn_1" },
    { "type": "reply", "displayText": "Opción 2", "id": "btn_2" }
  ]
}
```

---

### Enviar lista

```http
POST /message/sendList/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{
  "number": "5491112345678",
  "title": "Título",
  "description": "Descripción",
  "buttonText": "Ver opciones",
  "footerText": "Footer",
  "sections": [
    {
      "title": "Sección 1",
      "rows": [
        { "title": "Item A", "description": "Descripción A", "rowId": "item_a" },
        { "title": "Item B", "description": "Descripción B", "rowId": "item_b" }
      ]
    }
  ]
}
```

---

## Webhooks por instancia

### Configurar webhook

```http
POST /webhook/set/{instanceName}
Content-Type: application/json
apikey: <key>
```

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
      "QRCODE_UPDATED"
    ]
  }
}
```

### Ver webhook configurado

```http
GET /webhook/find/{instanceName}
apikey: <key>
```

---

## Contactos y chats

### Buscar contactos

```http
POST /chat/findContacts/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{ "where": { "remoteJid": "5491112345678@s.whatsapp.net" } }
```

### Verificar si un número tiene WhatsApp

```http
POST /chat/whatsappNumbers/{instanceName}
Content-Type: application/json
apikey: <key>
```

```json
{ "numbers": ["5491112345678", "5491198765432"] }
```

```json
[
  { "exists": true,  "jid": "5491112345678@s.whatsapp.net", "number": "5491112345678" },
  { "exists": false, "jid": null,                            "number": "5491198765432" }
]
```

---

## Códigos de error comunes

| Código | Causa |
|--------|-------|
| 401 | `apikey` ausente o incorrecta |
| 404 | Instancia no encontrada |
| 422 | Body inválido (campo faltante o tipo incorrecto) |
| 500 | Error interno — ver logs del contenedor |
