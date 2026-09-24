#!/usr/bin/env bash
# Frontera privilegiada para desplegar exclusivamente el Gateway en F1.
# La copia instalada en /usr/local/sbin es la efectiva; modificar este archivo
# no cambia produccion hasta volver a ejecutar install-runner.sh como root.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "Uso: botly-deploy-gateway <sha> <release.tar>" >&2
  exit 2
fi

SHA="$1"
SOURCE_TAR="$2"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "SHA invalido." >&2; exit 2; }
[ -f "$SOURCE_TAR" ] && [ -r "$SOURCE_TAR" ] && [ ! -L "$SOURCE_TAR" ] \
  || { echo "El release no existe, no es legible o es un symlink." >&2; exit 2; }
SOURCE_TAR="$(realpath -e -- "$SOURCE_TAR")"
case "$SOURCE_TAR" in
  /opt/actions-runner-gateway/_work/_temp/*) ;;
  *) echo "El release debe estar dentro del directorio temporal del runner." >&2; exit 2 ;;
esac
[ "$(stat -c '%U' -- "$SOURCE_TAR")" = "github-runner" ] \
  || { echo "El release no pertenece al usuario del runner." >&2; exit 2; }

SHORT="${SHA:0:12}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT=/srv/botly
LIVE="$ROOT/gateway"
COMPOSE_DIR="$ROOT/compose"
STAGING="$ROOT/_deploy_staging/pipeline-gateway-$SHORT-$STAMP"
CODE_BACKUP="$ROOT/_predeploy_backup/pipeline-gateway-before-$SHORT-$STAMP"
IMAGE=botly-gateway
STABLE_TAG=local
STABLE_IMAGE="$IMAGE:$STABLE_TAG"
ROLLBACK_TAG="rollback-$STAMP"
KEEP=5

log() { echo "[deploy gateway $SHORT] $*"; }

validate_tar() {
  local archive="$1"
  tar -tf "$archive" >/dev/null
  python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, "r:*") as release:
    members = release.getmembers()
    if not members:
        raise SystemExit("Release vacio.")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (
            not member.name
            or member.name.startswith(("/", "\\"))
            or "\\" in member.name
            or path.is_absolute()
            or ".." in path.parts
            or member.issym()
            or member.islnk()
            or not (member.isfile() or member.isdir())
        ):
            raise SystemExit("Release con entrada insegura.")
PY
}

health_matches_release() {
  local body
  for _ in $(seq 1 60); do
    body="$(curl -fsS --max-time 5 http://127.0.0.1:9000/health 2>/dev/null || true)"
    if RELEASE_SHA="$SHA" RELEASE_VERSION="$STAMP" python3 -c '
import json, os, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
ok = (
    value.get("status") == "ok"
    and value.get("service") == "botly-gateway"
    and value.get("gitSha") == os.environ["RELEASE_SHA"]
    and value.get("version") == os.environ["RELEASE_VERSION"]
)
raise SystemExit(0 if ok else 1)
' <<<"$body"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

health_responds() {
  local body
  for _ in $(seq 1 40); do
    body="$(curl -fsS --max-time 5 http://127.0.0.1:9000/health 2>/dev/null || true)"
    if python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
service = value.get("service")
ok = value.get("status") == "ok" and service in {"botly-gateway", "evolution-gateway"}
raise SystemExit(0 if ok else 1)
' <<<"$body"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

rollback() {
  local reason="${1:-fallo no especificado}"
  trap - ERR INT TERM
  set +e
  log "FALLO ($reason): restaurando codigo e imagen anteriores."

  rm -rf -- "$LIVE"
  cp -a -- "$CODE_BACKUP" "$LIVE"
  local code_rc=$?
  docker image tag "$IMAGE:$ROLLBACK_TAG" "$STABLE_IMAGE"
  local image_rc=$?

  cd "$COMPOSE_DIR" || true
  docker compose up -d --no-deps --force-recreate --no-build gateway
  local compose_rc=$?

  if [ "$code_rc" -eq 0 ] && [ "$image_rc" -eq 0 ] && [ "$compose_rc" -eq 0 ] && health_responds; then
    log "Rollback OK: la version anterior del Gateway responde."
  else
    log "ROLLBACK SIN HEALTH: codigo_rc=$code_rc imagen_rc=$image_rc compose_rc=$compose_rc. Intervencion manual requerida."
  fi
  exit 1
}

cleanup() {
  local -a items tags
  local i
  set +e

  mapfile -t items < <(find "$ROOT/_deploy_staging" -mindepth 1 -maxdepth 1 -type d -name 'pipeline-gateway-*' -printf '%f\n' 2>/dev/null | sort -r)
  for ((i=KEEP; i<${#items[@]}; i++)); do
    rm -rf -- "$ROOT/_deploy_staging/${items[$i]}"
  done

  mapfile -t items < <(find "$ROOT/_predeploy_backup" -mindepth 1 -maxdepth 1 -type d -name 'pipeline-gateway-before-*' -printf '%f\n' 2>/dev/null | sort -r)
  for ((i=KEEP; i<${#items[@]}; i++)); do
    rm -rf -- "$ROOT/_predeploy_backup/${items[$i]}"
  done

  mapfile -t tags < <(docker image ls "$IMAGE" --format '{{.Tag}}' 2>/dev/null | grep -E '^rollback-[0-9]{8}T[0-9]{6}Z$' | sort -r)
  for ((i=KEEP; i<${#tags[@]}; i++)); do
    docker image rm "$IMAGE:${tags[$i]}" >/dev/null
  done
}

# Serializa ejecuciones del workflow y ejecuciones manuales del binario.
exec 9>/run/botly-deploy-gateway.lock
flock -w 3300 9 || { echo "Otro deploy sigue en curso despues de 55 minutos." >&2; exit 3; }
trap cleanup EXIT

log "1/6 Validar y preparar el release"
mkdir -p -- "$STAGING/src" "$ROOT/_predeploy_backup"
cp -- "$SOURCE_TAR" "$STAGING/release.tar"
validate_tar "$STAGING/release.tar"
tar --extract --file "$STAGING/release.tar" --directory "$STAGING/src" --no-same-owner --no-same-permissions
[ -f "$STAGING/src/Dockerfile" ] && [ -f "$STAGING/src/app/main.py" ] \
  || { log "Release incompleto; no se modifico produccion."; exit 1; }

log "2/6 Preflight de Compose, codigo e imagen actuales"
[ -d "$LIVE" ] || { log "No existe $LIVE; no se modifico produccion."; exit 1; }
[ -d "$COMPOSE_DIR" ] || { log "No existe $COMPOSE_DIR; no se modifico produccion."; exit 1; }
cd "$COMPOSE_DIR"
docker compose config --quiet
current_container="$(docker compose ps -q gateway)"
[ -n "$current_container" ] || { log "No hay un contenedor gateway activo; no se modifico produccion."; exit 1; }
configured_image="$(docker inspect --format '{{.Config.Image}}' "$current_container")"
[ "$configured_image" = "$STABLE_IMAGE" ] || {
  log "La imagen efectiva es '$configured_image', no '$STABLE_IMAGE'. Reconciliar Compose antes de desplegar."
  exit 1
}
current_image_id="$(docker inspect --format '{{.Image}}' "$current_container")"
[ -n "$current_image_id" ] || { log "No se pudo identificar la imagen actual."; exit 1; }

log "3/6 Respaldar codigo e imagen actuales"
cp -a -- "$LIVE" "$CODE_BACKUP"
docker image tag "$current_image_id" "$IMAGE:$ROLLBACK_TAG"

trap 'rollback "error en reemplazo, build o recreacion"' ERR
trap 'rollback "interrupcion"' INT TERM

log "4/6 Reemplazar exclusivamente $LIVE"
rm -rf -- "$LIVE"
cp -a -- "$STAGING/src" "$LIVE"

# Los .env no pertenecen al artefacto Git. Si hubiera alguno dentro del arbol
# legado, se recupera desde el backup sin mostrar nombres ni contenidos.
while IFS= read -r -d '' env_file; do
  relative="${env_file#"$CODE_BACKUP"/}"
  mkdir -p -- "$LIVE/$(dirname "$relative")"
  cp -a -- "$env_file" "$LIVE/$relative"
done < <(find "$CODE_BACKUP" -type f \( -name '.env' -o -name '.env.*' \) -print0)

log "5/6 Construir y recrear solamente gateway"
cd "$COMPOSE_DIR"
GATEWAY_GIT_SHA="$SHA" GATEWAY_BUILD_VERSION="$STAMP" docker compose build gateway
docker compose up -d --no-deps --force-recreate gateway

log "6/6 Verificar health, SHA y label OCI"
health_matches_release || rollback "health no publico la release esperada"
current_container="$(docker compose ps -q gateway)"
[ -n "$current_container" ] || rollback "Compose no informa un contenedor gateway activo"
revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$current_container")"
[ "$revision" = "$SHA" ] || rollback "label OCI revision distinto del SHA desplegado"

trap - ERR INT TERM
log "OK: Gateway saludable con revision $revision y version $STAMP."
exit 0
