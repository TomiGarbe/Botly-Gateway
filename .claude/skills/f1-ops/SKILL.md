---
name: f1-ops
description: Operación del servidor F1 de Botly (producción de Core y Gateway, y el entorno DEV) - acceso, rutas, salud, logs, recarga de variables y rollback. Usar cuando haya que diagnosticar o tocar lo desplegado. Toda acción en F1 requiere el OK del owner en el chat.
---

# Operación de F1 (Botly)

**Regla:** cualquier comando en F1 (incluso de lectura) se hace sólo con el OK explícito del owner en
el chat para esa operación. `ssh`/`scp` además piden confirmación técnica. Nunca imprimas `.env*` ni
secretos, ni corras `docker compose config`.

Referencias: `deploy/f1/README.md` (Core), `deploy/development/README.md` (DEV) y
`deploy/f1/README.md` del repo Botly-Gateway.

## Qué corre

| | Core | Gateway | DEV |
|---|---|---|---|
| Rama que despliega | `main` (`bot/**`) | `main` (`gateway/**`) | `develop` |
| Directorio | `/srv/botly/bot` | `/srv/botly/gateway` | ver README de DEV |
| Compose | `/srv/botly/compose` | ídem (servicio `gateway`) | propio |
| Health | `127.0.0.1:8000` | `127.0.0.1:9000/health` | `https://dev.botly.com.ar` |
| Contenedores | `botly-botly-api-1`, `botly-botly-postgres-1` | `botly-gateway-1` | |

El panel se publica aparte (`.github/workflows/deploy.yml`, en `main` con `panel_admin/**`).
`botly-api` y `gateway` los supervisa systemd dentro de la WSL (`botly-core.service`,
`botly-gateway.service`); el servicio del compose es `gateway`, no `botly-gateway`.

## Acceso

- Desde sesiones en la nube: `ssh f1` (túnel de Cloudflare, usuario `claude-cloud`, grupo `docker`,
  sin sudo).
- Desde la máquina del owner: ver "Acceso al servidor" en `deploy/f1/README.md`. Docker CE corre
  dentro de la WSL de F1 (no Docker Desktop).

## Recetas

- Logs del deploy: en la corrida de GitHub Actions ("Deploy backend (F1)" / "Deploy gateway").
- Recargar variables tras editar el env (lo edita el owner): `docker compose up -d <servicio>` desde
  `/srv/botly/compose`; `restart` **no** relee el `env_file`.
- Rollback: preferir revertir en `main` y redeployar; el deploy deja tags `rollback-*` y backups en
  `/srv/backups/` y `/srv/botly/_predeploy_backup/`. Las migraciones no se revierten solas. Nunca
  recrear el contenedor de Postgres ni borrar su volumen.

## Lo que no se hace

- Ejecutar `botly-deploy-backend` / `botly-deploy-gateway` a mano (bloqueado, H-05) salvo emergencia
  autorizada.
- Migraciones contra la base de producción o de DEV fuera del pipeline.
- Seeds o scripts de datos contra F1 (`reconcile_jd_media_f1`, `provision_gateway_tenant`, etc.).
