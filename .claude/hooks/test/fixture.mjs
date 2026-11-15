// Repositorio git temporal para las pruebas unitarias (fuera de Rivo, en el temp del sistema).
// Contiene marcadores falsos: ningún secreto real.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CANARY = 'CANARY_FAKE_NOT_A_SECRET';

function g(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function w(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let cached = null;

export function makeFixture() {
  if (cached) return cached;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botly-guard-fixture-'));
  g(root, 'init', '-q', '-b', 'nocontrols');
  w(root, 'README.md', '# fixture\n');
  w(root, '.gitignore', '.env*\n!.env*.example\nbackend/secrets/\n*.pem\n*.key\n');
  w(root, 'backend/start.sh', '#!/bin/sh\nif [ "$RUN_MIGRATIONS_ON_START" = 1 ]; then alembic upgrade head; fi\nexec uvicorn app.main:app\n');
  w(root, 'backend/app/main.py', 'print("app")\n');
  w(root, 'docs/MODULO_02_HANDOFF.md', 'doc\n');
  w(root, 'deploy/f1/botly-deploy-backend.sh', '#!/bin/sh\necho deploy\n');
  w(root, 'scripts/ok.sh', '#!/bin/sh\necho hola\n');
  w(root, 'scripts/evil.sh', '#!/bin/sh\ngit push --force origin main\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'base sin controles');
  g(root, 'checkout', '-q', '-b', 'controls');
  w(root, '.claude/settings.json', '{}\n');
  w(root, '.claude/hooks/guard.mjs', '// fixture\n');
  w(root, 'CLAUDE.md', '# fixture\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'controles');
  // Archivos sensibles falsos (ignorados por git).
  w(root, '.env', `X=${CANARY}\n`);
  w(root, '.env.local', `X=${CANARY}\n`);
  w(root, '.env.example', 'X=\n');
  w(root, 'backend/.env.docker.example', 'X=\n');
  w(root, 'backend/.env', `X=${CANARY}\n`);
  w(root, 'backend/secrets/sa.json', `{"k":"${CANARY}"}\n`);
  w(root, 'certs/server.pem', CANARY);
  w(root, 'certs/server.key', CANARY);
  w(root, '.claude/launch.json', `{"x":"${CANARY}"}\n`);
  // Un control sin commitear, para git stash -u.
  w(root, '.claude/rules/governance.md', 'reglas\n');
  cached = root;
  return root;
}
