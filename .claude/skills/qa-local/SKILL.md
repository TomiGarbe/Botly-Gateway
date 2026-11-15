---
name: qa-local
description: Probar Botly Gateway en local con base descartable (Postgres en Docker, tests del gateway, build del frontend). Usar antes de correr pytest del gateway o verificar un cambio del frontend en el Browser pane.
---

# QA local de Botly Gateway

Todo contra servicios **locales y descartables**. Nunca contra F1, producción, la Evolution API real
ni la API de Meta.

## 1. Base descartable

Igual que la CI (`.github/workflows/deploy-gateway.yml`):

```bash
docker run -d --rm --name gateway-pg-test -e POSTGRES_USER=gateway -e POSTGRES_PASSWORD=ci-only-postgres -e POSTGRES_DB=gateway_test -p 127.0.0.1:15433:5432 postgres:17
```

`--rm` hace que se borre al pararla (`docker stop gateway-pg-test`).

## 2. Tests del gateway

Desde `gateway/`, con valores sólo de prueba (los mismos que la CI; no son secretos):

```bash
DEBUG=false GATEWAY_API_KEY=ci-only-gateway-key EVOLUTION_API_KEY=ci-only-evolution-key GATEWAY_TEST_DATABASE_URL=postgresql://gateway:ci-only-postgres@127.0.0.1:15433/gateway_test python -m pytest -q
```

La CI además crea `/var/lib/botly` para el almacenamiento de medios; si un test de medios falla por
esa ruta, reportalo en vez de crearla con permisos de administrador.

## 3. Frontend

Desde `frontend/`: `npm run build` (`tsc && vite build`) y `npm test` (vitest).

## Lo que no se hace

- `scripts/reset.sh` borra volúmenes (DB, Redis, instancias de WhatsApp): sólo con OK del owner.
- No uses `config/.env` (no se lee) ni el compose de `docker/` apuntado a servicios reales.
