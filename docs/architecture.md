# Arquitectura — Botly Evolution Provider

## Visión general

```
Bot (FastAPI)
    │
    │  HTTP + GATEWAY_API_KEY
    ▼
Gateway (FastAPI)          ← autenticación, rate limiting, logging
    │
    │  HTTP + EVOLUTION_API_KEY
    ▼
Evolution API v2           ← gestión de instancias WhatsApp
    ├── PostgreSQL          ← persistencia de mensajes e instancias
    └── Redis               ← cache de sesiones y estado

Evolution API v2
    │
    │  POST webhooks
    ▼
Gateway /webhooks/evolution
    │
    │  forward procesado
    ▼
Bot (FastAPI)
```

**Por qué no exponer Evolution directamente al bot:**
- Evolution usa una sola `apikey` global → exponer la URL directa significa que cualquier servicio que la tenga puede crear/borrar instancias de cualquier tenant.
- El gateway agrega auth por request, rate limiting por tenant, logging estructurado y transformación de payloads.

---

## Modelo multi-tenant: 1 instancia por canal

Cada combinación `tenant + canal` crea una instancia separada en Evolution.

### Convención de nomenclatura

```
{tenantId}_{canal}
```

Ejemplos:
- `acme_support` — canal de soporte de Acme
- `acme_sales`   — canal de ventas de Acme
- `globo_ops`    — operaciones de Globo

**Reglas:**
- Solo minúsculas, guion bajo como separador
- `tenantId` sin espacios ni caracteres especiales
- `canal` es un identificador corto del propósito (`support`, `sales`, `ops`, `billing`, etc.)
- Máximo 64 caracteres en total (limitación de Evolution)

### Por qué no una instancia por tenant

Una sola instancia no permite separar números de WhatsApp por propósito de negocio. Muchos tenants necesitan un número para soporte y otro para ventas — y esos números tienen conversaciones, historial y responsables distintos.

---

## Autenticación

### Bot → Gateway

Header `X-API-Key: <GATEWAY_API_KEY>` en cada request.  
El gateway valida el header en un middleware antes de llegar a cualquier endpoint.

### Gateway → Evolution

Header `apikey: <EVOLUTION_API_KEY>` en cada request.  
La clave está en variables de entorno del gateway, no expuesta al bot.

### Evolution → Gateway (webhooks)

Evolution incluye `apikey` en el body del webhook. El gateway valida que coincida con `EVOLUTION_API_KEY` antes de procesar el evento. Requests sin `apikey` válida → 401.

---

## Responsabilidades por capa

| Capa | Responsabilidad |
|---|---|
| **Bot** | Lógica de negocio, flujos de conversación, decisión de qué mensaje enviar |
| **Gateway** | Auth, rate limiting, logging, transformación de payloads, routing de webhooks al bot |
| **Evolution** | Gestión del protocolo WhatsApp, persistencia de mensajes, estado de conexiones |
| **PostgreSQL** | Almacenamiento permanente de mensajes, instancias, chats, contactos |
| **Redis** | Cache de estado de sesiones, reconexión rápida, deduplicación de eventos |

---

## Persistencia de sesiones

Evolution persiste las sesiones en el volumen `evolution_instances` (archivos de credenciales de Baileys) **y** en PostgreSQL (metadatos de instancia).

Para que una sesión sobreviva un reinicio completo del contenedor:
1. El volumen `evolution_instances` debe estar montado correctamente.
2. `DATABASE_SAVE_DATA_INSTANCE: "true"` debe estar activo (ya está en el docker-compose).
3. `CACHE_REDIS_SAVE_INSTANCES: "true"` permite reconexión rápida sin re-escanear QR.

**Test de persistencia:** Crear una instancia, escanear QR, correr `./scripts/reset.sh` **solo de Redis** (sin `-v`, solo reiniciando el contenedor), y verificar que Evolution reconecte automáticamente.

---

## Estrategia de rate limiting (Gateway)

| Scope | Límite sugerido | Ventana |
|---|---|---|
| Por `GATEWAY_API_KEY` global | 1000 req | 1 minuto |
| Por `instanceName` en envío de mensajes | 20 req | 1 segundo |
| Endpoint `/webhooks/*` (inbound) | Sin límite | — |

El rate limiting por instancia previene baneos de WhatsApp por flood de mensajes.

---

## Decisiones pendientes a resolver antes de Etapa 3

1. **¿El gateway es stateless o mantiene cache de instancias activas?**  
   Recomendación: stateless — consultar a Evolution para el estado. Agrega latencia pero evita inconsistencias.

2. **¿Los webhooks de Evolution van al gateway y este llama al bot, o el gateway actúa de buffer con cola?**  
   Para v1: llamada directa al bot. Si el bot no responde en 5s → log + reintentar 1 vez.

3. **¿Multi-instancia del gateway (load balancing)?**  
   No necesario en v1. El gateway es stateless, entonces es trivial escalar horizontalmente cuando sea necesario.
