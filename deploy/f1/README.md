# CI/CD del Gateway en F1

El workflow `.github/workflows/deploy-gateway.yml` prueba el backend en un
runner hospedado por GitHub y, solo si la suite pasa, entrega un artefacto al
runner dedicado que vive dentro de WSL `Ubuntu-24.04` en F1. La conexion sale
desde F1 hacia GitHub; no se publican puertos del runner ni se guardan claves
SSH del servidor en el repositorio.

El frontend conserva su workflow independiente de Azure Static Web Apps. Este
pipeline no lo construye ni lo despliega.

## Triggers y tests

El pipeline se dispara:

- con un push a `main` que cambie `gateway/**` o el propio workflow;
- manualmente mediante *Actions -> Deploy gateway (F1) -> Run workflow*.

El job `test` usa Ubuntu, Python 3.12 y cache de pip. Instala las dependencias
pinneadas de `gateway/requirements-dev.txt` (que incluye las de runtime) y
ejecuta `python -m pytest -q` desde `gateway/`. Pytest no entra en la imagen de
produccion: el Dockerfile instala solamente `requirements.txt`.

No se debe agregar `pull_request` como trigger de este workflow. El job de
deploy corre dentro de F1 y jamas debe ejecutar codigo proveniente de un PR.

## Flujo de cada deploy

1. GitHub empaqueta exactamente `gateway/` del `$GITHUB_SHA` con `git archive`.
2. El runner espera el lock `/run/botly-deploy-gateway.lock` e invoca solamente
   `sudo -n /usr/local/sbin/botly-deploy-gateway <sha> <release.tar>`.
3. El binario root copia y valida el tar (incluido path traversal) y lo extrae
   bajo `/srv/botly/_deploy_staging/pipeline-gateway-*`.
4. Antes de mutar, valida Compose y confirma que la imagen efectiva es
   `botly-gateway:local`. Esta coincide con `docker/docker-compose.yml`; si F1
   difiere, el deploy aborta y hay que reconciliar Compose expresamente.
5. Respalda `/srv/botly/gateway` en
   `/srv/botly/_predeploy_backup/pipeline-gateway-before-*` y etiqueta la
   imagen activa como `botly-gateway:rollback-*`.
6. Reemplaza solo `/srv/botly/gateway`, preserva cualquier `.env` legado y,
   desde `/srv/botly/compose`, construye y recrea exclusivamente `gateway`.
7. Espera `http://127.0.0.1:9000/health` y verifica `status`, `service`,
   `version`, `gitSha` y el label OCI `org.opencontainers.image.revision`.

El build recibe `GATEWAY_GIT_SHA` y `GATEWAY_BUILD_VERSION`. El Dockerfile los
conserva como variables de entorno y labels OCI; `/health` los publica como
`gitSha` y `version`.

### Estado legado observado en F1

El preflight de solo lectura del 2026-09-23 encontro que el Compose instalado
en F1 usaba el servicio `botly-gateway`, la imagen
`botly-botly-gateway` y el contenedor `botly-gateway`. Tambien publica metadata
`unknown` en `/health`. Eso no coincide con el contrato objetivo de este repo:
servicio `gateway`, imagen `botly-gateway:local` y contenedor
`botly-gateway-1`.

La configuracion se reconcilio el 2026-09-23 sin reconstruir codigo: se
reetiqueto la imagen activa, se preservo `botly_gateway_data` y se recreo
solamente el Gateway. La metadata seguira en `unknown` hasta el primer deploy
trazable. El backup previo quedo en `/srv/botly/compose/` con el patron
`docker-compose.yml.before-gateway-reconcile-*` y la imagen anterior con el
tag `pre-reconcile-*`.

La reconciliacion conserva `botly-gateway` como alias DNS en `botly-net`, ya
que Botly API usa ese hostname en `GATEWAY_INTERNAL_URL`; el nombre del servicio
Compose pasa a ser `gateway` sin romper el trafico interno existente.

### Persistencia, backup y rollback

El pipeline no toca `/srv/botly/config`, archivos `.env` ni volumenes Docker.
`gateway_data` sigue montado en `/var/lib/botly`, por lo que recrear el
contenedor no elimina estado. Tampoco reinicia ni recrea Evolution, PostgreSQL,
Redis o Botly API.

Si falla el reemplazo, build, recreate, health o la revision OCI, el script
restaura codigo e imagen anteriores y recrea solamente `gateway`, sin build.
Informa separadamente si el rollback tampoco queda healthy. Conserva los cinco
staging, backups y tags `rollback-*` mas recientes creados por este pipeline;
no borra artefactos con otros nombres.

## Instalar el segundo runner

En GitHub, abrir *Settings -> Actions -> Runners -> New self-hosted runner* y
generar un token para este repositorio. Vence rapidamente: usarlo al ejecutar
el instalador. Desde PowerShell, copiar los tres archivos a Windows y entrar a
la WSL de produccion por SSH (ajustar usuario, host y clave):

```powershell
$key = Join-Path $env:USERPROFILE '.ssh\claude-migracion-server'
$hostName = 'crist@100.82.151.84'
ssh -i $key $hostName "wsl -d Ubuntu-24.04 -u root -- mkdir -p /mnt/c/srv/_bootstrap/gateway"
scp -i $key deploy\f1\botly-deploy-gateway.sh deploy\f1\install-runner.sh deploy\f1\README.md "${hostName}:C:/srv/_bootstrap/gateway/"
ssh -t -i $key $hostName "wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/srv/_bootstrap/gateway/install-runner.sh"
```

El instalador solicita el token sin eco y no lo persiste. Crea/reutiliza el
usuario sin privilegios `github-runner`, instala el runner en
`/opt/actions-runner-gateway`, lo registra como `f1-gateway` con label
`f1-botly-gateway` e instala su propio servicio systemd. No altera el runner de
Botly que vive en `/opt/actions-runner`.

Si el Gateway ya esta registrado, volver a correr `install-runner.sh` actualiza
solamente `/usr/local/sbin/botly-deploy-gateway` y su sudoers. Los cambios al
script versionado **no** actualizan la copia root por medio del workflow; esa
reinstalacion manual es deliberada.

## Configurar el environment

En *Settings -> Environments*, crear o abrir `production`, agregar los
*Required reviewers* y deshabilitar autoaprobaciones si la politica lo exige.
El job muestra como URL `https://gateway-server.botly.com.ar` y espera la
aprobacion antes de ocupar el runner F1.

## Verificacion operativa

Dentro de `Ubuntu-24.04`:

```bash
systemctl list-units 'actions.runner.TomiGarbe-Botly-Gateway.*'
systemctl status 'actions.runner.TomiGarbe-Botly-Gateway.*'
sudo -u github-runner sudo -n -l
cd /srv/botly/compose
docker compose ps gateway
docker inspect --format '{{.Name}} {{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' botly-gateway-1
curl -fsS http://127.0.0.1:9000/health
```

El contenedor debe ser `botly-gateway-1`, la imagen `botly-gateway:local` y el
`gitSha` del health debe coincidir con el SHA mostrado en Actions y con el label
OCI.

## Rollback manual

La opcion preferida es ejecutar manualmente el workflow seleccionando el ref
anterior: vuelve a pasar tests y genera un artefacto trazable. Si el pipeline no
esta disponible, un operador root puede restaurar un par backup/tag coincidente
bajo el mismo lock (reemplazar los placeholders y verificar las rutas antes):

```bash
sudo -i
exec 9>/run/botly-deploy-gateway.lock
flock -n 9
test -d /srv/botly/_predeploy_backup/pipeline-gateway-before-<sha>-<timestamp>
rm -rf /srv/botly/gateway
cp -a /srv/botly/_predeploy_backup/pipeline-gateway-before-<sha>-<timestamp> /srv/botly/gateway
docker image tag botly-gateway:rollback-<timestamp> botly-gateway:local
cd /srv/botly/compose
docker compose up -d --no-deps --force-recreate --no-build gateway
curl -fsS http://127.0.0.1:9000/health
```

No usar Docker Desktop: todos los comandos Docker de produccion se ejecutan en
WSL `Ubuntu-24.04`.
