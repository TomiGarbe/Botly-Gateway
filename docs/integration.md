# Integración del bot con el Gateway

## Flujo de comunicación

```
Bot  ──POST /instances/{name}/messages/text──▶  Gateway  ──▶  Evolution  ──▶  WhatsApp
Bot  ◀──POST /tu-endpoint-de-webhooks──────────  Gateway  ◀──  Evolution  ◀──  WhatsApp
```

## Variables que el bot necesita

```env
GATEWAY_URL=http://localhost:9000     # en producción: URL del gateway
GATEWAY_API_KEY=tu_gateway_api_key    # debe coincidir con GATEWAY_API_KEY en config/.env
```

## Autenticación

Todos los requests del bot al gateway llevan el header:

```
X-API-Key: <GATEWAY_API_KEY>
```

El endpoint `/webhooks/evolution` y `/health` no requieren auth (son llamados por Evolution y por health checks externos).

---

## Endpoints disponibles

### Gestión de instancias

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/instances/` | Crear instancia |
| `GET` | `/instances/` | Listar todas |
| `GET` | `/instances/{name}/state` | Estado de conexión |
| `GET` | `/instances/{name}/qr` | Obtener QR como base64 |
| `DELETE` | `/instances/{name}/logout` | Cerrar sesión WhatsApp |
| `DELETE` | `/instances/{name}` | Eliminar instancia |

### Mensajes

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/instances/{name}/messages/text` | Enviar texto |
| `POST` | `/instances/{name}/messages/media` | Enviar imagen/video/audio/doc |
| `POST` | `/instances/{name}/messages/buttons` | Enviar botones |
| `POST` | `/instances/{name}/messages/list` | Enviar lista |
| `POST` | `/instances/{name}/messages/check-numbers` | Verificar si tiene WhatsApp |

### Webhooks (inbound, llamado por Evolution)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/webhooks/evolution` | Recibe todos los eventos de Evolution |

---

## Configurar destino de webhooks en el bot

En `config/.env`, setear:

```env
BOT_WEBHOOK_URL=http://tu-bot:puerto/whatsapp/events
```

El gateway hará `POST` a esa URL con el payload completo de Evolution cada vez que reciba un evento.

---

## Cliente HTTP de referencia (Python)

Ver `gateway/examples/evolution_client.py` para un cliente listo para usar.

---

## Testing end-to-end

### 1. Verificar que el gateway esté arriba

```bash
curl http://localhost:9000/health
# {"status": "ok", "service": "evolution-gateway"}
```

### 2. Crear una instancia

```bash
curl -X POST http://localhost:9000/instances/ \
  -H "X-API-Key: tu_gateway_api_key" \
  -H "Content-Type: application/json" \
  -d '{"instance_name": "test_support", "qrcode": true}'
```

### 3. Obtener el QR y escanearlo

```bash
curl http://localhost:9000/instances/test_support/qr \
  -H "X-API-Key: tu_gateway_api_key"
# Devuelve base64 de la imagen — mostrarlo en el browser o guardarlo como PNG
```

### 4. Verificar conexión

```bash
curl http://localhost:9000/instances/test_support/state \
  -H "X-API-Key: tu_gateway_api_key"
# {"instance": {"instanceName": "test_support", "state": "open"}}
```

### 5. Enviar mensaje de prueba

```bash
curl -X POST http://localhost:9000/instances/test_support/messages/text \
  -H "X-API-Key: tu_gateway_api_key" \
  -H "Content-Type: application/json" \
  -d '{"number": "5491112345678", "text": "Mensaje de prueba desde el gateway"}'
```

### 6. Verificar que el webhook llegue al bot

Configurar `BOT_WEBHOOK_URL` apuntando a un endpoint del bot (o a `https://webhook.site` para debug rápido) y enviar un mensaje desde WhatsApp a la instancia conectada. El gateway debe recibir el evento de Evolution y forwarded al bot.

### 7. Verificar persistencia post-reinicio

```bash
./scripts/stop.sh
./scripts/start.sh
# Esperar ~30 segundos
curl http://localhost:9000/instances/test_support/state \
  -H "X-API-Key: tu_gateway_api_key"
# Debe devolver state: "open" sin re-escanear QR
```
