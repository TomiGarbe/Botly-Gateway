// P-U (proceso real): exit codes del hook, fallo cerrado y ConfigChange.
import './env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../config-guard.mjs';
import { makeFixture } from './fixture.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = makeFixture();

function run(script, stdin, env = {}) {
  return spawnSync(process.execPath, [script], {
    input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env }, timeout: 60000,
  });
}
const guard = path.join(HOOKS, 'guard.mjs');
const cfg = path.join(HOOKS, 'config-guard.mjs');
const ev = (tool, input) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: root, permission_mode: 'bypassPermissions' });

test('bloqueo: exit 2 y motivo por stderr', () => {
  const r = run(guard, ev('Bash', { command: 'git push --force' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BLOQUEADO \[H-01\]/);
});

test('permitido: exit 0 sin salida', () => {
  const r = run(guard, ev('Bash', { command: 'git status' }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('confirmación: exit 0 con permissionDecision ask', () => {
  const r = run(guard, ev('mcp__72d3659d-903c-4430-8524-74c65b254d66__update_flag', {}));
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'ask');
});

test('fallo cerrado: JSON inválido -> exit 2', () => {
  const r = run(guard, '{no es json');
  assert.equal(r.status, 2);
});

test('fallo cerrado: stdin vacío -> exit 2', () => {
  const r = run(guard, '');
  assert.equal(r.status, 2);
});

test('fallo cerrado: Bash sin comando -> exit 2', () => {
  const r = run(guard, ev('Bash', {}));
  assert.equal(r.status, 2);
});

test('herramienta desconocida no MCP -> exit 0', () => {
  const r = run(guard, ev('TodoWrite', { todos: [] }));
  assert.equal(r.status, 0);
});

test('PowerShell real (ps-parse.ps1) -> exit 2 en force push', () => {
  const r = run(guard, ev('PowerShell', { command: 'git push -f' }));
  assert.equal(r.status, 2);
});

test('fallo cerrado: vendor alterado (hash distinto) -> exit 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rivo-guard-tamper-'));
  fs.cpSync(HOOKS, tmp, { recursive: true, filter: (s) => !s.includes(`${path.sep}test${path.sep}`) });
  const wasm = path.join(tmp, 'vendor', 'tree-sitter-bash', 'tree-sitter-bash.wasm');
  const b = fs.readFileSync(wasm); b[b.length - 1] ^= 0xff; fs.writeFileSync(wasm, b);
  const r = run(path.join(tmp, 'guard.mjs'), ev('Bash', { command: 'git status' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GUARD-ERROR/);
});

// R-28: powershell.exe inaccesible sólo vía PATH (libuv busca en cwd y PATH). No se toca SystemRoot:
// sin él node 24 aborta al iniciar (exit 134, "Assertion failed: ncrypto::CSPRNG") antes de correr el
// hook, y la prueba dependía de si el entorno heredado escribía SYSTEMROOT o SystemRoot.
function envWithout(names, extra) {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k.toLowerCase())));
  return { ...base, CLAUDE_PROJECT_DIR: root, ...extra };
}
test('fallo cerrado: powershell.exe inaccesible -> exit 2', () => {
  const r = spawnSync(process.execPath, [guard], {
    input: ev('PowerShell', { command: 'git status' }), encoding: 'utf8', timeout: 60000,
    env: envWithout(['PATH'], { PATH: path.dirname(process.execPath) }),
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /GUARD-ERROR/);
  assert.match(r.stderr, /ENOENT/);
});
test('R-28 regresión: el entorno de la prueba no duplica claves por mayúsculas ni rompe SystemRoot', () => {
  const env = envWithout(['PATH'], { PATH: 'x' });
  const keys = Object.keys(env).map((k) => k.toLowerCase());
  assert.equal(keys.filter((k) => k === 'path').length, 1);
  const sr = Object.entries(env).find(([k]) => k.toLowerCase() === 'systemroot');
  assert.ok(sr && fs.existsSync(sr[1]), 'SystemRoot heredado y válido');
});

test('rendimiento: Bash < 2 s, PowerShell < 5 s', () => {
  let t = Date.now(); run(guard, ev('Bash', { command: 'git status && ls' })); const b = Date.now() - t;
  t = Date.now(); run(guard, ev('PowerShell', { command: 'git status' })); const p = Date.now() - t;
  assert.ok(b < 2000, `bash ${b} ms`);
  assert.ok(p < 5000, `powershell ${p} ms`);
});

// ---- ConfigChange ----
const tpl = fs.readFileSync(path.join(HOOKS, 'settings.template.json'), 'utf8');

test('config-guard: la plantilla completa se acepta', () => {
  assert.equal(evaluate('project_settings', 'x', tpl), null);
});
test('config-guard: disableAllHooks true en local -> bloquea', () => {
  assert.match(evaluate('local_settings', 'x', '{"disableAllHooks":true}'), /disableAllHooks/);
});
test('config-guard: disableAllHooks true en user -> bloquea', () => {
  assert.match(evaluate('user_settings', 'x', '{"disableAllHooks":true}'), /disableAllHooks/);
});
test('config-guard: allow nuevo en local (don\'t ask again) -> se acepta', () => {
  assert.equal(evaluate('local_settings', 'x', '{"permissions":{"allow":["Bash(npm test)"]}}'), null);
});
test('config-guard: project sin una regla deny -> bloquea', () => {
  const j = JSON.parse(tpl); j.permissions.deny = j.permissions.deny.filter((r) => r !== 'Read(.env*)');
  assert.match(evaluate('project_settings', 'x', JSON.stringify(j)), /deny/);
});
test('config-guard: project sin hook PreToolUse -> bloquea', () => {
  const j = JSON.parse(tpl); delete j.hooks.PreToolUse;
  assert.match(evaluate('project_settings', 'x', JSON.stringify(j)), /PreToolUse/);
});
// ---- Allowlist OWNER (Opción A, 2026-11-06) ----
const CRITICAL_ALLOW = /\b(commit|push|merge|rebase|reset|clean|cherry-pick|checkout|stash|worktree (add|remove|prune)|ssh|scp|sftp|rsync|docker|alembic|vercel|gh|wsl|tailscale|cloudflared|sudo|curl|wget|rm|del|remove-item|invoke-expression|iex)\b|npm run \*|^(Read|Edit|Write|MultiEdit|NotebookEdit|WebFetch)\(|^mcp__/i;
test('allowlist OWNER: no contiene operaciones críticas, archivos ni MCP', () => {
  const allow = JSON.parse(tpl).permissions.allow;
  assert.ok(allow.length > 0);
  const bad = allow.filter((r) => CRITICAL_ALLOW.test(r));
  assert.deepEqual(bad, []);
  for (const r of allow) assert.match(r, /^(Bash|PowerShell)\([^()]+\)$/, `forma inesperada: ${r}`);
});
test('allowlist OWNER: sin duplicados ni solapamiento literal con ask/deny', () => {
  const p = JSON.parse(tpl).permissions;
  assert.equal(new Set(p.allow).size, p.allow.length);
  const crit = new Set([...p.ask, ...p.deny]);
  assert.deepEqual(p.allow.filter((r) => crit.has(r)), []);
});
test('allowlist OWNER: cada regla Bash tiene su par PowerShell', () => {
  const allow = JSON.parse(tpl).permissions.allow;
  const b = allow.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5));
  const ps = allow.filter((r) => r.startsWith('PowerShell(')).map((r) => r.slice(11));
  assert.deepEqual([...b].sort(), [...ps].sort());
});
test('config-guard: project con una regla allow fuera de la plantilla -> bloquea', () => {
  const j = JSON.parse(tpl); j.permissions.allow.push('Bash(git commit *)');
  assert.match(evaluate('project_settings', 'x', JSON.stringify(j)), /allow fuera de la plantilla/);
});
test('config-guard: project con allow genérico (Bash(*)) -> bloquea', () => {
  const j = JSON.parse(tpl); j.permissions.allow = ['Bash(*)'];
  assert.match(evaluate('project_settings', 'x', JSON.stringify(j)), /allow fuera de la plantilla/);
});
test('config-guard: project sin allowlist (más restrictivo) -> se acepta', () => {
  const j = JSON.parse(tpl); delete j.permissions.allow;
  assert.equal(evaluate('project_settings', 'x', JSON.stringify(j)), null);
});
test('config-guard: project que fija defaultMode -> bloquea', () => {
  for (const mode of ['acceptEdits', 'auto', 'dontAsk']) {
    const j = JSON.parse(tpl); j.permissions.defaultMode = mode;
    assert.match(evaluate('project_settings', 'x', JSON.stringify(j)), /defaultMode/, mode);
  }
});
const REPO = path.resolve(HOOKS, '..', '..');
test('settings.json efectivo idéntico a la plantilla', () => {
  const eff = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(eff, JSON.parse(tpl));
  assert.equal(evaluate('project_settings', 'x', JSON.stringify(eff)), null);
  assert.equal(eff.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(eff.disableAllHooks, false);
});
// AG-15: dos revisores de sólo lectura y dos implementers que además escriben con Edit/Write
// (acotados por D-7 a su worktree y alcance). Ninguno tiene Bash.
const IMPLEMENTERS = {
  'backend-implementer.md': ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  'frontend-implementer.md': ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
};
const REVIEWERS = ['code-reviewer.md', 'security-engineer.md'];
test('subagentes: revisores de sólo lectura e implementers sin Bash', () => {
  const dir = path.join(REPO, '.claude', 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), [...REVIEWERS, ...Object.keys(IMPLEMENTERS)].sort());
  for (const f of files) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split(/^---\s*$/m)[1] ?? '';
    const m = /^tools:\s*(.+)$/m.exec(head);
    assert.ok(m, `${f} sin línea tools`);
    const tools = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = IMPLEMENTERS[f] ?? ['Read', 'Grep', 'Glob'];
    assert.deepEqual(tools.filter((t) => !allowed.includes(t)), [], f);
  }
});
test('config-guard: project borrado -> bloquea', () => {
  assert.match(evaluate('project_settings', 'x', null), /elimin/);
});
test('config-guard: JSON inválido -> bloquea', () => {
  assert.match(evaluate('local_settings', 'x', '{'), /JSON/);
});
test('config-guard (proceso): exit 2 al poner disableAllHooks', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rivo-cfg-')), 'settings.local.json');
  fs.writeFileSync(f, '{"disableAllHooks":true}');
  const r = run(cfg, JSON.stringify({ hook_event_name: 'ConfigChange', source: 'local_settings', file_path: f }));
  assert.equal(r.status, 2);
});
test('config-guard (proceso): entrada ilegible -> exit 2', () => {
  const r = run(cfg, 'xx');
  assert.equal(r.status, 2);
});
