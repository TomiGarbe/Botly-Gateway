// D-7 acotado (AG-13, piloto E4): un subagente escribe con Edit/Write/MultiEdit/NotebookEdit sólo
// dentro de su worktree de `.claude/worktrees/<nombre>/`, bajo gateway/app o gateway/tests, nunca en
// rutas reservadas (.git, .claude, CLAUDE.md, CLAUDE.local.md, .mcp.json) ni con alias de NTFS.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide } from '../lib/decide.mjs';
import { makeFixture } from './fixture.mjs';

const root = makeFixture();
const wt = path.join(root, '.claude', 'worktrees', 'wt1');
const wt2 = path.join(root, '.claude', 'worktrees', 'wt2');
fs.mkdirSync(path.join(wt, 'gateway', 'app'), { recursive: true });
fs.mkdirSync(wt2, { recursive: true });
const gitBash = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

const sub = (tool_name, file_path, cwd) => ({
  tool_name,
  tool_input: tool_name === 'NotebookEdit' ? { notebook_path: file_path, new_source: '' } : { file_path, content: '', old_string: 'a', new_string: 'b', edits: [] },
  agent_id: 'sub1',
  cwd,
});

const typed = (agent_type, file_path) => ({ ...sub('Edit', file_path, wt), agent_type });

// [descripción, input, decisión esperada, regla esperada]
const CASES = [
  // Permitidos: dentro del propio worktree y del alcance del piloto.
  ['Edit relativo en gateway/app', sub('Edit', 'gateway/app/main.py', wt), 'allow'],
  ['Write absoluto en gateway/app', sub('Write', path.join(wt, 'gateway', 'app', 'nuevo.py'), wt), 'allow'],
  ['Write en gateway/tests desde el subdirectorio backend', sub('Write', 'tests/test_x.py', path.join(wt, 'gateway')), 'allow'],
  ['MultiEdit en gateway/app', sub('MultiEdit', 'gateway/app/main.py', wt), 'allow'],
  ['NotebookEdit en gateway/app', sub('NotebookEdit', 'gateway/app/a.ipynb', wt), 'allow'],
  ['ruta estilo Git Bash dentro del alcance', sub('Edit', gitBash(path.join(wt, 'gateway', 'app', 'x.py')), wt), 'allow'],
  ['mayúsculas distintas dentro del alcance', sub('Edit', 'GATEWAY/App/x.py', wt), 'allow'],

  // Negados: fuera de un worktree.
  ['subagente en la raíz del proyecto', sub('Edit', 'README.md', root), 'deny', 'D-7'],
  ['subagente con cwd = .claude/worktrees', sub('Write', 'x.md', path.join(root, '.claude', 'worktrees')), 'deny', 'D-7'],
  ['subagente con cwd fuera del proyecto', sub('Write', 'x.md', path.dirname(root)), 'deny', 'D-7'],
  ['cwd parecido: .claude/worktrees-x', sub('Write', 'gateway/app/x.py', path.join(root, '.claude', 'worktrees-x', 'a')), 'deny', 'D-7'],
  ['ruta absoluta al checkout principal', sub('Edit', path.join(root, 'gateway', 'app', 'main.py'), wt), 'deny', 'D-7'],
  ['salida por ../ al checkout principal', sub('Edit', '../../../gateway/app/main.py', wt), 'deny', 'D-7'],
  ['otro worktree', sub('Write', path.join(wt2, 'gateway', 'app', 'a.py'), wt), 'deny', 'D-7'],
  ['cwd con .. que apunta a otro worktree', sub('Write', 'gateway/app/a.py', path.join(wt, '..', 'wt2')), 'allow'],
  ['la raíz del worktree misma', sub('Write', wt, wt), 'deny', 'D-7'],
  ['sin ruta', { tool_name: 'Write', tool_input: { content: '' }, agent_id: 'sub1', cwd: wt }, 'deny', 'D-7'],
  ['ruta vacía', sub('Write', '', wt), 'deny', 'D-7'],
  ['ruta UNC', sub('Write', '\\\\host\\c$\\x.py', wt), 'deny', 'D-7'],
  ['ruta de dispositivo \\\\?\\', sub('Write', `\\\\?\\${path.join(wt, 'gateway', 'app', 'x.py')}`, wt), 'deny', 'D-7'],

  // Negados: fuera del alcance del piloto dentro del worktree.
  ['.gitignore del worktree', sub('Edit', '.gitignore', wt), 'deny', 'D-7'],
  ['migraciones', sub('Write', 'gateway/migrations/versions/x.py', wt), 'deny', 'D-7'],
  ['workflow de CI', sub('Write', '.github/workflows/deploy-backend.yml', wt), 'deny', 'D-7'],
  ['deploy', sub('Write', 'deploy/f1/x.sh', wt), 'deny', 'D-7'],
  ['start.sh del backend', sub('Edit', 'gateway/start.sh', wt), 'deny', 'D-7'],
  ['frontend/scripts (fuera de toda unión)', sub('Edit', 'frontend/scripts/x.js', wt), 'deny', 'D-7'],
  ['frontend/package.json', sub('Edit', 'frontend/package.json', wt), 'deny', 'D-7'],

  // Alcance por tipo de agente (AG-15). Sin agent_type rige la unión de alcances.
  ['sin tipo: frontend/src entra en la unión', sub('Edit', 'frontend/src/x.ts', wt), 'allow'],
  ['backend-implementer en gateway/app', typed('backend-implementer', 'gateway/app/x.py'), 'allow'],
  ['backend-implementer en frontend/src', typed('backend-implementer', 'frontend/src/x.ts'), 'deny', 'D-7'],
  ['frontend-implementer en frontend/src (index)', typed('frontend-implementer', 'frontend/src/index.tsx'), 'allow'],
  ['frontend-implementer en frontend/src', typed('frontend-implementer', 'frontend/src/x.tsx'), 'allow'],
  ['frontend-implementer en gateway/app', typed('frontend-implementer', 'gateway/app/x.py'), 'deny', 'D-7'],
  ['frontend-implementer en frontend/vite.config.ts', typed('frontend-implementer', 'frontend/vite.config.ts'), 'deny', 'D-7'],
  ['tipo desconocido (general-purpose)', typed('general-purpose', 'gateway/app/x.py'), 'deny', 'D-7'],
  ['tipo code-reviewer', typed('code-reviewer', 'gateway/app/x.py'), 'deny', 'D-7'],
  ['documento skip-worktree', sub('Edit', 'docs/MODULO_02_HANDOFF.md', wt), 'deny', 'D-7'],

  // Negados: rutas reservadas a cualquier profundidad.
  ['CLAUDE.md del worktree', sub('Edit', 'CLAUDE.md', wt), 'deny', 'D-7'],
  ['CLAUDE.md anidado', sub('Write', 'gateway/app/CLAUDE.md', wt), 'deny', 'D-7'],
  ['CLAUDE.local.md anidado', sub('Write', 'gateway/tests/claude.LOCAL.md', wt), 'deny', 'D-7'],
  ['.mcp.json anidado', sub('Write', 'gateway/app/.mcp.json', wt), 'deny', 'D-7'],
  ['.git anidado', sub('Write', 'gateway/app/x/.git/config', wt), 'deny', 'D-7'],
  ['.GIT con mayúsculas', sub('Write', 'gateway/tests/.GIT/hooks/x', wt), 'deny', 'D-7'],
  ['.claude anidado', sub('Write', 'gateway/app/.claude/settings.json', wt), 'deny', 'D-7'],
  ['hooks del worktree', sub('Write', '.claude/hooks/guard.mjs', wt), 'deny', 'D-7'],
  ['.git del worktree', sub('Write', '.git', wt), 'deny', 'D-7'],

  // Negados: alias de NTFS.
  ['flujo alternativo ::$DATA', sub('Write', 'gateway/app/CLAUDE.md::$DATA', wt), 'deny', 'D-7'],
  ['flujo alternativo en archivo común', sub('Write', 'gateway/app/x.py:oculto', wt), 'deny', 'D-7'],
  ['flujo alternativo en ruta absoluta', sub('Write', `${path.join(wt, 'gateway', 'app', 'x.py')}:s`, wt), 'deny', 'D-7'],
  ['nombre corto 8.3', sub('Write', 'gateway/app/CLAUDE~1.MD', wt), 'deny', 'D-7'],
  ['carpeta 8.3', sub('Write', 'gateway/app/GIT~1/config', wt), 'deny', 'D-7'],
  ['punto final', sub('Write', 'gateway/app/CLAUDE.md.', wt), 'deny', 'D-7'],
  ['espacio final', sub('Write', 'gateway/app/CLAUDE.md ', wt), 'deny', 'D-7'],
  ['carpeta con punto final', sub('Write', 'gateway/app/.claude./x', wt), 'deny', 'D-7'],

  // Dentro del alcance siguen rigiendo los bloqueos de archivos sensibles.
  ['.env dentro del alcance', sub('Write', 'gateway/app/.env', wt), 'deny', 'SEC'],
  ['*.key dentro del alcance', sub('Write', 'gateway/tests/x.key', wt), 'deny', 'SEC'],
  ['*.pem dentro del alcance', sub('Write', 'gateway/app/certs/x.pem', wt), 'deny', 'SEC'],
];

for (const [label, input, expected, rule] of CASES) {
  test(`D-7 worktree: ${label} => ${expected}${rule ? ' ' + rule : ''}`, async () => {
    const r = await decide(input, { root });
    assert.equal(r.decision, expected, `${label} -> ${r.decision} [${r.rule ?? ''}] ${r.msg ?? ''}`);
    if (rule) assert.equal(r.rule, rule, `${label} -> regla ${r.rule} (${r.msg})`);
  });
}

test('D-7 worktree: sin CLAUDE_PROJECT_DIR (root = cwd del worktree) todo se niega', async () => {
  const r = await decide(sub('Edit', 'gateway/app/main.py', wt), { root: wt });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'D-7');
});

test('D-7 worktree: la lectura de un subagente no cambia', async () => {
  const ok = await decide({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'README.md') }, agent_id: 'sub1', cwd: wt }, { root });
  assert.equal(ok.decision, 'allow');
  const env = await decide({ tool_name: 'Read', tool_input: { file_path: path.join(wt, 'gateway', '.env') }, agent_id: 'sub1', cwd: wt }, { root });
  assert.equal(env.rule, 'SEC');
});

test('D-7 worktree: la sesión principal no se ve afectada', async () => {
  const r = await decide({ tool_name: 'Edit', tool_input: { file_path: 'README.md' }, cwd: root }, { root });
  assert.equal(r.decision, 'allow');
});

// Integración: el mismo criterio pasando por guard.mjs (raíz tomada de CLAUDE_PROJECT_DIR).
const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'guard.mjs');
const runGuard = (input) => spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', ...input }), encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: root },
});

test('D-7 worktree (guard.mjs): escritura en el alcance del worktree -> exit 0', () => {
  const r = runGuard(sub('Edit', 'gateway/app/main.py', wt));
  assert.equal(r.status, 0, r.stderr);
});

test('D-7 worktree (guard.mjs): escritura al checkout principal -> exit 2 con D-7', () => {
  const r = runGuard(sub('Edit', path.join(root, 'README.md'), wt));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /D-7/);
});
