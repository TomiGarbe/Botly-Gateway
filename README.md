# Botly Gateway

Gateway propio sobre Evolution API v2 para gestión multi-tenant de instancias WhatsApp.

**Stack:** Evolution API v2 · PostgreSQL 17 · Redis 7 · FastAPI · Docker Compose

## Estructura del proyecto

```
.
├── config/
│   └── .env.example      # Plantilla de variables de entorno
├── docker/
│   └── docker-compose.yml
├── docs/
│   ├── api-reference.md  # Endpoints de Evolution v2
│   ├── architecture.md   # Decisiones de diseño multi-tenant
│   ├── integration.md    # Cómo conectar el bot al gateway
│   └── webhooks.md       # Payloads y eventos
├── gateway/              # FastAPI gateway (Etapa 3)
└── scripts/
    ├── logs.sh           # Ver logs de un servicio
    ├── reset.sh          # Reset completo (destructivo)
    ├── start.sh          # Levantar servicios
    ├── status.sh         # Estado y health check
    └── stop.sh           # Detener servicios
```

## Setup rápido

```bash
# 1. Crear config/.env a partir del ejemplo
cp config/.env.example config/.env

# 2. Editar las variables obligatorias (ver abajo)
nano config/.env

# 3. Levantar
./scripts/start.sh

# 4. Verificar
./scripts/status.sh
```

La API queda disponible en `http://localhost:8080` (o el puerto que configuraste en `EVOLUTION_PORT`).

## Variables obligatorias

| Variable | Descripción |
|---|---|
| `EVOLUTION_API_KEY` | Clave global de Evolution API. Generá con `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | Contraseña de PostgreSQL. Generá con `openssl rand -hex 16` |
| `REDIS_PASSWORD` | Contraseña de Redis. Generá con `openssl rand -hex 16` |
| `GATEWAY_API_KEY` | Clave que usa el bot para autenticarse al gateway |
| `MAX_EVENT_AGE_SECONDS` | Edad máxima aceptable de eventos entrantes antes de descartarlos (`0` deshabilita, recomendado `600`) |

Las demás variables tienen valores por defecto funcionales para desarrollo local.

## Scripts disponibles

| Script | Descripción |
|---|---|
| `./scripts/start.sh` | Levanta todos los servicios en background |
| `./scripts/stop.sh` | Detiene los servicios (conserva datos) |
| `./scripts/status.sh` | Estado de contenedores + health check de Evolution |
| `./scripts/logs.sh [servicio]` | Logs en tiempo real. Ej: `./scripts/logs.sh evolution` |
| `./scripts/reset.sh` | **Destructivo.** Borra todos los volúmenes de datos |

## Documentación

- [Referencia de API](docs/api-reference.md)
- [Webhooks](docs/webhooks.md)
- [Arquitectura multi-tenant](docs/architecture.md)
- [Integración con el bot](docs/integration.md)

## WhatsApp Oficial - frontera del Provider

La arquitectura definitiva para WhatsApp Oficial es:

```text
Meta / WhatsApp Cloud -> Gateway -> Botly
```

Meta debe comunicarse con el callback oficial del Gateway: `GET` y `POST /webhooks/meta`. El Gateway valida `hub.challenge`, el Verify Token y `X-Hub-Signature-256` antes de aceptar eventos.

El endpoint del Gateway `/webhooks/evolution` recibe solo eventos emitidos por Evolution. A partir de ese punto el Gateway valida autenticacion de Evolution, normaliza el evento y lo despacha hacia Botly.

Embedded Signup termina cuando el Gateway obtiene `access_token`, `phone_number_id` y `business_account_id`, y crea la instancia oficial. El mismo `phone_number_id` vincula los eventos de Meta que llegan a `/webhooks/meta` con la instancia correspondiente. Evolution puede seguir usándose para las operaciones de instancia, pero no es el callback configurado en Meta Developers.

El dominio del Gateway conserva solo metadata administrativa propia: onboarding, credenciales minimizadas para mostrar/recrear conexiones, configuracion de usuario y preferencias. Estados operativos como conexion, health, webhooks, tokens, coexistence y diagnosticos de runtime se proyectan desde Evolution cuando se consulta la instancia; no se persisten como fuente de verdad local.

## Integraciones externas (UX en Instancias)

Cada instancia ahora muestra una seccion `Integration` con:
- `Webhook URL`
- `API Base URL`
- endpoints utiles (`messages`, `events`)
- estado de API key por instancia
- botones `Copy` y snippets rapidos (`curl` y `fetch`)

### Como se generan las URLs

Orden de prioridad para construir URLs visibles en frontend:
1. `Public Base URL` guardada en Settings.
2. `VITE_PUBLIC_APP_URL` (si existe en build del frontend).
3. El origen actual de la aplicacion.

Se normalizan quitando slash final para evitar rutas inconsistentes.

`VITE_PUBLIC_BASE_URL` se mantiene solo como compatibilidad de lectura para builds anteriores; los nuevos despliegues deben usar `VITE_PUBLIC_APP_URL`.

El build de produccion usa `frontend/.env.production`: `VITE_PUBLIC_APP_URL` apunta a `https://gateway.botly.com.ar` (frontend) y `VITE_GATEWAY_URL` a `https://gateway-server.botly.com.ar` (API del Gateway en Contabo). El archivo `.env` sin sufijo puede mantenerse con valores locales para desarrollo.

### PUBLIC_APP_URL (backend)

Se agrega `PUBLIC_APP_URL` en `config/.env` y en Docker Compose para dejar explicita la URL publica real del Gateway Docker. En produccion debe ser `https://gateway-server.botly.com.ar`.
Esta variable es de configuracion operativa para evitar usar `localhost` o hosts internos en integraciones.

`PUBLIC_BASE_URL` se admite exclusivamente como alias temporal de lectura para despliegues anteriores; no debe usarse en configuraciones nuevas.

### CORS del gateway

La configuracion CORS vive en el gateway FastAPI y se pasa al contenedor desde `docker/docker-compose.yml`.

Variables:
- `CORS_ALLOWED_ORIGINS`: lista separada por coma de origins permitidos.
- `CORS_ALLOW_ORIGIN_REGEX`: regex opcional para desarrollo local.
- `CORS_DEBUG`: activar temporalmente para loguear Origin, metodo, decision CORS y headers enviados.

Prueba rapida:

```bash
curl -i -X OPTIONS "https://gateway-server.botly.com.ar/instances/" \
  -H "Origin: https://gateway.botly.com.ar" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-api-key,content-type"
```

### Feature Flags de proveedores

La exposicion publica se controla desde el Gateway, no desde condicionales de UI. Por defecto se ocultan los flujos legacy y se mantienen habilitados WhatsApp Oficial e Instagram:

- `FEATURE_PROVIDER_EVOLUTION=false`
- `FEATURE_PROVIDER_BAILEYS=false`
- `FEATURE_WHATSAPP_WEB=false`
- `FEATURE_QR_LOGIN=false`
- `FEATURE_INSTAGRAM=true`
- `FEATURE_WHATSAPP_CLOUD=true`

El frontend consume estas capacidades junto con el catalogo de `/channels/`. Para reactivar un flujo legacy se modifican las flags y se reinicia el Gateway; no se elimina ni se reemplaza codigo.

Como proteccion adicional para demostraciones, el frontend oculta por defecto los metodos e instancias legacy aunque el servidor remoto aun entregue datos antiguos. Para revisarlos solo en soporte interno, configurar `VITE_SHOW_LEGACY_CONNECTIONS=true` y recompilar el frontend.

### Meta Embedded Signup

El flujo no construye callbacks ni redirects en el codigo del Gateway: Meta entrega el resultado en el popup y el frontend solo acepta mensajes HTTPS desde `facebook.com` y su subdominio. Antes del deploy, registrar `https://gateway.botly.com.ar` en los dominios/origins permitidos de la configuracion de Meta; mantener ambos hasta completar la transicion.

### Webhook oficial de WhatsApp Cloud API

Configurar en Meta Developers:

- **Callback URL:** `https://gateway-server.botly.com.ar/webhooks/meta`
- **Verify Token:** el valor secreto de `META_WEBHOOK_VERIFY_TOKEN` en `config/.env`.

El mismo endpoint responde el GET de validacion con el valor exacto de `hub.challenge` y recibe el POST firmado de mensajes, estados, cambios y errores. `META_APP_SECRET` es obligatorio para validar `X-Hub-Signature-256`; no desactivar `META_WEBHOOK_REQUIRE_SIGNATURE` en produccion.

### Uso desde bots externos

Para enviar mensajes desde un bot externo:
1. Copiar `API Base URL` y `Unified Messages endpoint` desde la card de la instancia.
2. Copiar `Bearer token` de la instancia (reveal + copy).
3. Enviar `Authorization: Bearer <token>` al endpoint recomendado.
