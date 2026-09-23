#!/usr/bin/env bash
# Instala el runner exclusivo de Botly Gateway dentro de WSL Ubuntu-24.04.
set -euo pipefail

REPO_URL="https://github.com/TomiGarbe/Botly-Gateway"
RUNNER_USER=github-runner
RUNNER_HOME=/opt/actions-runner-gateway
RUNNER_NAME=f1-gateway
RUNNER_LABELS=f1-botly-gateway
DEPLOY_BIN=/usr/local/sbin/botly-deploy-gateway
SUDOERS_FILE=/etc/sudoers.d/botly-deploy-gateway
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Correr como root dentro de Ubuntu-24.04." >&2; exit 1; }
[ -f "$HERE/botly-deploy-gateway.sh" ] || { echo "Falta botly-deploy-gateway.sh junto al instalador." >&2; exit 1; }

echo "== 1. Instalar la frontera privilegiada"
install -m 0755 -o root -g root "$HERE/botly-deploy-gateway.sh" "$DEPLOY_BIN"

echo "== 2. Usuario sin privilegios del runner"
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$RUNNER_USER" --shell /bin/bash "$RUNNER_USER"

echo "== 3. Sudoers dedicado al unico binario permitido"
sudoers_tmp="$(mktemp)"
trap 'rm -f -- "$sudoers_tmp"' EXIT
printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNNER_USER" "$DEPLOY_BIN" > "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install -m 0440 -o root -g root "$sudoers_tmp" "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null
rm -f -- "$sudoers_tmp"
trap - EXIT

if [ -f "$RUNNER_HOME/.runner" ]; then
  echo "== Runner ya registrado: solo se actualizaron el script root y sudoers."
  exit 0
fi

echo "== 4. Descargar la ultima version del runner y verificar SHA-256"
apt-get update >/dev/null
apt-get install -y --no-install-recommends curl tar git ca-certificates python3 sudo >/dev/null
release_json="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
version="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].removeprefix("v"))' <<<"$release_json")"
asset_name="actions-runner-linux-x64-$version.tar.gz"
expected_sha="$(ASSET_NAME="$asset_name" python3 -c '
import json, os, re, sys
release = json.load(sys.stdin)
name = os.environ["ASSET_NAME"]
asset = next((item for item in release.get("assets", []) if item.get("name") == name), {})
digest = str(asset.get("digest") or "")
if re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
    print(digest.split(":", 1)[1].lower())
else:
    match = re.search(r"<!-- BEGIN SHA linux-x64 -->([0-9a-fA-F]{64})<!-- END SHA linux-x64 -->", release.get("body") or "")
    print(match.group(1).lower() if match else "")
' <<<"$release_json")"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "GitHub no publico un SHA-256 verificable para $asset_name." >&2; exit 1; }

mkdir -p -- "$RUNNER_HOME"
archive="$RUNNER_HOME/$asset_name"
if [ -f "$archive" ] && printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c --status; then
  echo "Paquete ya descargado y verificado; se reutiliza."
else
  rm -f -- "$archive"
  curl -fsSL -o "$archive" "https://github.com/actions/runner/releases/download/v$version/$asset_name"
fi
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$RUNNER_HOME"
rm -f -- "$archive"
"$RUNNER_HOME/bin/installdependencies.sh" >/dev/null
chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME"

echo "== 5. Registrar el runner independiente en $REPO_URL"
read -rsp "Token de registro: " token
echo
runuser -u "$RUNNER_USER" -- "$RUNNER_HOME/config.sh" --unattended \
  --url "$REPO_URL" --token "$token" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --replace
unset token

echo "== 6. Instalar y arrancar su propio servicio systemd"
cd "$RUNNER_HOME"
./svc.sh install "$RUNNER_USER"
./svc.sh start
./svc.sh status | head -5

echo
echo "Listo: '$RUNNER_NAME' debe aparecer Online con el label '$RUNNER_LABELS'."
