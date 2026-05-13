"""
Genera config/.env con todas las claves de seguridad ya completadas.
Las variables con valores fijos (puertos, nombres de DB) se copian del .env.example.

Uso:
    python scripts/generate_env.py
    python scripts/generate_env.py --force   # sobreescribe si ya existe
"""

import argparse
import secrets
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
ENV_EXAMPLE = REPO_ROOT / "config" / ".env.example"
ENV_OUT     = REPO_ROOT / "config" / ".env"


def gen_hex(n: int = 32) -> str:
    return secrets.token_hex(n)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Sobreescribir si ya existe")
    args = parser.parse_args()

    if ENV_OUT.exists() and not args.force:
        print(f"Ya existe {ENV_OUT.relative_to(REPO_ROOT)}")
        print("Usá --force para sobreescribir, o editalo manualmente.")
        sys.exit(0)

    pg_pass    = gen_hex(16)
    redis_pass = gen_hex(16)
    pg_user    = "evolution_user"
    pg_db      = "evolution"

    keys = {
        "EVOLUTION_API_KEY": gen_hex(32),
        "POSTGRES_PASSWORD": pg_pass,
        "REDIS_PASSWORD":    redis_pass,
        "GATEWAY_API_KEY":   gen_hex(32),
        # URLs compuestas — deben usar el hostname "postgres"/"redis" (nombre del servicio Docker)
        "DATABASE_URL": f"postgresql://{pg_user}:{pg_pass}@postgres:5432/{pg_db}?schema=public",
        "REDIS_URI":    f"redis://:{redis_pass}@redis:6379",
    }

    # Leer el .env.example y reemplazar los placeholders con las claves generadas
    template = ENV_EXAMPLE.read_text(encoding="utf-8")
    output_lines = []

    for line in template.splitlines():
        replaced = False
        for var, value in keys.items():
            if line.startswith(f"{var}="):
                output_lines.append(f"{var}={value}")
                replaced = True
                break
        if not replaced:
            output_lines.append(line)

    ENV_OUT.write_text("\n".join(output_lines) + "\n", encoding="utf-8")

    print(f"✓ Generado: {ENV_OUT.relative_to(REPO_ROOT)}\n")
    print("  Claves generadas:")
    for var, value in keys.items():
        print(f"    {var:<22} = {value}")
    print()
    print("  Variables que podés editar si querés:")
    print("    POSTGRES_DB, POSTGRES_USER   — nombre y usuario de la base de datos")
    print("    EVOLUTION_PORT               — puerto de Evolution (default: 8080)")
    print("    GATEWAY_PORT                 — puerto del gateway   (default: 9000)")
    print("    BOT_WEBHOOK_URL              — URL del bot para recibir webhooks (dejar vacío por ahora)")
    print()
    print("  Listo para levantar:")
    print("    ./scripts/start.sh   (Linux/Mac)")
    print("    docker compose -f docker/docker-compose.yml --env-file config/.env up -d   (Windows)")


if __name__ == "__main__":
    main()
