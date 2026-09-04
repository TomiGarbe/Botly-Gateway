# Instagram UI y Core Control Plane

## Flujo de onboarding

1. En **Conexiones**, el operador elige **Instagram** y crea una Connection con
   `provider=meta` y `channel=instagram`.
2. La UI navega al endpoint de Gateway `GET /connections/meta/instagram/authorize`.
   Gateway crea y persiste un estado OAuth de un solo uso y redirige a Meta.
3. Meta retorna a `GET /connections/meta/instagram/callback`. El callback canónico
   sigue devolviendo JSON para consumidores existentes. Si la autorización se inició
   con `ui_return=true`, el estado guardado habilita un redirect 303 sin tokens a
   `/connections/{connection_id}/instagram/complete?oauth=success|cancelled|failed`.
4. La UI consulta la Connection y `GET /connections/{id}/instagram/readiness`; no
   recibe tokens ni identificadores de credenciales.

## Core Channel

Cuando la cuenta está conectada, la UI obtiene canales mediante:

`GET /connections/{connection_id}/instagram/core-channels`

Gateway autentica y aplica RBAC/ownership, usa `Connection.client_id` como identidad
del tenant y llama internamente a Core:

`GET {CORE_CONTROL_PLANE_URL}/channels?channel_type=instagram`

El navegador recibe exclusivamente `id`, `name`, `channel_type` y `status`.

Al seleccionar un canal, la UI envía únicamente:

`PUT /connections/{connection_id}/instagram/core-channel`

```json
{"core_channel_id":"..."}
```

Gateway llama internamente a `POST {CORE_CONTROL_PLANE_URL}/bindings` con el
`gateway_connection_id`, el `core_channel_id` y `channel_type=instagram`. Core
devuelve el binding y una credencial de dispatch. Gateway persiste esa credencial
solamente en `CoreChannelCredentialStore`, cifrada con
`CORE_CHANNEL_CREDENTIALS_ENCRYPTION_KEY`; la respuesta pública sólo expone el canal
vinculado.

```text
Browser
  -> Gateway UI/API
  -> Core Control Plane
  -> Channel + dispatch credential
  -> Gateway encrypted credential storage
  -> G4 canonical inbound dispatcher -> Core
```

El binding de Core es idempotente. Reintentos o doble click vuelven a confirmar el
binding y actualizan de forma segura la credencial local devuelta por Core.

## Desconexión

`POST /connections/{connection_id}/instagram/disconnect` revoca primero el binding
de Core mediante `DELETE {CORE_CONTROL_PLANE_URL}/bindings/{binding_id}`. Si Core lo
confirma, Gateway elimina la credencial cifrada local y desconecta la cuenta. Los
bindings históricos que no tienen `binding_id` conservan su comportamiento local
preexistente.

## Seguridad y errores

- `GATEWAY_CONTROL_PLANE_API_KEY` se usa sólo entre Gateway y Core, en
  `Authorization: Bearer ...` junto con `X-Botly-Gateway-Client-Id`.
- La dispatch credential, `channel_api_key`, credenciales Meta, OAuth state y tokens
  nunca se incluyen en URLs de UI, respuestas públicas, storage del navegador ni
  logs.
- La discovery y el binding son tenant-scoped en Core y además validan RBAC y
  ownership de la Connection en Gateway.
- Ausencia de configuración de Core, timeouts y respuestas 401/403/404/409/5xx se
  traducen a errores seguros para UI; no se muestran detalles internos ni secretos.

## Configuración de producción

Además de la configuración existente de Instagram y G4, Gateway necesita:

```dotenv
CORE_CONTROL_PLANE_URL=https://<core>/api/v1/control-plane/gateway
GATEWAY_CONTROL_PLANE_API_KEY=<server-to-server-secret>
CORE_CONTROL_PLANE_TIMEOUT_SECONDS=10
```

`CORE_CONTROL_PLANE_URL` debe terminar en `/api/v1/control-plane/gateway`.
`GATEWAY_CONTROL_PLANE_API_KEY` es un secreto de deployment: no debe versionarse ni
exponerse al frontend. La integración se informa como pendiente si faltan URL o key.

## Validación manual previa a E2E real

1. Verificar que Core tenga el mapping `gateway_client_id -> Business` para el
   `Connection.client_id` de prueba y un Channel Instagram activo.
2. Iniciar el onboarding desde la UI, completar Meta Business Login y confirmar que
   la URL final no contiene tokens, state ni credenciales.
3. Confirmar cuenta y readiness, seleccionar un Channel y vincularlo.
4. Confirmar que G4 puede enviar al `CORE_INBOUND_URL` usando la credencial cifrada.
5. Desconectar y confirmar que Core revocó el binding antes de que Gateway eliminara
   su credencial local.

El flujo Meta real y la entrega real de eventos no se ejecutan como parte de esta
implementación ni de CI.
