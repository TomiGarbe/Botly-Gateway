# Correccion del webhook entrante de Evolution API

Fecha: 2026-09-01.

## Problema y root cause

El trafico saliente `Gateway -> Evolution -> WhatsApp` no usaba el webhook y
por eso podia funcionar mientras que el entrante no. `EvolutionAdapter` enviaba
la configuracion a `POST /webhook/set/{instanceName}` dentro de un wrapper
`webhook`. Evolution API v2.3.7 espera los campos en el nivel raiz; como
resultado, el callback efectivo no quedaba garantizado. Ademas, el resultado no
se verificaba en todos los caminos y el flujo legacy podia ocultar el fallo.

## Cambios realizados

- `EvolutionAdapter.configure_webhook()` usa el contrato plano de v2.3.7:
  `enabled`, `url`, `events`, `headers` y `base64`.
- `ensure_evolution_webhook()` centraliza lectura, reparacion y verificacion. La
  verificacion valida solo `enabled`, URL y `MESSAGES_UPSERT`; valida tambien el
  header de secreto cuando esta configurado.
- El alta moderna no promueve una conexion si no puede crear, configurar y
  verificar el webhook: queda en `cleanup_pending` con diagnostico.
- El alta legacy devuelve error 502 si la instancia fue creada pero su webhook
  obligatorio no pudo verificarse, y sincroniza la instancia con el registro de
  conexiones existente.
- Reconnect verifica/repara antes de continuar. El recovery de inicio revisa
  tambien instancias `OPEN`, sin bloquear el arranque.
- El receptor resuelve `instanceName -> connection -> business -> channel`
  mediante el registro existente. Una instancia desconocida se registra como
  tal y responde 404 sin entrar al pipeline.

## Nuevo flujo

```text
crear o recuperar instancia
  -> GET webhook
  -> reparar con POST /webhook/set/{instanceName} si falta o no coincide
  -> GET webhook y validar
  -> Evolution envia MESSAGES_UPSERT
  -> POST /webhooks/evolution
  -> autenticar, resolver conexion, normalizar, persistir y dispatch a Botly
```

## Configuracion y autenticacion

La URL interna configurada para Evolution es:

```text
http://gateway:9000/webhooks/evolution
```

Es la direccion de red Docker entre Evolution y Gateway; Cloudflare sigue
siendo el borde publico y no participa en esa llamada interna.

Definir un secreto independiente en el entorno:

```dotenv
EVOLUTION_WEBHOOK_SECRET=un-secreto-largo-y-aleatorio
```

El Gateway lo instala como header `x-evolution-webhook-secret` en cada webhook
de Evolution y compara el valor de manera segura al recibirlo. Con ese secreto
presente es el unico mecanismo aceptado. Sin el valor se conserva, por
compatibilidad, el mecanismo legacy de API key global o token por instancia.
Los logs solo incluyen prefijos redactados y metadatos, nunca el secreto ni el
contenido del mensaje.

## Recovery

- **Creacion inicial:** configura y verifica obligatoriamente; si falla no se
  declara una conexion lista.
- **Reconnect:** primero verifica el callback y lo repara si corresponde; un
  error se devuelve explicitamente.
- **Reinicio del Gateway:** cada runtime Evolution se revisa en segundo plano,
  incluso si Evolution informa `OPEN`.
- **Webhook eliminado o alterado:** la siguiente recuperacion/reconnect detecta
  el mismatch y ejecuta la reparacion seguida de una nueva verificacion.

## Respuestas del receptor

- 401: falta credencial.
- 403: credencial invalida.
- 404: instancia Evolution no registrada.
- 422: payload no normalizable.
- 500: fallo de persistencia; no se informa como entrega exitosa.
- 200: evento tecnico/ignorado o mensaje aceptado para pipeline.

`MESSAGES_UPSERT` conserva tanto `fromMe=false` como `fromMe=true`; campos
opcionales como `pushName` y `participant` pueden faltar.

## Tests

Se agregaron tests para el body plano de Evolution, reparacion y mismatch de
configuracion, fallo visible durante el setup, autenticacion por secreto,
resolucion de instancia conocida/desconocida y normalizacion de mensajes
entrantes propios y ajenos con campos opcionales ausentes.

## Runtime validation

**Implementado y testeado automaticamente.** La validación contra
contenedores debe ejecutarse dentro de la distribución Linux de WSL que corre
el stack; Docker Desktop no es parte de este entorno ni un reemplazo válido.

Antes de ejecutarla por SSH, confirmar que la sesión entra a una distribución
WSL real con Bash y Docker Compose. Si devuelve `execvpe(/bin/bash) failed`,
la configuración SSH/WSL está apuntando erróneamente a `docker-desktop` u otra
distribución sin Bash y debe corregirse antes de desplegar.

Validación manual en la terminal WSL del servidor:

```bash
docker compose -p evolution -f docker/docker-compose.yml --env-file config/.env up -d evolution gateway
docker compose -p evolution -f docker/docker-compose.yml --env-file config/.env exec evolution sh -lc "wget -S -O- http://gateway:9000/webhooks/evolution"
```

Despues, crear o reconectar una instancia, consultar `GET
/webhook/find/{instanceName}`, enviar un mensaje externo y uno propio, y
confirmar logs, persistencia y dispatch a Botly.

## Pendientes

- Ejecutar la validacion real anterior con credenciales y una instancia
  Evolution disponibles. No quedaron cambios de alcance funcional pendientes.
